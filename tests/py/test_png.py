import random
import unittest

import support
from paperstrata import terrain


def random_pixels(w, h, ch, seed):
    rnd = random.Random(seed)
    # smooth-ish gradients plus noise exercise every predictor
    return bytearray(((x * 7 + y * 13 + c * 50) + rnd.randint(0, 40)) & 0xFF
                     for y in range(h) for x in range(w) for c in range(ch))


class PngDecoder(unittest.TestCase):
    def roundtrip(self, w, h, ch, filters, seed=1, split=1):
        px = random_pixels(w, h, ch, seed)
        data = support.encode_png(w, h, ch, px, filters, split_idat=split)
        gw, gh, gch, got = terrain.decode_png(data)
        self.assertEqual((gw, gh, gch), (w, h, ch))
        self.assertEqual(bytes(got), bytes(px))

    def test_each_filter_rgb(self):
        for ft in range(5):
            with self.subTest(filter=ft):
                self.roundtrip(17, 9, 3, (ft,), seed=ft)

    def test_each_filter_rgba(self):
        for ft in range(5):
            with self.subTest(filter=ft):
                self.roundtrip(13, 11, 4, (ft,), seed=10 + ft)

    def test_mixed_filters_and_split_idat(self):
        self.roundtrip(31, 23, 3, (0, 1, 2, 3, 4, 4, 3, 2, 1), seed=99, split=5)
        self.roundtrip(31, 23, 4, (4, 1, 3), seed=98, split=3)

    def test_grey(self):
        self.roundtrip(10, 6, 1, (4, 3), seed=5)
        self.roundtrip(10, 6, 2, (1, 2), seed=6)

    def test_one_pixel(self):
        self.roundtrip(1, 1, 3, (4,))

    def test_rejects(self):
        with self.assertRaises(terrain.PNGError):
            terrain.decode_png(b"GIF89a....")
        import struct
        import zlib
        data = support.encode_png(2, 2, 3, bytearray(12))
        # patch bit depth to 16
        ihdr = struct.pack(">IIBBBBB", 2, 2, 16, 2, 0, 0, 0)
        chunk = struct.pack(">I", 13) + b"IHDR" + ihdr + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF)
        with self.assertRaises(terrain.PNGError):
            terrain.decode_png(data[:8] + chunk + data[8 + 25:])


class TerrariumTile(unittest.TestCase):
    def test_real_tile(self):
        """tests/py/fixtures/terrarium-12-1088-1609.png: AWS Terrain Tile in eastern Tennessee."""
        with open(support.fixture("terrarium-12-1088-1609.png"), "rb") as f:
            data = f.read()
        w, h, ch, px = terrain.decode_png(data)
        self.assertEqual((w, h, ch), (256, 256, 3))
        elev = terrain.terrarium_elevations(w, h, ch, px)
        self.assertEqual(len(elev), 65536)
        # East Tennessee ridge-and-valley: everything between ~200 and ~450 m
        self.assertGreater(min(elev), 200)
        self.assertLess(max(elev), 450)
        self.assertAlmostEqual(elev[128 * 256 + 128], 273.9140625, places=4)

    def test_sample_grid_from_fixture(self):
        def fetch(z, x, y):
            self.assertEqual((z, x, y), (12, 1088, 1609))
            with open(support.fixture("terrarium-12-1088-1609.png"), "rb") as f:
                return f.read()
        # a small grid well inside that tile
        x0, y0 = terrain.lonlat_to_tile(-84.30, 35.93, 12)
        self.assertEqual((int(x0), int(y0)), (1088, 1609))
        grid = terrain.sample_grid(35.925, 35.935, -84.31, -84.30, 5, 6, 12, terrain.TileSource(fetch))
        self.assertEqual(len(grid), 30)
        self.assertTrue(all(200 < e < 450 for e in grid))

    def test_bilinear_and_orientation(self):
        """Synthetic tiles whose elevation is the global pixel column (or row): the grid must
        increase eastward along a row, increase southward down a column (row 0 = north), and
        interpolate linearly between pixel centres."""
        z = 10
        cols = terrain.TileSource(lambda zz, tx, ty: support.terrarium_tile_png(lambda c, r: (tx * 256 + c) % 1000))
        rows = terrain.TileSource(lambda zz, tx, ty: support.terrarium_tile_png(lambda c, r: (ty * 256 + r) % 1000))
        g = terrain.sample_grid(10.0, 10.2, 20.0, 20.2, 3, 3, z, cols)
        self.assertLess(g[0], g[1])
        self.assertLess(g[1], g[2])
        fx, fy = terrain.lonlat_to_tile(20.1, 10.1, z)
        self.assertAlmostEqual(g[4], round((fx * 256 - 0.5) % 1000, 1), delta=0.11)
        g = terrain.sample_grid(10.0, 10.2, 20.0, 20.2, 3, 3, z, rows)
        self.assertLess(g[1], g[4])          # row 1 is south of row 0: larger tile y
        self.assertLess(g[4], g[7])
        self.assertAlmostEqual(g[4], round((fy * 256 - 0.5) % 1000, 1), delta=0.11)

    def test_despike(self):
        z = 14

        def fetch(zz, tx, ty):
            return support.terrarium_tile_png(lambda c, r: -1300.0 if (c, r) == (128, 128) else 20.0)
        src = terrain.TileSource(fetch)
        x, y = 4000 + 128.5 / 256, 6000 + 128.5 / 256      # centre of the bad pixel
        n = 2 ** z
        import math
        lon = x / n * 360 - 180
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
        stats = {}
        grid = terrain.sample_grid(lat - 0.0001, lat + 0.0001, lon - 0.0001, lon + 0.0001, 3, 3, z, src, stats=stats)
        self.assertEqual(grid[4], 20.0)
        self.assertEqual(stats.get("despiked"), 1)

    def test_choose_zoom(self):
        self.assertEqual(terrain.choose_zoom(37.765, 10000), 13)
        self.assertEqual(terrain.choose_zoom(0, 200), 15)       # clamped
        self.assertEqual(terrain.choose_zoom(0, 1e9), 1)        # clamped
        z = terrain.choose_zoom(-33.86, 6000)
        self.assertLess(abs(terrain.pixel_metres(-33.86, z) - 10.0), 5.0)


if __name__ == "__main__":
    unittest.main()
