"""Build a site JSON (schema 1, see docs/site-format.md) for a location.

CLI:
    python -m paperstrata.sitefetch --name "San Francisco" --coords "37.765, -122.445" \
        --diameter 10 --unit km --out sites/san-francisco.json
"""
import argparse
import datetime
import hashlib
import json
import math
import os
import re
import sys
import time
import unicodedata

from . import coords as coordmod
from . import geom, osm, terrain

SCHEMA = 1
KY = 110950.0
MARGIN = 1.1            # grid and clip box: circle bounding box plus 10 %
GRID = 160              # DEM samples per side
MAX_MAIN_SHAPES = 60
MIN_DIAMETER_M, MAX_DIAMETER_M = 200.0, 30000.0
UNITS = {"km": 1000.0, "mi": 1609.344, "m": 1.0}


class SiteError(ValueError):
    pass


# ------------------------------------------------------------------ inputs
def diameter_metres(value, unit="km"):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise SiteError("Diameter must be a number.")
    if math.isnan(v) or math.isinf(v):
        raise SiteError("Diameter must be a number.")
    u = (unit or "km").strip().lower()
    if u not in UNITS:
        raise SiteError("Unit must be km or mi.")
    m = v * UNITS[u]
    if not MIN_DIAMETER_M - 1e-6 <= m <= MAX_DIAMETER_M + 1e-6:
        if u == "mi":
            raise SiteError("Diameter must be between 0.13 and 18.6 miles (0.2 to 30 km).")
        raise SiteError("Diameter must be between 0.2 and 30 km.")
    return m


def slugify(name):
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:48].strip("-")
    return s or "site"


def unique_id(base, taken):
    if base not in taken:
        return base
    k = 2
    while "%s-%d" % (base, k) in taken:
        k += 1
    return "%s-%d" % (base, k)


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ frame
class Frame(object):
    """Local metric frame: x east, y SOUTH, metres from the centre."""

    def __init__(self, lat, lon, diameter_m, margin=MARGIN):
        self.lat, self.lon = lat, lon
        self.kx = 111320.0 * math.cos(math.radians(lat))
        self.ky = KY
        self.half = diameter_m / 2.0 * margin
        self.lat0 = lat - self.half / self.ky
        self.lat1 = lat + self.half / self.ky
        self.lon0 = lon - self.half / self.kx
        self.lon1 = lon + self.half / self.kx

    def xy(self, lat, lon):
        return ((lon - self.lon) * self.kx, (self.lat - lat) * self.ky)

    def clip_box(self):
        h = self.half
        return -h, -h, h, h


def _r(pts):
    return geom.dedupe([[round(p[0], 1), round(p[1], 1)] for p in pts])


# ------------------------------------------------------------------ OSM -> features
def _water_kind(tags):
    if tags.get("waterway") in ("river", "stream", "canal", "riverbank"):
        return tags["waterway"]
    if tags.get("landuse") == "reservoir":
        return "reservoir"
    if tags.get("natural") == "water":
        return "water"
    return tags.get("waterway") or tags.get("natural") or "water"


def _is_water_area(tags):
    return (tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
            or tags.get("landuse") == "reservoir")


def _is_building(tags):
    b = tags.get("building")
    return bool(b) and b != "no" and b not in osm.SKIP_BUILDINGS


def _tunnel(tags):
    t = tags.get("tunnel")
    return bool(t) and t != "no"


