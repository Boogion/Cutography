"""Regenerate tests/py/fixtures/overpass-small.json (a hand-made Overpass response).

Features are laid out in local metres around (10.0, 20.0) (x east, y south) and converted to
lat/lon, so the tests can check the transform exactly. Run: python tests/py/make_fixtures.py
"""
import json
import math
import os

LAT, LON = 10.0, 20.0
KX = 111320 * math.cos(math.radians(LAT))
KY = 110950.0
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "overpass-small.json")

elements = []
_nid = [1000]
_cache = {}


def node(x, y):
    key = (x, y)
    if key in _cache:
        return _cache[key]
    _nid[0] += 1
    nid = _nid[0]
    elements.append({"type": "node", "id": nid, "lat": round(LAT - y / KY, 9), "lon": round(LON + x / KX, 9)})
    _cache[key] = nid
    return nid


def way(wid, pts, tags=None, close=False):
    ids = [node(x, y) for x, y in pts]
    if close:
        ids.append(ids[0])
    w = {"type": "way", "id": wid, "nodes": ids}
    if tags:
        w["tags"] = tags
    elements.append(w)
    return w


def rect(cx, cy, L, W, ang_deg):
    a = math.radians(ang_deg)
    c, s = math.cos(a), math.sin(a)
    out = []
    for u, v in ((-L / 2, -W / 2), (L / 2, -W / 2), (L / 2, W / 2), (-L / 2, W / 2)):
        out.append((round(cx + u * c - v * s, 3), round(cy + u * s + v * c, 3)))
    return out


def build():
    # roads: Main Street split in two ways (merged, then clipped at x = +-550)
    way(100, [(-700, 0), (-100, 0)], {"highway": "primary", "name": "Main Street"})
    way(101, [(-100, 0), (300, 0), (700, 0)], {"highway": "primary", "name": "Main Street", "ref": "A1"})
    way(102, [(-300, 500), (-200, 600), (-100, 500), (0, 600), (100, 500)],
        {"highway": "residential", "name": "Zigzag Lane"})
    way(103, [(200, -100), (300, -100)], {"highway": "service", "name": "Back Alley"})
    way(104, [(0, -100), (0, -200)], {"highway": "secondary", "name": "Tube", "tunnel": "yes"})
    # water: multipolygon lake, outer ring split into three ways (one reversed) plus an island
    a, b, c, d = (-400, -400), (-200, -400), (-200, -200), (-400, -200)
    way(201, [a, b])
    way(202, [c, b])
    way(203, [c, d, a])
    way(204, [(-320, -320), (-280, -320), (-280, -280), (-320, -280)], close=True)
    elements.append({"type": "relation", "id": 200, "members": [
        {"type": "way", "ref": 201, "role": "outer"}, {"type": "way", "ref": 202, "role": "outer"},
        {"type": "way", "ref": 203, "role": "outer"}, {"type": "way", "ref": 204, "role": "inner"}],
        "tags": {"type": "multipolygon", "natural": "water", "name": "Test Lake"}})
    way(205, [(0, 300), (50, 320), (120, 330)], {"waterway": "stream", "name": "Brook"})
    way(206, [(400, 400), (700, 400), (700, 500), (400, 500)], {"natural": "water", "name": "Edge Pond"}, close=True)
    # buildings
    way(300, rect(200, 200, 100, 40, 30), {"building": "yes", "name": "Big Hall"}, close=True)
    way(301, rect(100, -300, 20, 10, 0), {"building": "commercial", "name": "Small Shop"}, close=True)
    way(302, rect(-100, -100, 12, 10, 0), {"building": "house", "name": "A House"}, close=True)
    way(303, rect(-100, 300, 50, 30, 0), {"building": "yes"}, close=True)
    way(304, rect(800, 0, 30, 30, 0), {"building": "yes", "name": "Far Away"}, close=True)
    way(306, rect(-300, 100, 60, 60, 0), close=True)
    way(307, rect(-300, 100, 20, 20, 0), close=True)
    elements.append({"type": "relation", "id": 305, "members": [
        {"type": "way", "ref": 306, "role": "outer"}, {"type": "way", "ref": 307, "role": "inner"}],
        "tags": {"type": "multipolygon", "building": "yes", "name": "Courtyard Block"}})
    # nodes first, like Overpass "out body; >; out skel qt;" (order doesn't matter to the parser)
    elements.sort(key=lambda e: {"node": 0, "way": 1, "relation": 2}[e["type"]])
    return {"version": 0.6, "generator": "hand-made test fixture",
            "osm3s": {"timestamp_osm_base": "2026-01-01T00:00:00Z"}, "elements": elements}


if __name__ == "__main__":
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(build(), f, indent=1)
    print("wrote", OUT)
