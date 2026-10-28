"""Checks the browser-side writers (web/js/export.js) by decoding their output independently.

Runs tests/js/export-test.html in headless Edge/Chrome, then reads the GDS, PNG and TIFF files it
produced with small readers below (and with KLayout's own reader when `klayout` is installed).
Skipped when no browser is found."""
import base64
import json
import math
import struct
import unittest
import zlib

from jsbrowser import find_browser, run_page

EXPECT_L1 = 4.125                   # in², see export-test.html
EXPECT_L2 = math.pi * 0.16
NM = 25.4e6


def gds_records(data):
    i = 0
    while i < len(data):
        n, rt, dt = struct.unpack('>HBB', data[i:i + 4])
        yield rt, dt, data[i + 4:i + n]
        i += n
        if rt == 0x04:
            return


def gds_real8(b):
    sign = -1 if b[0] & 0x80 else 1
    exp = (b[0] & 0x7f) - 64
    mant = int.from_bytes(b[1:8], 'big') / 2 ** 56
    return sign * mant * 16 ** exp


def read_gds(data):
    out = {'units': None, 'layers': {}, 'texts': [], 'cells': []}
    layer = None
    kind = None
    for rt, dt, body in gds_records(data):
        if rt == 0x03:
            out['units'] = (gds_real8(body[:8]), gds_real8(body[8:16]))
        elif rt == 0x06:
            out['cells'].append(body.rstrip(b'\0').decode())
        elif rt in (0x08, 0x0C):
            kind = rt
        elif rt == 0x0D:
            layer = struct.unpack('>h', body)[0]
        elif rt == 0x10:
            xy = struct.unpack('>%di' % (len(body) // 4), body)
            pts = list(zip(xy[0::2], xy[1::2]))
            if kind == 0x08:
                out['layers'].setdefault(layer, []).append(pts)
        elif rt == 0x19:
            out['texts'].append(body.rstrip(b'\0').decode())
    return out


def poly_area(pts):
    a = 0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        a += x0 * y1 - x1 * y0
    return a / 2


def png_chunks(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    i = 8
    while i < len(data):
        n = struct.unpack('>I', data[i:i + 4])[0]
        t = data[i + 4:i + 8].decode()
        body = data[i + 8:i + 8 + n]
        crc = struct.unpack('>I', data[i + 8 + n:i + 12 + n])[0]
        assert zlib.crc32(data[i + 4:i + 8 + n]) & 0xffffffff == crc, 'bad CRC in ' + t
        yield t, body
        i += 12 + n


def read_png(data):
    info = {'idat': b''}
    for t, body in png_chunks(data):
        if t == 'IHDR':
            w, h, depth, ct = struct.unpack('>IIBB', body[:10])
            info.update(w=w, h=h, depth=depth, ct=ct)
        elif t == 'IDAT':
            info['idat'] += body
        elif t == 'pHYs':
            info['ppm'] = struct.unpack('>II', body[:8])
        else:
            info[t] = body
    raw = zlib.decompress(info.pop('idat'))
    bpp_bits = info['depth'] * {0: 1, 2: 3, 3: 1, 6: 4}[info['ct']]
    stride = (info['w'] * bpp_bits + 7) // 8
    rows = []
    for j in range(info['h']):
        line = raw[j * (stride + 1):(j + 1) * (stride + 1)]
        assert line[0] == 0, 'expected filter 0'
        rows.append(line[1:])
    info['rows'] = rows
    return info


def unpackbits(data, n):
    out = bytearray()
    i = 0
    while len(out) < n:
        c = data[i]
        i += 1
        if c < 128:
            out += data[i:i + c + 1]
            i += c + 1
        elif c > 128:
            out += bytes([data[i]]) * (257 - c)
            i += 1
    return bytes(out), i


def read_tiff(data):
    assert data[:4] == b'II*\0'
    ifd = struct.unpack('<I', data[4:8])[0]
    n = struct.unpack('<H', data[ifd:ifd + 2])[0]
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8}
    tags = {}
    for k in range(n):
        tag, typ, cnt, val = struct.unpack('<HHI4s', data[ifd + 2 + k * 12:ifd + 14 + k * 12])
        size = sizes[typ] * cnt
        raw = val[:size] if size <= 4 else data[struct.unpack('<I', val)[0]:struct.unpack('<I', val)[0] + size]
        if typ == 3:
            v = list(struct.unpack('<%dH' % cnt, raw))
        elif typ == 4:
            v = list(struct.unpack('<%dI' % cnt, raw))
        elif typ == 5:
            a, b = struct.unpack('<II', raw[:8])
            v = [a / b]
        else:
            v = raw
        tags[tag] = v
    w, h, spp = tags[256][0], tags[257][0], tags[277][0]
    bps = tags[258][0]
    assert tags[259][0] == 32773
    row_bytes = (w * bps * spp + 7) // 8
    rows = []
    for off, cnt in zip(tags[273], tags[279]):
        strip = data[off:off + cnt]
        p = 0
        while p < len(strip):
            r, used = unpackbits(strip[p:], row_bytes)
            rows.append(r)
            p += used
    assert len(rows) == h, (len(rows), h)
    return {'w': w, 'h': h, 'tags': tags, 'rows': rows}


def bit(row, i):
    return (row[i >> 3] >> (7 - (i & 7))) & 1


@unittest.skipUnless(find_browser(), 'no headless Edge/Chrome available')
class ExportWriters(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        res = json.loads(run_page('tests/js/export-test.html'))
        cls.res = res
        cls.files = {k: base64.b64decode(v) for k, v in res['files'].items()}

    def test_in_page_checks(self):
        bad = {k: v for k, v in self.res['checks'].items() if not v['ok']}
        self.assertFalse(bad, json.dumps(bad, indent=1))

    def test_gds_structure_and_area(self):
        g = read_gds(self.files['test.gds'])
        self.assertAlmostEqual(g['units'][0], 1e-3, places=12)
        self.assertAlmostEqual(g['units'][1], 1e-9, places=18)
        self.assertEqual(sorted(g['layers']), [1, 2])
        a1 = sum(abs(poly_area(p)) for p in g['layers'][1]) / NM ** 2
        a2 = sum(abs(poly_area(p)) for p in g['layers'][2]) / NM ** 2
        self.assertAlmostEqual(a1, EXPECT_L1, places=6)
        self.assertAlmostEqual(a2, EXPECT_L2, delta=0.001)
        for polys in g['layers'].values():
            for p in polys:
                self.assertEqual(p[0], p[-1], 'GDS polygons must be closed')
                self.assertLessEqual(len(p), 8191)
        self.assertTrue(any('White' in t for t in g['texts']))

    def test_gds_in_klayout(self):
        try:
            import klayout.db as kdb
        except ImportError:
            self.skipTest('klayout Python module not installed (pip install klayout)')
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 't.gds')
            with open(path, 'wb') as f:
                f.write(self.files['test.gds'])
            ly = kdb.Layout()
            ly.read(path)
            self.assertAlmostEqual(ly.dbu, 0.001)
            top = ly.top_cell()
            for layer_no, expect in ((1, EXPECT_L1), (2, EXPECT_L2)):
                li = ly.layer(layer_no, 0)
                region = kdb.Region(top.begin_shapes_rec(li)).merged()
                area_in2 = region.area() * (ly.dbu * 1e-6) ** 2 / 0.0254 ** 2
                self.assertAlmostEqual(area_in2, expect, delta=0.001, msg='layer %d' % layer_no)
            # the hole and the island must survive as real geometry: 3 separate merged pieces on layer 1
            self.assertEqual(kdb.Region(top.begin_shapes_rec(ly.layer(1, 0))).merged().count(), 3)

    def test_lyp(self):
        text = self.files['test.lyp'].decode()
        self.assertIn('<source>1/0@1</source>', text)
        self.assertIn('#1f4fa3', text)

    def test_png_mask(self):
        p = read_png(self.files['mask-L01.png'])
        self.assertEqual((p['w'], p['h'], p['depth'], p['ct']), (350, 200, 1, 0))
        self.assertEqual(p['ppm'][0], round(100 / 0.0254))
        on = sum(bit(r, i) for r in p['rows'] for i in range(p['w']))
        self.assertAlmostEqual(on / 1e4, EXPECT_L1, delta=0.01)
        # spot checks: solid ring, hole, island, separate piece, its hole, background
        self.assertEqual(bit(p['rows'][25], 25), 1)
        self.assertEqual(bit(p['rows'][60], 60), 0)
        self.assertEqual(bit(p['rows'][100], 100), 1)
        self.assertEqual(bit(p['rows'][100], 300), 1)
        self.assertEqual(bit(p['rows'][70], 270), 0)
        self.assertEqual(bit(p['rows'][190], 220), 0)

    def test_png_mirror_and_invert(self):
        a = read_png(self.files['mask-L01.png'])
        m = read_png(self.files['mask-L01-mirror.png'])
        v = read_png(self.files['mask-L01-invert.png'])
        w = a['w']
        for j in (25, 70, 100):
            for i in (5, 60, 100, 270, 300):
                self.assertEqual(bit(a['rows'][j], i), bit(m['rows'][j], w - 1 - i))
                self.assertEqual(bit(a['rows'][j], i), 1 - bit(v['rows'][j], i))

    def test_png_cricut_indexed(self):
        p = read_png(self.files['cricut-L02.png'])
        self.assertEqual((p['depth'], p['ct']), (1, 3))
        self.assertEqual(p['PLTE'][3:6], bytes([0x1f, 0x4f, 0xa3]))
        self.assertEqual(p['tRNS'][0], 0)

    def test_png_label_and_rgb(self):
        lab = read_png(self.files['label.png'])
        rgb = read_png(self.files['rgb.png'])
        self.assertEqual(lab['rows'][100][100], 2)      # disc over the island
        self.assertEqual(lab['rows'][25][25], 1)
        self.assertEqual(lab['rows'][190][220], 0)
        self.assertEqual(rgb['rows'][100][300:303], bytes([0x1f, 0x4f, 0xa3]))
        self.assertEqual(rgb['rows'][25][75:78], bytes([247, 246, 242]))
        self.assertEqual(rgb['rows'][190][660:663], bytes([255, 255, 255]))

    def test_tiffs(self):
        b = read_tiff(self.files['mask-L01.tif'])
        self.assertEqual((b['w'], b['h']), (350, 200))
        self.assertAlmostEqual(b['tags'][282][0], 100)
        self.assertEqual(b['tags'][296][0], 2)
        on = sum(bit(r, i) for r in b['rows'] for i in range(b['w']))
        self.assertAlmostEqual(on / 1e4, EXPECT_L1, delta=0.01)
        png = read_png(self.files['mask-L01.png'])
        self.assertEqual(b['rows'], [bytes(r) for r in png['rows']])
        lab = read_tiff(self.files['label.tif'])
        self.assertEqual(lab['rows'][100][100], 2)
        rgb = read_tiff(self.files['rgb.tif'])
        self.assertEqual(rgb['tags'][262][0], 2)
        self.assertEqual(rgb['rows'][100][300:303], bytes([0x1f, 0x4f, 0xa3]))

    def test_manifest(self):
        m = json.loads(self.files['manifest.json'])
        self.assertEqual(m['dpi'], 100)
        self.assertEqual([L['name'] for L in m['layers']], ['White', 'Blue'])


if __name__ == '__main__':
    unittest.main()
