"""Checks web/js/engine.js (photo -> layers pipeline) through tests/js/engine-test.html in headless Edge/Chrome."""
import json
import math
import unittest

from jsbrowser import find_browser, run_page


@unittest.skipUnless(find_browser(), 'no headless Edge/Chrome available')
class Engine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = json.loads(run_page('tests/js/engine-test.html'))

    def test_ran(self):
        self.assertNotIn('error', self.r, self.r.get('error'))
        self.assertTrue(self.r.get('ALL_OK'))

    def test_tracing(self):
        self.assertEqual(self.r['square'], {'loops': 1, 'pts': 4, 'area': 16})
        ring = self.r['ring']
        self.assertEqual((ring['loops'], ring['pieces'], ring['holes']), (2, 1, 1))
        self.assertEqual(sorted(ring['areas']), [-4, 64])
        self.assertEqual(self.r['diagonal'], {'pieces': 2, 'holes': 0})
        self.assertTrue(self.r['random']['ok'], self.r['random'])

    def test_simplify_keeps_area(self):
        c = self.r['circle']
        self.assertLess(c['simpPts'], c['rawPts'])
        self.assertAlmostEqual(c['areaSimp'], c['areaRaw'], delta=c['areaRaw'] * 0.03)

    def test_color(self):
        c = self.r['color']
        self.assertEqual(c['back'], [200, 30, 80])
        self.assertAlmostEqual(c['sharma1'], 2.0425, places=4)   # Sharma et al. CIEDE2000 test pair 1
        self.assertLess(c['deSmall'], 0.5)

    def test_pipeline(self):
        p = self.r['pipeline']
        self.assertEqual(len(p['order']), 3)
        self.assertEqual(sorted(p['stackedCoverage'], reverse=True), p['stackedCoverage'])
        self.assertAlmostEqual(sum(p['inlayCoverage']), p['stackedCoverage'][0], delta=0.1)
        self.assertTrue(p['svgHead'].startswith('<?xml'))
        self.assertTrue(all(pc[0] >= 1 for pc in p['pieces']))

    def test_morphology(self):
        m = self.r['morph']
        self.assertAlmostEqual(m['discPx'], m['expect'], delta=m['expect'] * 0.05)
        self.assertEqual(m['erodeCount'], m['expectErode'])
        self.assertTrue(m['squareIsLines'])
        self.assertTrue(m['circleHasCurves'])

    def test_flatten_matches_svg_curves(self):
        f = self.r['flatten']
        self.assertEqual(f['start'], f['circStart'])
        self.assertTrue(f['linesSame'])
        self.assertAlmostEqual(f['areaFlat'], f['areaSvg'], delta=f['areaSvg'] * 0.005)
        self.assertGreater(f['flatPts'], 30)


if __name__ == '__main__':
    unittest.main()
