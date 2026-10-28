"""End to end: the real app serves the real pages, headless Edge/Chrome builds layers from the first
example photo and from every map site, and every exporter runs on the result (tests/js/smoke.html).
The GDS files are then read back with KLayout when it is installed. Skipped without a browser."""
import base64
import json
import os
import tempfile
import threading
import unittest

import support  # noqa: F401
from jsbrowser import find_browser, run_page
from cutography import server

EXAMPLES = {'san-francisco', 'rome', 'sydney'}


@unittest.skipUnless(find_browser(), 'no headless Edge/Chrome available')
class Smoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='cutography-smoke-')
        cls.env = {k: os.environ.get(k) for k in ('CUTOGRAPHY_HOME', 'CUTOGRAPHY_NO_OPEN')}
        os.environ['CUTOGRAPHY_HOME'] = cls.tmp.name
        os.environ['CUTOGRAPHY_NO_OPEN'] = '1'
        cls.httpd = server.make_server(0, fallback=False)
        threading.Thread(target=cls.httpd.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True).start()
        url = 'http://127.0.0.1:%d/tests/js/smoke.html' % cls.httpd.server_address[1]
        cls.r = json.loads(run_page(url, timeout=900))

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for k, v in cls.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        cls.tmp.cleanup()

    def test_no_errors(self):
        self.assertEqual(self.r['errors'], [])

    def test_photo(self):
        p = self.r['photo']
        self.assertEqual(p['image'], 'sunflower')
        self.assertGreaterEqual(p['layers'], 2)
        self.assertEqual(len(p['set']['layers']), p['layers'])
        self.assertGreater(p['pngBytes'], 1000)
        self.assertGreater(p['tiffBytes'], 1000)
        # stacked sheets: each mask covers at least as much as the one above it
        areas = p['maskIn2']
        self.assertEqual(areas, sorted(areas, reverse=True))

    def test_save_everything(self):
        out = os.path.join(self.tmp.name, 'output', 'sunflower')
        files = sorted(os.path.relpath(os.path.join(d, f), out).replace(os.sep, '/') for d, _, fs in os.walk(out) for f in fs)
        n = self.r['photo']['layers']
        for want in ('cricut/sunflower-cricut.svg', 'cricut/sunflower-print-then-cut.png', 'cricut/cut-sheet.txt',
                     'gds/sunflower.gds', 'gds/sunflower.lyp', 'images/300dpi/scale.json', 'images/300dpi/sunflower-color.png',
                     'images/300dpi/sunflower-labels.png', 'sunflower-project.json'):
            self.assertIn(want, files)
        self.assertEqual(len([f for f in files if f.startswith('cricut/png/')]), n)
        self.assertEqual(len([f for f in files if f.startswith('cricut/layers/')]), n)
        self.assertEqual(len([f for f in files if f.endswith('-mask.png')]), n)
        with open(os.path.join(out, 'images', '300dpi', 'scale.json'), encoding='utf-8') as f:
            scale = json.load(f)
        self.assertEqual(scale['dpi'], 300)
        self.assertEqual(len(scale['layers']), n)
        self.assertIn('Saved', self.r['photo']['saved'])

    def test_maps(self):
        maps = self.r['maps']
        self.assertTrue(EXAMPLES <= set(maps), sorted(maps))
        for sid, m in maps.items():
            with self.subTest(site=sid):
                self.assertTrue(m['mat'], 'every layer should fit the Cricut mat')
                self.assertGreaterEqual(len(m['sheets']), 4)
                self.assertGreater(m['eMax'], m['eMin'])
                names = [L['name'] for L in m['set']['layers']]
                self.assertEqual(names[0], 'Streets and grid marks')
        self.assertTrue(maps['sydney']['stats']['sea'], 'Sydney Harbour should be water')
        self.assertTrue(maps['sydney']['water'])

    def test_lithography_modes(self):
        L = self.r['litho']
        self.assertEqual(set(L), {'photoGray', 'photoColor', 'mapGray'})
        for key, r in L.items():
            with self.subTest(run=key):
                self.assertEqual(r['check'], [], 'the default recipe should be valid')
                self.assertEqual(r['unitNm'], 1000)
                self.assertGreaterEqual(r['regions'], 2)
                self.assertTrue(any(p.endswith('.gds') for p in r['files']))
                self.assertTrue(any(p.endswith('recipe.json') for p in r['files']))
        self.assertTrue(all(k == 'level' for k in L['photoGray']['structures']))
        self.assertTrue(any(p.endswith('.bmp') for p in L['photoGray']['files']))
        self.assertTrue(any(p.endswith('dose-table.csv') for p in L['mapGray']['files']))
        self.assertGreater(L['photoColor']['placed'], 1000)
        # the map field is a disc of the default 500 µm diameter
        b = L['mapGray']['bounds']
        self.assertAlmostEqual(b[2] - b[0], 500, delta=1)

    def test_lithography_gds_in_klayout(self):
        try:
            import klayout.db as kdb
        except ImportError:
            self.skipTest('klayout Python module not installed (pip install klayout)')
        for key, r in self.r['litho'].items():
            gds = [p for p in r['files'] if p.endswith('.gds')][0]
            path = os.path.join(self.tmp.name, key + '.gds')
            with open(path, 'wb') as f:
                f.write(base64.b64decode(r['files'][gds]))
            ly = kdb.Layout()
            ly.read(path)
            top = ly.top_cell()
            top.flatten(True)
            total = sum(kdb.Region(top.begin_shapes_rec(li)).merged().area() for li in ly.layer_indexes()) * ly.dbu ** 2
            self.assertGreater(total, 1000, key)     # µm²: real geometry, not an empty file

    def test_gds_matches_masks(self):
        try:
            import klayout.db as kdb
        except ImportError:
            self.skipTest('klayout Python module not installed (pip install klayout)')
        runs = [('photo', self.r['photo'])] + sorted(self.r['maps'].items())
        for name, run in runs:
            with self.subTest(run=name):
                path = os.path.join(self.tmp.name, name + '.gds')
                with open(path, 'wb') as f:
                    f.write(base64.b64decode(run['gds']))
                ly = kdb.Layout()
                ly.read(path)
                top = ly.top_cell()
                for i, mask_in2 in enumerate(run['maskIn2']):
                    region = kdb.Region(top.begin_shapes_rec(ly.layer(i + 1, 0))).merged()
                    gds_in2 = region.area() * (ly.dbu / 25400.0) ** 2
                    # polygons vs a 150 dpi rendering of the same polygons: edge pixels differ a little
                    self.assertAlmostEqual(gds_in2, mask_in2, delta=max(0.05, mask_in2 * 0.02), msg='%s layer %d' % (name, i + 1))


if __name__ == '__main__':
    unittest.main()
