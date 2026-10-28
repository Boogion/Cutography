"""sitefetch on canned Overpass JSON (tests/py/fixtures/overpass-small.json, made by
make_fixtures.py): no network."""
import json
import math
import unittest

import support
from cutography import geom, osm, sitefetch, terrain

LAT, LON = 10.0, 20.0


def load_fixture():
    with open(support.fixture("overpass-small.json"), encoding="utf-8") as f:
        return json.load(f)


def features(diameter_m=1000):
    frame = sitefetch.Frame(LAT, LON, diameter_m)
    return sitefetch.osm_features(load_fixture(), frame, diameter_m)


def by_name(items, name):
    return [it for it in items if it["name"] == name]


class Transform(unittest.TestCase):
    def test_frame(self):
        f = sitefetch.Frame(LAT, LON, 1000)
        self.assertAlmostEqual(f.kx, 111320 * math.cos(math.radians(10)))
        self.assertEqual(f.ky, 110950)
        self.assertAlmostEqual(f.half, 550)
        x, y = f.xy(LAT - 100 / 110950.0, LON + 50 / f.kx)    # 100 m south, 50 m east
        self.assertAlmostEqual(x, 50, places=6)
        self.assertAlmostEqual(y, 100, places=6)
        self.assertAlmostEqual((f.lat1 - f.lat0) * f.ky, 1100, places=6)
        self.assertAlmostEqual((f.lon1 - f.lon0) * f.kx, 1100, places=6)


