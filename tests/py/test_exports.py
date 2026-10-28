"""Checks the browser-side writers (web/js/export.js) by decoding their output independently.

Runs tests/js/export-test.html in headless Edge/Chrome, then reads the GDS, PNG and TIFF files it
produced with small readers below (and with KLayout's own reader when `klayout` is installed).
The lithography part covers µm units, per-layer GDS numbers, grid snapping, hole-free splitting,
structure cells placed as arrays, and the grating/lattice fills. Skipped when no browser is found."""
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


def gds_elements(data):
    """Every element as a dict: kind (BOUNDARY, SREF, AREF, TEXT), layer, datatype, xy, sname, colrow."""
    kinds = {0x08: 'BOUNDARY', 0x0A: 'SREF', 0x0B: 'AREF', 0x0C: 'TEXT'}
    out, el = [], None
    for rt, dt, body in gds_records(data):
        if rt in kinds:
            el = {'kind': kinds[rt]}
        elif el is None:
            continue
        elif rt == 0x0D:
            el['layer'] = struct.unpack('>h', body)[0]
        elif rt == 0x0E:
            el['datatype'] = struct.unpack('>h', body)[0]
        elif rt == 0x12:
            el['sname'] = body.rstrip(b'\0').decode()
        elif rt == 0x13:
            el['colrow'] = struct.unpack('>hh', body)
        elif rt == 0x10:
            el['xy'] = struct.unpack('>%di' % (len(body) // 4), body)
        elif rt == 0x11:
            out.append(el)
            el = None
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


def read_bmp(data):
    """Uncompressed BMP -> rows top-down, unpadded."""
    assert data[:2] == b'BM'
    off, = struct.unpack('<I', data[10:14])
    hsize, w, h, planes, bpp, comp = struct.unpack('<IiiHHI', data[14:34])
    ppm, = struct.unpack('<i', data[38:42])
    assert comp == 0 and h > 0
    ncol = (off - 54) // 4
    palette = [tuple(data[54 + i * 4:57 + i * 4][::-1]) for i in range(ncol)]
    stride = (w * bpp + 31) // 32 * 4
    used = (w * bpp + 7) // 8
    rows = [data[off + (h - 1 - j) * stride:off + (h - 1 - j) * stride + used] for j in range(h)]
    if bpp == 24:
        rows = [bytes(b for i in range(w) for b in (r[i * 3 + 2], r[i * 3 + 1], r[i * 3])) for r in rows]
    return {'w': w, 'h': h, 'bpp': bpp, 'ppm': ppm, 'palette': palette, 'rows': rows}


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

    def test_bmps(self):
        png = read_png(self.files['mask-L01.png'])
        m = read_bmp(self.files['mask-L01.bmp'])
        self.assertEqual((m['w'], m['h'], m['bpp']), (350, 200, 1))
        self.assertEqual(m['ppm'], round(100 / 0.0254))
        self.assertEqual(m['palette'], [(0, 0, 0), (255, 255, 255)])
        self.assertEqual(m['rows'], [bytes(r) for r in png['rows']])
        lab = read_bmp(self.files['label.bmp'])
        self.assertEqual(lab['bpp'], 8)
        self.assertEqual(lab['rows'], [bytes(r) for r in read_png(self.files['label.png'])['rows']])
        rgb = read_bmp(self.files['rgb.bmp'])
        self.assertEqual(rgb['bpp'], 24)
        self.assertEqual(rgb['rows'], [bytes(r) for r in read_png(self.files['rgb.png'])['rows']])

    # ---- lithography modes: µm units, per-layer numbers, split holes, grid, cells and arrays, fills

    def read_layout(self, name):
        try:
            import klayout.db as kdb
        except ImportError:
            self.skipTest('klayout Python module not installed (pip install klayout)')
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, name)
            with open(path, 'wb') as f:
                f.write(self.files[name])
            ly = kdb.Layout()
            ly.read(path)
        return kdb, ly

    def test_um_units(self):
        kdb, ly = self.read_layout('um.gds')
        box = ly.top_cell().dbbox()
        self.assertEqual((box.left, box.bottom, box.width(), box.height()), (0, 0, 100, 100))

    def test_split_matches_keyhole(self):
        kdb, ks = self.read_layout('litho-keyhole.gds')
        _, sp = self.read_layout('litho-split.gds')
        self.assertEqual(sorted((i.layer, i.datatype) for i in sp.layer_infos()), [(2, 0), (7, 3), (9, 0)])
        holes_in_keyhole = 0
        for ld in ((7, 3), (2, 0), (9, 0)):
            a = kdb.Region(ks.top_cell().begin_shapes_rec(ks.layer(*ld))).merged()
            b = kdb.Region(sp.top_cell().begin_shapes_rec(sp.layer(*ld))).merged()
            self.assertGreater(a.area(), 0)
            # trapezoid corners interpolated on slanted edges are rounded to 1 nm: a sliver along the outline
            self.assertAlmostEqual(b.area() / a.area(), 1, delta=1e-4, msg=str(ld))
            self.assertEqual(a.count(), b.count(), str(ld))
            for p in kdb.Region(sp.top_cell().begin_shapes_rec(sp.layer(*ld))).each():
                m = kdb.Region(p).merged()
                self.assertEqual((m.count(), sum(q.holes() for q in m.each())), (1, 0), 'split polygon has a hole: %s' % p)
            for p in kdb.Region(ks.top_cell().begin_shapes_rec(ks.layer(*ld))).each():
                holes_in_keyhole += sum(q.holes() for q in kdb.Region(p).merged().each())
        self.assertGreater(holes_in_keyhole, 0, 'the keyhole file should have holes once its slits are merged')
        # no zero-width slits: no edge is walked twice in opposite directions
        for el in gds_elements(self.files['litho-split.gds']):
            pts = list(zip(el['xy'][0::2], el['xy'][1::2]))
            edges = set(zip(pts, pts[1:]))
            self.assertFalse(any((b, a) in edges for a, b in edges))

    def test_gds_numbers_and_lyp(self):
        els = gds_elements(self.files['litho-split.gds'])
        self.assertEqual({(e['layer'], e['datatype']) for e in els}, {(7, 3), (2, 0), (9, 0)})
        self.assertEqual(len(read_gds(self.files['litho-split.gds'])['cells']), 1)
        text = self.files['litho.lyp'].decode()
        for src in ('7/3@1', '2/0@1', '9/0@1'):
            self.assertIn('<source>%s</source>' % src, text)
        self.assertIn('<name>07/3 holes</name>', text)
        self.assertIn('<source>1/1@1</source>', self.files['fill.lyp'].decode())

    def test_grid_snapping(self):
        els = gds_elements(self.files['litho-grid.gds'])
        self.assertTrue(any(e['kind'] == 'AREF' for e in els) and any(e['kind'] == 'SREF' for e in els))
        for e in els:
            self.assertTrue(all(v % 5 == 0 for v in e['xy']), e)
        kdb, ly = self.read_layout('litho-grid.gds')
        top = ly.top_cell()
        top.flatten(True)
        self.assertEqual(top.shapes(ly.layer(20, 0)).size(), 50 * 3 + 1)

    def test_rasters_with_tiny_pixels(self):
        b = read_bmp(self.files['tiny-10nm.bmp'])
        self.assertEqual((b['w'], b['h'], b['ppm']), (200, 100, 100000000))
        self.assertEqual(read_bmp(self.files['tiny-ppm.bmp'])['ppm'], 123456789)
        p = read_png(self.files['tiny-10nm.png'])
        self.assertEqual(p['ppm'], (100000000, 100000000))
        on = sum(bit(r, i) for r in p['rows'] for i in range(p['w']))
        self.assertEqual(on, 50 * 50)          # a 0.5 µm square at 10 nm pixels
        t = read_tiff(self.files['tiny-10nm.tif'])
        self.assertAlmostEqual(t['tags'][282][0], 2.54e6, delta=1)
        m = json.loads(self.files['tiny-manifest.json'])
        self.assertAlmostEqual(m['nanometresPerPixel'], 10)
        self.assertAlmostEqual(m['micrometresPerPixel'], 0.01)

    def test_fill_file(self):
        info = self.res['checks']['fillInfo']['detail']
        kdb, ly = self.read_layout('fill.gds')
        self.assertEqual(sorted(c.name for c in ly.each_cell()), ['FILL_TEST', 'PILLAR', 'PILLAR_B'])
        top = ly.top_cell()
        self.assertEqual(top.name, 'FILL_TEST')
        top.flatten(True)
        um2 = ly.dbu ** 2
        region = kdb.Region(top.shapes(ly.layer(100, 0))).merged()
        self.assertAlmostEqual(region.area() * um2, info['regionArea'], delta=0.1)   # vertices rounded to 1 nm
        pillars = kdb.Region(top.shapes(ly.layer(1, 1)))
        self.assertEqual(pillars.count(), info['pillars'])
        self.assertEqual((pillars - region).area(), 0)
        self.assertEqual(pillars.merged().count(), info['pillars'])       # no two pillars touch
        lines = kdb.Region(top.shapes(ly.layer(1, 0)))
        self.assertGreater(lines.count(), 100)
        self.assertEqual((lines - region).area(), 0)
        # with a 0.2 µm inset the lines stay at least that far from the region outline
        self.assertEqual((lines.sized(150) - region).area(), 0)
        self.assertGreater((lines.sized(250) - region).area(), 0)
        # blazed steps: 4 datatypes, disjoint, each about a quarter of the region
        steps = [kdb.Region(top.shapes(ly.layer(2, j))) for j in range(4)]
        total = kdb.Region()
        for j, s in enumerate(steps):
            self.assertAlmostEqual(s.area() * um2 / info['blazed'][j], 1, delta=1e-3)    # slanted strip corners on the 1 nm grid
            self.assertAlmostEqual(s.area() * um2 / info['regionArea'], 0.25, delta=0.02)
            total += s
        # disjoint up to rounding: neighbouring steps share slanted edges whose ends are rounded to 1 nm
        # separately, so they can overlap by about a nanometre along them (at most half the perimeter long)
        overlap = sum(s.area() for s in steps) - total.merged().area()
        self.assertLess(overlap, 0.5 * total.perimeter())
        self.assertEqual((total.sized(-1) - region).area(), 0)     # steps may touch the outline (no inset here)
        # angled lattice (15°, steps not whole nm): arrays are cut so every pillar sits within ~1 nm of its site
        angled = kdb.Region(top.shapes(ly.layer(5, 4)))
        self.assertEqual(angled.count(), info['angled'])
        c, s = math.cos(math.radians(15)), math.sin(math.radians(15))
        worst = 0
        for p in angled.each():
            ctr = p.bbox().center()
            x, y = ctr.x / 1000, 100 - ctr.y / 1000     # back to the y-down set frame, µm
            u, v = x * c + y * s, -x * s + y * c
            worst = max(worst, abs(u / 2 - round(u / 2)) * 2, abs(v / 2 - round(v / 2)) * 2)
        self.assertLess(worst * 1000, 2.0, 'nm off the lattice')
        self.assertEqual((angled - kdb.Region(kdb.Box(0, 60000, 40000, 100000))).area(), 0)

    def test_manifest(self):
        m = json.loads(self.files['manifest.json'])
        self.assertEqual(m['dpi'], 100)
        self.assertEqual([L['name'] for L in m['layers']], ['White', 'Blue'])


if __name__ == '__main__':
    unittest.main()
