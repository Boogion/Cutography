"""Process logic and lithography exports (web/js/fab.js, web/js/fab-export.js), via tests/js/fab-test.html.

The page computes recipe checks, levels, palettes and a rule check, and writes grayscale and
structural-color files; here they are checked, the GDS with KLayout when it is installed."""
import base64
import json
import os
import struct
import tempfile
import unittest

from jsbrowser import find_browser, run_page


def read_bmp8(data):
    off, = struct.unpack('<I', data[10:14])
    w, h = struct.unpack('<ii', data[18:26])
    bpp, = struct.unpack('<H', data[28:30])
    ppm, = struct.unpack('<i', data[38:42])
    stride = (w * bpp + 31) // 32 * 4
    rows = [data[off + (h - 1 - j) * stride: off + (h - 1 - j) * stride + w] for j in range(h)]
    return w, h, bpp, ppm, rows


@unittest.skipUnless(find_browser(), 'no headless Edge/Chrome available')
class Fab(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = json.loads(run_page('tests/js/fab-test.html'))
        cls.r = out['R']
        cls.files = {k: base64.b64decode(v) for k, v in out['files'].items()}

    def test_ran(self):
        self.assertNotIn('error', self.r, self.r.get('error'))

    def test_recipe_checks(self):
        r = self.r
        self.assertTrue(r['default']['ok'], r['default']['errors'])
        self.assertFalse(r['tooFine']['ok'])
        self.assertIn('8', r['tooFine']['errors'][0])           # offers 8 levels instead
        self.assertTrue(r['fineOk']['ok'], r['fineOk']['errors'])   # 8 levels over 70 nm = exactly 10 nm apart
        self.assertFalse(r['liftoffGray']['ok'])
        self.assertFalse(r['thickResist']['ok'])
        self.assertFalse(r['etchSel']['ok'])
        self.assertFalse(r['wrongFamily']['ok'])
        self.assertTrue(any('aspect' in w for w in r['aspect']['warnings']))
        self.assertNotEqual(r['meaningPos'], r['meaningNeg'])
        self.assertIn('TiO', r['meaningTiO2'])

    def test_levels_and_doses(self):
        lv = self.r['levels']
        self.assertEqual(len(lv), 8)
        self.assertAlmostEqual(lv[0]['h'], 10)
        self.assertAlmostEqual(lv[-1]['h'], 500)
        self.assertEqual([x['dc'] for x in lv], list(range(7, -1, -1)))     # positive resist: tall = least dose
        by_dc = sorted(lv, key=lambda x: x['dc'])
        self.assertEqual([x['dose'] for x in by_dc], sorted(x['dose'] for x in lv))
        self.assertAlmostEqual(by_dc[0]['dose'], 0)                       # tallest level, resist = full thickness
        neg = self.r['levelsNeg']
        self.assertEqual([x['dc'] for x in neg], list(range(8)))           # negative resist: tall = most dose
        self.assertEqual(self.r['contrast'], sorted(self.r['contrast'], reverse=True))   # tall needs less dose
        self.assertIn('two lines', self.r['badContrast'])
        self.assertEqual(len(self.r['doseCsv'].strip().split('\n')), 9)

    def test_palettes(self):
        g = self.r['paletteGray']
        self.assertEqual([x[2] for x in g], list(range(8)))
        for period, width, _ in self.r['paletteGrating']:
            self.assertGreaterEqual(period, 200)
            self.assertGreaterEqual(width, 100)
            self.assertLessEqual(width, period - 100)
        for dia, pitch in self.r['palettePillar']:
            self.assertGreaterEqual(dia, 100)
            self.assertGreaterEqual(pitch, dia + 100)
        self.assertEqual(self.r['recipeJson']['recipe']['mode'], 'grayscale')

    def test_rule_check(self):
        kinds = self.r['rules']['kinds']
        self.assertIn('thin:thin', kinds)
        self.assertIn('corner:corner', kinds)
        self.assertFalse([k for k in kinds if k.startswith('ok:')], kinds)

    def test_grayscale_bmp(self):
        name = [k for k in self.files if k.endswith('.bmp')][0]
        w, h, bpp, ppm, rows = read_bmp8(self.files[name])
        self.assertEqual((w, h, bpp, ppm), (300, 100, 8, 10_000_000))
        self.assertEqual(rows[50][50], 8)      # level 0 = dose class 7 -> value 8
        self.assertEqual(rows[50][110], 5)     # level 3 = dose class 4
        self.assertEqual(rows[50][150], 1)     # island at level 7 = dose class 0
        self.assertEqual(rows[50][250], 1)
        meta = json.loads(self.files[name.replace('.bmp', '-bmp.json')])
        self.assertEqual(meta['valueTable'][0]['doseClass'], None)

    def _klayout(self):
        try:
            import klayout.db as kdb
            return kdb
        except ImportError:
            self.skipTest('klayout Python module not installed (pip install klayout)')

    def _read(self, kdb, data):
        d = tempfile.mkdtemp()
        p = os.path.join(d, 't.gds')
        with open(p, 'wb') as f:
            f.write(data)
        ly = kdb.Layout()
        ly.read(p)
        return ly

    def _areas(self, kdb, ly):
        top, out = ly.top_cell(), {}
        for li in ly.layer_indexes():
            info = ly.get_info(li)
            reg = kdb.Region(top.begin_shapes_rec(li))
            out[(info.layer, info.datatype)] = (reg.merged().area() * ly.dbu ** 2, reg)
        return out

    def test_grayscale_gds(self):
        kdb = self._klayout()
        want = {(1, 7): 100.0, (1, 4): 84.0, (1, 0): 116.0}    # µm²
        for name in ('ebl/gray-test-keyhole.gds', 'ebl/gray-test-split.gds'):
            ly = self._read(kdb, self.files[name])
            areas = self._areas(kdb, ly)
            self.assertEqual(set(areas), set(want), name)
            for k, a in want.items():
                self.assertAlmostEqual(areas[k][0], a, delta=0.01, msg=f'{name} {k}')
            if 'split' in name:
                for k, (_, reg) in areas.items():
                    for poly in reg.each():
                        self.assertEqual(poly.holes(), 0, f'{name} {k} has a hole')
            # 5 nm writing grid
            for k, (_, reg) in areas.items():
                for poly in reg.each():
                    for pt in poly.each_point_hull():
                        self.assertEqual((pt.x % 5, pt.y % 5), (0, 0))
        ly = self._read(kdb, self.files['layer-ebl/gray-test.gds'])
        self.assertEqual(set(self._areas(kdb, ly)), {(8, 0), (5, 0), (1, 0)})

    def test_structure_gds(self):
        kdb = self._klayout()
        name = [k for k in self.files if k.endswith('-filled.gds')][0]
        ly = self._read(kdb, self.files[name])
        ly.top_cell().flatten(True)
        areas = self._areas(kdb, ly)
        self.assertIn((100, 0), areas)
        self.assertIn((101, 0), areas)
        lines = areas[(1, 0)][0]
        # duty 0.5 of a 100 µm² region, less what keeps whole lines (plus half the minimum gap) inside:
        # the line lying on the region's bottom edge is dropped and every line is shortened 50 nm at each end
        self.assertTrue(45.0 <= lines <= 50.0, lines)
        pillars = kdb.Region(ly.top_cell().begin_shapes_rec(ly.layer(1, 1)))
        n = pillars.count()
        self.assertTrue(500 <= n <= 650, n)
        csv = self.files[name.replace('-filled.gds', '-structures.csv')].decode().strip().split('\n')
        self.assertEqual(int(csv[2].split(',')[12]), n)


if __name__ == '__main__':
    unittest.main()