def osm_features(data, frame, diameter_m):
    """Turn Overpass JSON into (buildings, roads, water) lists in the frame's metres."""
    nodes, ways, rels = osm.parse(data)
    box = frame.clip_box()
    road_kinds = set(osm.road_kinds(diameter_m))
    want_all_buildings = osm.all_buildings(diameter_m)

    def pts_of(ids):
        out = []
        for i in ids:
            ll = nodes.get(i)
            if ll is not None:
                out.append(frame.xy(ll[0], ll[1]))
        return out

    buildings, roads, water = [], [], []

    def add_polygon(ring_xy):
        clipped = geom.clip_polygon(ring_xy, *box)
        ring = geom.open_ring(_r(clipped))
        if len(ring) < 3 or geom.area(ring) < 0.5:
            return None
        return ring

    def add_building(tags, ids):
        ring_xy = pts_of(ids)
        if len(ring_xy) < 3:
            return
        cx, cy = geom.centroid(geom.open_ring(ring_xy))
        if not (box[0] <= cx <= box[2] and box[1] <= cy <= box[3]):
            return
        ring = add_polygon(ring_xy)
        if ring is None:
            return
        buildings.append({"name": tags.get("name", ""),
                          "ref": tags.get("ref") or tags.get("addr:housenumber", ""),
                          "area": int(round(geom.area(ring))), "pts": ring})

    road_groups, line_groups = {}, {}
    for wid in sorted(ways):
        w = ways[wid]
        tags, ids = w["tags"], w["nodes"]
        if not tags or len(ids) < 2:
            continue
        closed = len(ids) >= 4 and ids[0] == ids[-1]
        hw = tags.get("highway")
        if hw in road_kinds:
            key = (tags.get("name", ""), hw, _tunnel(tags), tags.get("ref", ""))
            road_groups.setdefault(key, []).append(ids)
        elif tags.get("waterway") in osm.WATER_LINES:
            key = (tags.get("name", ""), tags["waterway"])
            line_groups.setdefault(key, []).append(ids)
        elif _is_water_area(tags):
            if closed:
                ring = add_polygon(pts_of(ids))
                if ring:
                    water.append({"name": tags.get("name", ""), "kind": _water_kind(tags),
                                  "closed": True, "role": "outer", "pts": ring})
        elif _is_building(tags) and closed and (want_all_buildings or tags.get("name")):
            add_building(tags, ids)

    # streets and streams are split into many short ways in OSM; join them back up (lossless)
    for (name, kind, tunnel, ref), lists in sorted(road_groups.items()):
        for ids in osm.merge_chains(lists):
            for piece in geom.clip_polyline(pts_of(ids), *box):
                p = _r(piece)
                if len(p) >= 2:
                    r = {"name": name, "kind": kind, "tunnel": tunnel, "pts": p}
                    if ref:
                        r["ref"] = ref
                    roads.append(r)
    for (name, kind), lists in sorted(line_groups.items()):
        for ids in osm.merge_chains(lists):
            for piece in geom.clip_polyline(pts_of(ids), *box):
                p = _r(piece)
                if len(p) >= 2:
                    water.append({"name": name, "kind": kind, "closed": False, "role": "outer", "pts": p})

    for rid in sorted(rels):
        rel = rels[rid]
        tags = rel["tags"]
        if tags.get("type") != "multipolygon":
            continue
        if _is_water_area(tags):
            for role, ids in osm.relation_rings(rel, ways):
                ring = add_polygon(pts_of(ids))
                if ring:
                    water.append({"name": tags.get("name", ""), "kind": _water_kind(tags),
                                  "closed": True, "role": role, "pts": ring})
        elif _is_building(tags) and tags.get("name"):
            for role, ids in osm.relation_rings(rel, ways):
                if role == "outer":
                    add_building(tags, ids)

    buildings.sort(key=lambda b: (-b["area"], b["name"]))
    return buildings, roads, water


def main_shapes(buildings, limit=MAX_MAIN_SHAPES):
    order = sorted(range(len(buildings)), key=lambda i: (-buildings[i]["area"], i))
    out = []
    for i in order[:limit]:
        b = buildings[i]
        c, L, W, ang = geom.min_rect(b["pts"])
        out.append({"i": i, "name": b["name"], "area": b["area"], "type": "rect",
                    "c": c, "len": L, "wid": W, "ang": ang})
    return out


# ------------------------------------------------------------------ orchestration
def cached_overpass(cache_dir, fetch=None):
    """Wrap osm.fetch so responses are stored in cache_dir/osm-<hash>.json (developer runs)."""
    fetch = fetch or osm.fetch

    def run(query, msg):
        key = hashlib.sha1(query.encode("utf-8")).hexdigest()[:16]
        path = os.path.join(cache_dir, "osm-%s.json" % key)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            return d, d.get("_mirror", "cache")
        data, mirror = fetch(query, msg)
        os.makedirs(cache_dir, exist_ok=True)
        data["_mirror"] = mirror
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return data, mirror
    return run


