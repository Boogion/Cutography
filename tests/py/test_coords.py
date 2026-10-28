# -*- coding: utf-8 -*-
import unittest

import support  # noqa: F401  (sets sys.path)
from paperstrata import coords

LAT, LON = 35.93201, -84.30970
DMS_LAT, DMS_LON = 35 + 55 / 60 + 55.2 / 3600, -(84 + 18 / 60 + 34.9 / 3600)


class ParseOk(unittest.TestCase):
    def check(self, text, lat, lon, fmt, places=6):
        got_lat, got_lon, got_fmt = coords.parse(text)
        self.assertAlmostEqual(got_lat, lat, places=places, msg=text)
        self.assertAlmostEqual(got_lon, lon, places=places, msg=text)
        self.assertEqual(got_fmt, fmt, text)

    def test_decimal(self):
        for t in ("35.93201, -84.30970", "35.93201 -84.30970", "(35.93201, -84.30970)",
                  "  35.93201,-84.30970  ", "[35.93201; -84.30970]", "35.93201\t-84.30970",
                  "35.93201° -84.30970°", "35.93201°, −84.30970°", "Lat: 35.93201, Long: -84.30970",
                  "+35.93201 -84.30970"):
            self.check(t, LAT, LON, "decimal")

    def test_decimal_with_hemispheres(self):
        self.check("35.932N, 84.3097W", 35.932, -84.3097, "decimal")
        self.check("35.932 N 84.3097 W", 35.932, -84.3097, "decimal")
        self.check("35.932° N, 84.3097° W", 35.932, -84.3097, "decimal")
        self.check("33.86S 151.21E", -33.86, 151.21, "decimal")
        self.check("84.3097W 35.932N", 35.932, -84.3097, "decimal")   # longitude first
        self.check("N35.932 W84.3097", 35.932, -84.3097, "decimal")

    def test_dms(self):
        for t in ('35°55\'55.2"N 84°18\'34.9"W',
                  "35°55′55.2″N 84°18′34.9″W",
                  '35° 55\' 55.2" N, 84° 18\' 34.9" W',
                  '35°55\'55.2"n 84°18\'34.9"w',
                  'N 35° 55\' 55.2" W 84° 18\' 34.9"',
                  "N 35° 55′ 55.2″, W 84° 18′ 34.9″",
                  "35°55'55.2''N 84°18'34.9''W",
                  "35 55 55.2 N 84 18 34.9 W",
                  "35 55 55.2 -84 18 34.9",
                  "35º55’55.2”N 84º18’34.9”W"):
            self.check(t, DMS_LAT, DMS_LON, "dms")

    def test_dm_and_southern(self):
        self.check("33°51.6'S 151°12.6'E", -33.86, 151.21, "dms")
        self.check("-33° 51' 36\", 151° 12' 36\"", -33.86, 151.21, "dms")

    def test_google_urls(self):
        self.check("https://www.google.com/maps/@35.93201,-84.30970,15z", LAT, LON, "url")
        self.check("https://www.google.com/maps/@35.93201,-84.30970,3a,75y,90t/data=!3m6!1e1", LAT, LON, "url")
        self.check("https://maps.google.com/?q=35.93,-84.30", 35.93, -84.30, "url")
        self.check("https://www.google.com/maps?q=35.93%2C-84.30&z=15", 35.93, -84.30, "url")
        self.check("https://www.google.com/maps/search/?api=1&query=35.93,-84.30", 35.93, -84.30, "url")
        # !3d!4d is the place itself and wins over the @ map view
        self.check("https://www.google.com/maps/place/Oak+Ridge/@35.9,-84.2,17z/data=!3m1!4b1!4m6!3m5"
                   "!1s0x885c:0x1!8m2!3d35.93201!4d-84.3097!16s%2Fm%2F0abc", LAT, LON, "url")
        self.check("https://earth.google.com/web/@35.93201,-84.3097,250a,1000d,35y,0h,0t,0r", LAT, LON, "url")
        self.check("https://www.google.com/maps/place/35.93201,-84.30970", LAT, LON, "url")

    def test_parse_dict(self):
        d = coords.parse_dict("35.93201, -84.30970")
        self.assertEqual(d, {"ok": True, "lat": 35.93201, "lon": -84.3097, "format": "decimal"})


class ParseErrors(unittest.TestCase):
    def err(self, text):
        with self.assertRaises(coords.CoordError) as cm:
            coords.parse(text)
        return str(cm.exception)

    def test_messages(self):
        self.assertIn("Paste coordinates", self.err(""))
        self.assertIn("Paste coordinates", self.err("   "))
        self.assertIn("Couldn't find two numbers", self.err("hello there"))
        self.assertIn("Couldn't find two numbers", self.err("35.93201"))
        self.assertIn("Latitude must be between -90 and 90", self.err("95.1, 20"))
        self.assertIn("Did you swap", self.err("-122.4, 37.7"))
        self.assertIn("Longitude must be between -180 and 180", self.err("35, 200"))
        self.assertIn("Minutes must be between 0 and 60", self.err("35°75'N 84°W"))
        self.assertIn("Seconds must be between 0 and 60", self.err("35°5'61\"N 84°W"))
        self.assertIn("Found 3 coordinates", self.err("1, 2, 3"))
        self.assertIn("one should be N or S", self.err("35N 84N"))
        self.assertIn("minus sign", self.err("-35S 84E"))
        self.assertIn("Short Google links", self.err("https://maps.app.goo.gl/AbCdEf"))
        self.assertIn("doesn't contain coordinates", self.err("https://www.google.com/maps/place/Oak+Ridge"))
        self.assertIn("Latitude must be", self.err("https://www.google.com/maps/@135.1,20,15z"))

    def test_parse_dict_error(self):
        d = coords.parse_dict("nope")
        self.assertFalse(d["ok"])
        self.assertIn("Couldn't find two numbers", d["error"])


if __name__ == "__main__":
    unittest.main()
