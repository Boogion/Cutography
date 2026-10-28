"""Checks web/js/optics.js (structural colour physics) through tests/js/optics-test.html in headless Edge/Chrome."""
import json
import math
import unittest

from jsbrowser import find_browser, run_page


def hue_in(h, lo, hi):
    """Hue h (degrees) inside [lo, hi], where the range may wrap past 360."""
    h, lo, hi = h % 360, lo % 360, hi % 360
    return lo <= h <= hi if lo <= hi else (h >= lo or h <= hi)


@unittest.skipUnless(find_browser(), 'no headless Edge/Chrome available')
class Optics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = json.loads(run_page('tests/js/optics-test.html'))

    def test_ran(self):
        self.assertNotIn('error', self.r, self.r.get('error'))
        self.assertTrue(self.r.get('ALL_OK'))

    # ------------------------------------------------------------ colour science
    def test_white_and_black(self):
        c = self.r['color']
        for v in c['white']:
            self.assertAlmostEqual(v, 255, delta=2)
        self.assertEqual(c['black'], [0, 0, 0])
        self.assertLessEqual(max(c['grey18']) - min(c['grey18']), 1)       # flat spectrum stays neutral
        self.assertAlmostEqual(c['grey18'][1], 118, delta=3)               # 18 % grey -> sRGB ~118
        self.assertLess(c['half'][0], 255)

    def test_hex_helpers(self):
        c = self.r['color']
        self.assertEqual(c['hex'], '#ff8000')
        self.assertEqual(c['hexArr'], '#010203')
        self.assertEqual(c['hexBack'], [255, 128, 0])
        self.assertEqual(c['hexShort'], [255, 136, 0])
        self.assertIsNone(c['hexBad'])

    def test_monochromatic(self):
        mono = {m['l']: m['rgb'] for m in self.r['color']['mono']}
        b, g, r = mono[450], mono[530], mono[620]
        self.assertEqual(b.index(max(b)), 2, b)
        self.assertEqual(g.index(max(g)), 1, g)
        self.assertEqual(r.index(max(r)), 0, r)
        self.assertGreaterEqual(self.r['color']['monoMaxChannel'], 250)   # brightest spectral colour ~ full
        self.assertLess(max(mono[400]), 40)                               # violet edge is dim
        d = self.r['color']['monoDesat']
        self.assertLessEqual(max(d) - min(d), 1)
        dim = self.r['color']['monoDim']
        self.assertLess(dim[0], r[0])
        self.assertEqual(dim.index(max(dim)), 0)

    def test_gamut_clip_keeps_hue(self):
        c = self.r['color']
        self.assertEqual(c['boxRed'].index(max(c['boxRed'])), 0)
        self.assertEqual(c['boxGreen'].index(max(c['boxGreen'])), 1)
        x = c['clipped']                                 # fitGamut([1.4, 0.3, -0.2])
        self.assertTrue(all(0 <= v <= 1 + 1e-9 for v in x), x)
        self.assertTrue(x[0] > x[1] > x[2])              # channel order (hue) kept
        y_in = 0.2126 * 1.4 + 0.7152 * 0.3 + 0.0722 * -0.2
        y_out = 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]
        self.assertAlmostEqual(y_in, y_out, places=6)    # luminance kept

    def test_ciede2000(self):
        self.assertAlmostEqual(self.r['color']['sharma1'], 2.0425, places=4)

    # ------------------------------------------------------------ materials
    def test_materials(self):
        m = self.r['materials']['m']
        n = lambda name, i: m[name][i][0]          # index 0..3 = 400, 550, 633, 700 nm
        self.assertAlmostEqual(n('Si', 2), 3.88, delta=0.03)
        self.assertAlmostEqual(n('SiO2', 1), 1.460, delta=0.002)
        self.assertAlmostEqual(n('PMMA', 2), 1.489, delta=0.003)
        self.assertTrue(1.53 < n('ZEP520A', 2) < 1.56)
        self.assertTrue(1.39 < n('HSQ', 1) < 1.45)
        self.assertTrue(1.6 < n('ma-N 2400', 2) < 1.63)
        self.assertTrue(2.3 < n('TiO2', 1) < 2.5)
        self.assertGreater(n('TiO2', 0), n('TiO2', 3))          # normal dispersion
        self.assertEqual(m['man2400'], m['ma-N 2400'])
        self.assertEqual(m['Fused Silica'], m['fused silica'])
        self.assertEqual(m['thermal oxide'], m['SiO2'])
        self.assertEqual(m['air'][1], [1, 0])
        self.assertIn('unobtainium', self.r['materials']['unknown']['message'])
        self.assertEqual(self.r['materials']['constant'], {'n': 1.5, 'k': 0})
        for name in ('si', 'sio2', 'fused silica', 'pmma', 'zep520a', 'hsq', 'ma-n 2400', 'tio2', 'al', 'ag', 'au', 'cr', 'air'):
            self.assertIn(name, self.r['materials']['list'])

    def test_metal_reflectance(self):
        s = self.r['thinfilm']['metalSub']
        self.assertGreater(s['ag550'], 0.95)
        self.assertTrue(0.90 < s['al550'] < 0.94)
        self.assertGreater(s['au700'], 0.95)
        self.assertLess(s['au450'], 0.5)              # gold's interband absorption -> yellow
        self.assertTrue(0.5 < s['cr550'] < 0.65)

    # ------------------------------------------------------------ thin films
    def test_bare_silicon(self):
        t = self.r['thinfilm']
        self.assertTrue(0.35 <= t['bareSi550'] <= 0.40, t['bareSi550'])
        self.assertLess(t['bareSiHsv']['s'], 0.15)     # nearly neutral silver-grey
        self.assertAlmostEqual(t['bareGlass550'], 0.035, delta=0.002)

    def test_film_physics(self):
        t = self.r['thinfilm']
        self.assertAlmostEqual(t['halfWaveOnGlass'], t['glass600'], places=3)    # half-wave layer is absent
        self.assertTrue(540 <= t['minAt'][0] <= 600, t['minAt'])                  # quarter-wave minimum
        self.assertLess(t['minAt'][1], 0.15)
        self.assertEqual(t['pmma'][0][0], 50)
        self.assertEqual(len(t['pmma']), 6)
        self.assertEqual(t['paletteDefault'], 50)        # 10..500 nm in 10 nm steps
        for k in ('zepOnSi', 'hsqOnSi', 'manOnSi', 'tio2OnSi'):
            self.assertRegex(t[k]['hex'], r'^#[0-9a-f]{6}$')

    def test_oxide_chart(self):
        """SiO2 on Si against the hue families of the published chart (Henrie et al. 2004 / Pliskin)."""
        chart = {c['t']: c['hsv'] for c in self.r['thinfilm']['chart']}
        expect = {             # thickness: (hue range, chart colour name)
            120: ((200, 245), 'royal blue'),
            150: ((195, 230), 'light blue'),
            220: ((30, 65), 'gold'),
            270: ((260, 320), 'red-violet'),
            300: ((205, 245), 'blue / violet-blue'),
            350: ((140, 180), 'light green'),
            390: ((45, 80), 'yellow'),
            420: ((320, 15), 'carnation pink'),
            440: ((290, 330), 'violet-red'),
            480: ((230, 265), 'blue-violet'),
            520: ((150, 185), 'green'),
        }
        for t, ((lo, hi), name) in expect.items():
            self.assertTrue(hue_in(chart[t]['h'], lo, hi), f'{t} nm: hue {chart[t]["h"]} is not {name}')
            self.assertGreater(chart[t]['s'], 0.12, f'{t} nm should be visibly coloured')
        for t in (0, 10, 20):
            self.assertLess(chart[t]['s'], 0.15)        # bare-Si silver
        self.assertTrue(hue_in(chart[60]['h'], 0, 45))  # tan / brown

    # ------------------------------------------------------------ gratings
    def test_grating_equation(self):
        g = self.r['grating']
        m = g['matched']
        self.assertAlmostEqual(m['l'], g['expected'], delta=0.01)       # λ = d·sinθ = d·cos(elevation)
        self.assertAlmostEqual(m['l'], 700 * math.cos(math.radians(30)), delta=0.01)
        self.assertEqual(m['b'], 1)
        self.assertEqual(m['rgb'].index(max(m['rgb'])), 0)               # 606 nm -> red/orange
        self.assertTrue(m['fab']['ok'])
        self.assertAlmostEqual(g['opposite']['l'], g['expected'], delta=0.01)
        self.assertAlmostEqual(g['tilted']['l'], g['tilted']['expected'], delta=0.01)
        self.assertIsNone(g['tiltedFar']['l'])                             # 366 nm: not visible

    def test_grating_dark_along_lines(self):
        g = self.r['grating']
        self.assertIsNone(g['along']['l'])
        self.assertEqual(g['along']['b'], 0)
        self.assertEqual(g['along']['hex'], '#000000')
        off = [o['b'] for o in g['off']]
        self.assertEqual(off, sorted(off, reverse=True))                   # falls off with azimuth mismatch
        self.assertTrue(0.3 < g['off'][2]['b'] < 0.7)                      # ~half at 7°
        self.assertLess(g['off'][4]['b'], 0.01)                            # dark by 30°

    def test_grating_orders(self):
        g = self.r['grating']
        self.assertEqual(g['secondOrder']['duty05'][1][2], 0)             # even orders vanish at duty 0.5
        d3 = g['secondOrder']['duty03']
        self.assertAlmostEqual(d3[0][2], math.sin(0.3 * math.pi) ** 2, places=3)
        self.assertAlmostEqual(d3[1][2], math.sin(0.6 * math.pi) ** 2 / 4, places=3)
        self.assertAlmostEqual(d3[1][1], d3[0][1] / 2, places=3)
        self.assertIsNone(g['tooShort']['l'])                              # 300 nm period: 260 nm, UV

    def test_grating_inverse(self):
        g = self.r['grating']
        self.assertAlmostEqual(g['period620_30'], 620 / math.cos(math.radians(30)), delta=0.01)
        self.assertAlmostEqual(g['period620_30_m2'], 2 * g['period620_30'], delta=0.01)
        self.assertIsNone(g['straightDown'])
        for e in g['inv']:
            self.assertAlmostEqual(e['back'], e['l'], delta=0.01)

    def test_grating_palette(self):
        g = self.r['grating']
        pal = g['palette']
        self.assertEqual(len(pal), 12)
        periods = [e['p'] for e in pal]
        self.assertEqual(periods, sorted(periods))
        for e in pal:
            self.assertGreaterEqual(e['p'], 200)
            self.assertGreaterEqual(e['duty'] * e['p'], 100 - 1e-6)
            self.assertGreaterEqual((1 - e['duty']) * e['p'], 100 - 1e-6)
            self.assertTrue(440 - 1e-6 <= e['l'] <= 670 + 1e-6)
        self.assertTrue(hue_in(pal[0]['hsv']['h'], 230, 290), pal[0])     # starts blue/violet
        self.assertTrue(hue_in(pal[-1]['hsv']['h'], 330, 20), pal[-1])    # ends red
        self.assertTrue(any(hue_in(e['hsv']['h'], 100, 170) for e in pal)) # passes through green
        self.assertEqual(g['palSteepCount'], 0)                            # 85°: periods would exceed 2000 nm
        self.assertTrue(all(p >= 200 for p in g['palMin']))
        self.assertTrue(all(p >= 240 for p in g['palLittrow']))
        self.assertLess(len(g['palLittrow']), 12)                          # some cut by minPeriodNm
        self.assertIn('periodNm', g['badPeriod']['message'])

    # ------------------------------------------------------------ pillars
    def test_pillar_palettes_respect_fab(self):
        p = self.r['pillar']
        self.assertEqual(sorted(p['fams']), ['ag-disk', 'al-disk', 'au-disk', 'si-pillar', 'tio2-pillar'])
        for fam, entries in p['pal'].items():
            self.assertEqual(len(entries), 8, fam)
            res = [e['res'] for e in entries]
            self.assertEqual(res, sorted(res), fam)                        # bigger -> redder
            for e in entries:
                self.assertGreaterEqual(e['d'], 100 - 1e-6, fam)
                self.assertGreaterEqual(e['p'] - e['d'], 100 - 1e-6, fam)
                self.assertTrue(e['ok'], (fam, e))
                self.assertEqual(e['note'], 'estimate')
        for d, pitch in p['tight']:
            self.assertGreaterEqual(d, 80 - 1e-6)
            self.assertAlmostEqual(pitch - d, 60, places=6)
        for d, pitch in p['strict']:
            self.assertGreaterEqual(d, 120 - 1e-6)
            self.assertAlmostEqual(pitch - d, 150, places=6)
        self.assertEqual(p['heightClamp'], [500, 500])

    def test_pillar_estimates(self):
        p = self.r['pillar']
        self.assertEqual(p['one']['note'], 'estimate')
        self.assertTrue(p['one']['fab']['ok'])
        self.assertFalse(p['bad']['ok'])
        self.assertEqual(len(p['bad']['issues']), 3)
        self.assertEqual(p['alias'], 'tio2-pillar')
        self.assertIn('unobtainium', p['unknown']['message'])
        self.assertTrue(0 <= p['specMin'] <= p['specMax'] <= 1)
        self.assertIsNotNone(p['caveat']['tall'])
        self.assertIsNone(p['caveat']['thin'])
        al, au, si = p['pal']['al-disk'], p['pal']['au-disk'], p['pal']['si-pillar']
        self.assertTrue(hue_in(al[0]['hsv']['h'], 190, 250), al[0])       # Al: blue ...
        self.assertTrue(hue_in(al[-1]['hsv']['h'], 10, 60), al[-1])       # ... to warm
        self.assertTrue(all(hue_in(e['hsv']['h'], 340, 45) for e in au))  # Au: warm only
        self.assertTrue(all(e['mode'] == 'dip' for e in si))
        for fam, entries in p['heights'].items():
            self.assertEqual(len(entries), 6, fam)

    # ------------------------------------------------------------ libraries
    def test_example_library(self):
        c = self.r['csv']
        ex = c['example']
        self.assertGreaterEqual(len(ex), 8)
        self.assertTrue(all(e['measured'] for e in ex))
        fams = {e['family'] for e in ex}
        self.assertTrue({'grating', 'tio2-pillar', 'al-disk', 'thinfilm'} <= fams)
        g = ex[0]
        self.assertEqual(g['params'], {'periodNm': 520, 'heightNm': 120, 'angleDeg': 0, 'duty': 0.5})
        self.assertRegex(g['hex'], r'^#[0-9a-f]{6}$')
        self.assertEqual(c['exampleWarnings'], [])

    def test_csv_flexible_columns(self):
        c = self.r['csv']
        s = c['shuffled']
        self.assertEqual(len(s), 2)
        self.assertEqual(s[0], {'name': 'Grating, blue', 'family': 'grating', 'params': {'periodNm': 600, 'duty': 0.5}, 'hex': '#aabbcc'})
        self.assertEqual(s[1]['hex'], '#00ff00')
        self.assertEqual(s[1]['params'], {'periodNm': 700, 'duty': 0.4})
        self.assertIn('extra', c['shuffledWarnings'][0]['message'])
        r = c['rgbCols'][0]
        self.assertEqual(r['hex'], '#0ac81e')
        self.assertEqual(r['family'], 'tio2-pillar')
        self.assertEqual(r['params'], {'diameterNm': 150, 'pitchNm': 260, 'heightNm': 300})

    def test_csv_errors(self):
        c = self.r['csv']
        e = c['strictErr']
        self.assertEqual([x['line'] for x in e['errors']], [3, 4, 5, 6])
        self.assertIn('4 bad rows', e['message'])
        self.assertIn('period_nm "abc" is not a number', e['message'])
        self.assertIn('duty "1.4"', e['message'])
        self.assertIn('hex "#12345z"', e['message'])
        self.assertIn('greater than 0', e['message'])
        self.assertEqual(c['lenient']['n'], 1)
        self.assertEqual(len(c['lenient']['errors']), 4)
        self.assertIn('colour column', c['noColour']['message'])
        self.assertIn('empty', c['empty']['message'])
        self.assertIn('no rows', c['headerOnly']['message'])
        self.assertIn('line 2', c['missingRgb']['message'])
        self.assertIn('0 to 255', c['rgbRange']['message'])
        self.assertIn('smaller than diameter', c['pitchLess']['message'])
        self.assertIn('string', c['notString']['message'])
        self.assertIn('fab limits', c['fabWarn'][0]['message'])

    # ------------------------------------------------------------ nearest
    def test_nearest(self):
        n = self.r['nearest']
        names = {q['h']: q['name'] for q in n['q']}
        self.assertEqual(names['#3355dd'], 'G-blue')
        self.assertEqual(names['#dd4433'], 'G-red')
        self.assertEqual(names['#40b050'], 'G-green')
        self.assertEqual(n['exact'], 0)
        self.assertEqual(n['m76'], 'G-blue')
        self.assertIsNone(n['empty'])
        self.assertEqual(n['skipBad'], 1)
        self.assertEqual(n['oxide'], {'t': 230, 'de': 0})
        self.assertIn('blue', n['badHex']['message'])

    def test_fast(self):
        self.assertLess(self.r['timing']['ms'], 500)


if __name__ == '__main__':
    unittest.main()