class Features(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.buildings, cls.roads, cls.water = features(1000)

    def test_road_merged_transformed_and_clipped(self):
        main = by_name(self.roads, "Main Street")
        # two OSM ways with different refs are not merged; the first is clipped at x = -550
        self.assertEqual(len(main), 2)
        a = [r for r in main if "ref" not in r][0]
        b = [r for r in main if r.get("ref") == "A1"][0]
        self.assertEqual(a["pts"], [[-550.0, 0.0], [-100.0, 0.0]])
        self.assertEqual(b["pts"], [[-100.0, 0.0], [300.0, 0.0], [550.0, 0.0]])
        self.assertEqual(a["kind"], "primary")
        self.assertFalse(a["tunnel"])

    def test_zigzag_clipped_into_three_pieces(self):
        z = by_name(self.roads, "Zigzag Lane")
        self.assertEqual(len(z), 3)
        self.assertEqual(z[0]["pts"], [[-300.0, 500.0], [-250.0, 550.0]])
        self.assertEqual(z[1]["pts"], [[-150.0, 550.0], [-100.0, 500.0], [-50.0, 550.0]])
        self.assertEqual(z[2]["pts"], [[50.0, 550.0], [100.0, 500.0]])

    def test_road_filters(self):
        self.assertEqual(by_name(self.roads, "Back Alley"), [])       # service never
        tube = by_name(self.roads, "Tube")
        self.assertEqual(len(tube), 1)
        self.assertTrue(tube[0]["tunnel"])
        self.assertEqual(tube[0]["pts"], [[0.0, -100.0], [0.0, -200.0]])

    def test_multipolygon_assembly(self):
        lake = by_name(self.water, "Test Lake")
        outer = [w for w in lake if w["role"] == "outer"]
        inner = [w for w in lake if w["role"] == "inner"]
        self.assertEqual((len(outer), len(inner)), (1, 1))
        o = outer[0]
        self.assertTrue(o["closed"])
        self.assertEqual(o["kind"], "water")
        self.assertEqual(len(o["pts"]), 4)                            # open ring
        self.assertNotEqual(o["pts"][0], o["pts"][-1])
        self.assertEqual(sorted(map(tuple, o["pts"])),
                         sorted([(-400.0, -400.0), (-200.0, -400.0), (-200.0, -200.0), (-400.0, -200.0)]))
        self.assertAlmostEqual(geom.area(o["pts"]), 40000, delta=1)
        self.assertAlmostEqual(geom.area(inner[0]["pts"]), 1600, delta=1)

    def test_assemble_rings_unit(self):
        rings, unclosed = osm.assemble_rings([[1, 2], [3, 2], [3, 4, 1], [7, 8]])
        self.assertEqual(len(rings), 1)
        self.assertEqual(rings[0][0], rings[0][-1])
        self.assertEqual(sorted(set(rings[0])), [1, 2, 3, 4])
        self.assertEqual(unclosed, [[7, 8]])

    def test_polygon_clipped(self):
        pond = by_name(self.water, "Edge Pond")[0]
        xs = [p[0] for p in pond["pts"]]
        self.assertEqual(max(xs), 550.0)
        self.assertAlmostEqual(geom.area(pond["pts"]), 150 * 100, delta=1)

    def test_stream(self):
        brook = by_name(self.water, "Brook")[0]
        self.assertFalse(brook["closed"])
        self.assertEqual(brook["kind"], "stream")
        self.assertEqual(brook["pts"][0], [0.0, 300.0])

    def test_buildings(self):
        names = [b["name"] for b in self.buildings]
        self.assertNotIn("A House", names)        # building=house skipped
        self.assertNotIn("Far Away", names)       # centroid outside the box
        self.assertIn("", names)                  # unnamed kept at <= 1.5 km
        self.assertIn("Courtyard Block", names)   # multipolygon outer ring
        areas = [b["area"] for b in self.buildings]
        self.assertEqual(areas, sorted(areas, reverse=True))
        hall = by_name(self.buildings, "Big Hall")[0]
        self.assertAlmostEqual(hall["area"], 4000, delta=10)   # corners rounded to 0.1 m
        self.assertEqual(len(hall["pts"]), 4)
        for b in self.buildings:
            self.assertNotEqual(b["pts"][0], b["pts"][-1])

    def test_main_shapes(self):
        shapes = sitefetch.main_shapes(self.buildings)
        self.assertEqual([s["name"] for s in shapes], ["Big Hall", "Courtyard Block", "", "Small Shop"])
        self.assertEqual([s["i"] for s in shapes], [0, 1, 2, 3])
        hall = shapes[0]
        self.assertEqual(hall["type"], "rect")
        self.assertAlmostEqual(hall["len"], 100, delta=0.2)
        self.assertAlmostEqual(hall["wid"], 40, delta=0.2)
        self.assertAlmostEqual(hall["ang"], 30, delta=0.2)
        self.assertAlmostEqual(hall["c"][0], 200, delta=0.2)
        self.assertAlmostEqual(hall["c"][1], 200, delta=0.2)

    def test_top_60(self):
        bs = [{"name": str(i), "area": i, "pts": [[0, 0], [i + 1, 0], [i + 1, 1]]} for i in range(100)]
        bs.sort(key=lambda b: -b["area"])
        shapes = sitefetch.main_shapes(bs)
        self.assertEqual(len(shapes), 60)
        self.assertEqual(shapes[0]["area"], 99)

    def test_larger_diameter_filters(self):
        buildings, roads, water = features(5000)
        self.assertNotIn("", [b["name"] for b in buildings])        # only named
        self.assertEqual(by_name(roads, "Zigzag Lane"), [])          # no residential above 3 km


class Merge(unittest.TestCase):
    def test_merge_chains(self):
        self.assertEqual(osm.merge_chains([[1, 2, 3], [3, 4], [5, 4], [5, 6]]), [[1, 2, 3, 4, 5, 6]])
        # a junction of three ways is left alone
        self.assertEqual(len(osm.merge_chains([[1, 2], [2, 3], [2, 4]])), 3)

    def test_clip_polyline_inside(self):
        self.assertEqual(geom.clip_polyline([(0, 0), (1, 1)], -5, -5, 5, 5), [[(0, 0), (1, 1)]])
        self.assertEqual(geom.clip_polyline([(10, 10), (20, 20)], -5, -5, 5, 5), [])


class BuildSite(unittest.TestCase):
    def test_offline_build(self):
        tiles = terrain.TileSource(lambda z, x, y: support.terrarium_tile_png(lambda c, r: 100.0 - r * 0.01))
        calls = []

        def overpass(query, msg):
            calls.append(query)
            msg("Downloading (fake)")
            return load_fixture(), "https://example.invalid/api/interpreter"
        progress = []
        site = sitefetch.build_site("Test Town", LAT, LON, 1000, progress=lambda f, m: progress.append((f, m)),
                                    tiles=tiles, overpass=overpass, created_at="2026-01-01T00:00:00Z")
        self.assertEqual(site["schema"], 1)
        self.assertEqual(site["id"], "test-town")
        self.assertEqual(site["diameterM"], 1000)
        dem = site["dem"]
        self.assertEqual((dem["rows"], dem["cols"]), (160, 160))
        self.assertEqual(len(dem["elev"]), 160 * 160)
        self.assertLess(dem["lat0"], dem["lat1"])
        self.assertLess(dem["lon0"], dem["lon1"])
        self.assertTrue(all(abs(e - 100) < 3 for e in dem["elev"]))
        self.assertIn("OpenStreetMap", site["attribution"])
        self.assertIn("U.S. Geological Survey", site["attribution"])
        self.assertEqual(site["sources"]["osm"]["dataTimestamp"], "2026-01-01T00:00:00Z")
        self.assertIn('way["building"]["building"!~', calls[0])
        self.assertIn("[timeout:180]", calls[0])
        self.assertEqual(progress[-1][0], 1.0)
        fs = [f for f, _ in progress]
        self.assertEqual(fs, sorted(fs))
        # JSON round trip, compact
        text = sitefetch.dumps(site)
        self.assertNotIn(", ", text[:200])
        self.assertEqual(json.loads(text)["mainShapes"][0]["name"], "Big Hall")


class Query(unittest.TestCase):
    def test_road_kinds(self):
        self.assertIn("tertiary", osm.road_kinds(12000))
        self.assertNotIn("tertiary", osm.road_kinds(12001))
        self.assertIn("residential", osm.road_kinds(3000))
        self.assertNotIn("residential", osm.road_kinds(3001))
        for d in (200, 30000):
            self.assertNotIn("service", osm.road_kinds(d))
            self.assertIn("motorway_link", osm.road_kinds(d))

    def test_query_shape(self):
        q = osm.build_query(1, 2, 3, 4, 10000)
        self.assertTrue(q.startswith("[out:json][timeout:180];"))
        self.assertIn('relation["type"="multipolygon"]["natural"="water"]', q)
        self.assertIn('["name"]', q)
        self.assertNotIn("coastline", q)

    def test_fetch_falls_back(self):
        from cutography import net
        seen = []

        def request(url, data=None, timeout=None, headers=None):
            seen.append(url)
            if "first" in url:
                raise net.HttpError("HTTP 504 from first", 504)
            if "second" in url:
                return b'{"remark": "runtime error: Query timed out", "elements": []}'
            return b'{"elements": [], "osm3s": {}}'
        import os
        old = os.environ.get("CUTOGRAPHY_OVERPASS")
        os.environ["CUTOGRAPHY_OVERPASS"] = "https://first/x,https://second/x,https://third/x"
        osm._last_good[0] = None
        try:
            msgs = []
            data, mirror = osm.fetch("q", msgs.append, request=request, sleep=lambda s: None)
            self.assertEqual(mirror, "https://third/x")
            self.assertEqual(len(seen), 3)
            self.assertTrue(any("didn't deliver" in m for m in msgs))
            # the good mirror is tried first next time
            self.assertEqual(osm.mirrors()[0], "https://third/x")
            # everything failing -> OverpassError after all rounds
            with self.assertRaises(osm.OverpassError):
                osm.fetch("q", None, request=lambda *a, **k: (_ for _ in ()).throw(net.HttpError("down", 502)),
                          sleep=lambda s: None)
        finally:
            osm._last_good[0] = None
            if old is None:
                del os.environ["CUTOGRAPHY_OVERPASS"]
            else:
                os.environ["CUTOGRAPHY_OVERPASS"] = old


class Inputs(unittest.TestCase):
    def test_diameter(self):
        self.assertEqual(sitefetch.diameter_metres(5, "km"), 5000)
        self.assertAlmostEqual(sitefetch.diameter_metres(1, "mi"), 1609.344)
        self.assertEqual(sitefetch.diameter_metres("0.2", "km"), 200)
        for bad in (0.1, 31, "x", None, float("nan")):
            with self.assertRaises(sitefetch.SiteError):
                sitefetch.diameter_metres(bad, "km")
        with self.assertRaises(sitefetch.SiteError):
            sitefetch.diameter_metres(20, "mi")
        with self.assertRaises(sitefetch.SiteError):
            sitefetch.diameter_metres(5, "furlongs")

    def test_slug(self):
        self.assertEqual(sitefetch.slugify("San Francisco"), "san-francisco")
        self.assertEqual(sitefetch.slugify("Zürich – Altstadt!"), "zurich-altstadt")
        self.assertEqual(sitefetch.slugify("東京"), "site")
        self.assertEqual(sitefetch.unique_id("rome", {"rome", "rome-2"}), "rome-3")


if __name__ == "__main__":
    unittest.main()