def build_site(name, lat, lon, diameter_m, progress=None, site_id=None, tiles=None,
               overpass=None, created_at=None, cache_dir=None):
    """Fetch elevation and OSM data and return the site dict.

    progress(fraction, message) is called along the way.
    tiles: a terrain.TileSource (for tests/caching). overpass: callable(query, msg_cb) ->
    (json, mirror), defaults to osm.fetch."""
    def report(f, msg):
        if progress:
            progress(max(0.0, min(1.0, f)), msg)

    frame = Frame(lat, lon, diameter_m)
    report(0.02, "Preparing")

    # elevation
    z = terrain.choose_zoom(lat, diameter_m)
    src = tiles or terrain.TileSource(cache_dir=os.path.join(cache_dir, "tiles") if cache_dir else None)
    if overpass is None and cache_dir:
        overpass = cached_overpass(cache_dir)
    dstats = {}
    elev = terrain.sample_grid(frame.lat0, frame.lat1, frame.lon0, frame.lon1, GRID, GRID, z, src,
                               progress=lambda f, m: report(0.03 + 0.3 * f, m), stats=dstats)
    report(0.34, "Elevation ready")

    # OpenStreetMap
    query = osm.build_query(frame.lat0, frame.lon0, frame.lat1, frame.lon1, diameter_m)
    t0 = time.time()
    tick = [0.36]

    def osm_msg(msg):
        tick[0] = min(0.85, tick[0] + 0.04)
        report(tick[0], msg)
    data, mirror = (overpass or osm.fetch)(query, osm_msg)
    report(0.88, "Processing roads, water and buildings")
    buildings, roads, water = osm_features(data, frame, diameter_m)
    shapes = main_shapes(buildings)

    sid = site_id or slugify(name)
    site = {
        "schema": SCHEMA,
        "id": sid,
        "name": name,
        "center": [round(lat, 7), round(lon, 7)],
        "diameterM": int(round(diameter_m)),
        "createdAt": created_at or now_iso(),
        "kx": frame.kx,
        "ky": frame.ky,
        "dem": {"lat0": frame.lat0, "lat1": frame.lat1, "lon0": frame.lon0, "lon1": frame.lon1,
                "cols": GRID, "rows": GRID, "elev": elev,
                "source": "%s, zoom %d, bilinear" % (terrain.SOURCE, z)},
        "buildings": buildings,
        "roads": roads,
        "water": water,
        "mainShapes": shapes,
        "attribution": osm.ATTRIBUTION + ". " + terrain.ATTRIBUTION,
        "sources": {
            "elevation": {"name": terrain.SOURCE, "url": terrain.TILE_URL, "zoom": z,
                          "tiles": len(src.tiles), "despiked": dstats.get("despiked", 0),
                          "attribution": list(terrain.ATTRIBUTION_LINES)},
            "osm": {"name": "OpenStreetMap via Overpass API", "server": mirror,
                    "dataTimestamp": (data.get("osm3s") or {}).get("timestamp_osm_base", ""),
                    "seconds": data.get("_seconds", round(time.time() - t0, 1)),
                    "license": "ODbL 1.0", "attribution": osm.ATTRIBUTION},
        },
    }
    report(1.0, "Done")
    return site


def dumps(site):
    return json.dumps(site, separators=(",", ":"), ensure_ascii=False)


def save(site, path):
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(dumps(site))
    os.replace(tmp, path)
    return path


def summary(site):
    named_roads = len({r["name"] for r in site["roads"] if r["name"]})
    e = site["dem"]["elev"]
    return ("%s: %d buildings (%d named), %d road pieces (%d named streets), %d water features, "
            "%d main shapes, elevation %.0f..%.0f m"
            % (site["id"], len(site["buildings"]), sum(1 for b in site["buildings"] if b["name"]),
               len(site["roads"]), named_roads, len(site["water"]), len(site["mainShapes"]), min(e), max(e)))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m paperstrata.sitefetch",
                                 description="Fetch elevation and OpenStreetMap data for a site.")
    ap.add_argument("--name", required=True)
    ap.add_argument("--coords", required=True, help='e.g. "37.765, -122.445" or a Google Maps link')
    ap.add_argument("--diameter", required=True, type=float)
    ap.add_argument("--unit", default="km", choices=sorted(UNITS))
    ap.add_argument("--id", help="site id (default: from the name)")
    ap.add_argument("--out", help="output file (default: <user folder>/sites/<id>.json)")
    ap.add_argument("--cache", help="keep downloaded tiles and OpenStreetMap responses in this folder")
    a = ap.parse_args(argv)
    try:
        lat, lon, _ = coordmod.parse(a.coords)
        dm = diameter_metres(a.diameter, a.unit)
    except (coordmod.CoordError, SiteError) as e:
        ap.error(str(e))

    def progress(f, msg):
        sys.stderr.write("[%3d%%] %s\n" % (int(f * 100), msg))
        sys.stderr.flush()
    sid = a.id or slugify(a.name)
    try:
        site = build_site(a.name, lat, lon, dm, progress=progress, site_id=sid, cache_dir=a.cache)
    except (osm.OverpassError, terrain.PNGError) as e:
        sys.stderr.write("Failed: %s\n" % e)
        return 1
    if not a.out:
        from . import paths
        a.out = os.path.join(paths.user_sites_dir(), sid + ".json")
    save(site, a.out)
    print("%s  (%d bytes)" % (a.out, os.path.getsize(a.out)))
    print(summary(site))
    return 0


if __name__ == "__main__":
    sys.exit(main())
