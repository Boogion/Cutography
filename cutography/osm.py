"""OpenStreetMap roads, water and buildings via the Overpass API (with mirror fallback)."""
import json
import os
import time
from urllib.parse import urlencode

from . import net

# Tried in order; the last mirror that answered is tried first next time.
# overpass-api.de is the main instance but can be slow from some networks; maps.mail.ru is a
# full mirror. Override with CUTOGRAPHY_OVERPASS="url1,url2".
MIRRORS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
ATTRIBUTION = "Map data © OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)"

MAJOR_ROADS = ("motorway", "trunk", "primary", "secondary")
SKIP_BUILDINGS = ("house", "residential", "apartments", "roof", "garage", "garages",
                  "detached", "semidetached_house", "terrace")
WATER_LINES = ("river", "stream", "canal")

_last_good = [None]


class OverpassError(Exception):
    pass


def road_kinds(diameter_m):
    kinds = []
    for k in MAJOR_ROADS:
        kinds += [k, k + "_link"]
    if diameter_m <= 12000:
        kinds += ["tertiary", "tertiary_link"]
    if diameter_m <= 3000:
        kinds += ["residential", "unclassified", "living_street"]
    return kinds


def all_buildings(diameter_m):
    return diameter_m <= 1500


def build_query(south, west, north, east, diameter_m, timeout=180):
    bb = "(%.6f,%.6f,%.6f,%.6f)" % (south, west, north, east)
    skip = "|".join(SKIP_BUILDINGS)
    bfilter = '["building"]["building"!~"^(%s)$"]' % skip
    if not all_buildings(diameter_m):
        bfilter += '["name"]'
    lines = [
        "[out:json][timeout:%d];" % timeout,
        "(",
        '  way["highway"~"^(%s)$"]%s;' % ("|".join(road_kinds(diameter_m)), bb),
        '  way["waterway"~"^(%s)$"]%s;' % ("|".join(WATER_LINES), bb),
        '  way["natural"="water"]%s;' % bb,
        '  way["waterway"="riverbank"]%s;' % bb,
        '  way["landuse"="reservoir"]%s;' % bb,
        '  relation["type"="multipolygon"]["natural"="water"]%s;' % bb,
        '  relation["type"="multipolygon"]["waterway"="riverbank"]%s;' % bb,
        '  relation["type"="multipolygon"]["landuse"="reservoir"]%s;' % bb,
        "  way%s%s;" % (bfilter, bb),
        '  relation["type"="multipolygon"]%s["name"]%s;' % (bfilter, bb),
        ");",
        "out body;",
        ">;",
        "out skel qt;",
    ]
    return "\n".join(lines)


def mirrors():
    env = os.environ.get("CUTOGRAPHY_OVERPASS")
    ms = [m.strip() for m in env.split(",") if m.strip()] if env else list(MIRRORS)
    if _last_good[0] in ms:
        ms.remove(_last_good[0])
        ms.insert(0, _last_good[0])
    return ms


def fetch(query, progress=None, rounds=3, timeout=200, backoff=(0, 10, 30), sleep=time.sleep,
          request=None):
    """Run the query, trying each mirror in turn for up to `rounds` rounds.

    progress(message) is called with human-readable status lines.
    Returns (parsed_json, mirror_url)."""
    request = request or net.request
    body = urlencode({"data": query}).encode("utf-8")
    errors = []
    ms = mirrors()
    for rnd in range(rounds):
        if rnd and backoff:
            wait = backoff[min(rnd, len(backoff) - 1)]
            if progress:
                progress("OpenStreetMap servers are busy; trying again in %d s" % wait)
            sleep(wait)
        for m in ms:
            host = m.split("/")[2]
            if progress:
                progress("Downloading roads, water and buildings from OpenStreetMap (%s); "
                         "this can take a minute" % host)
            t0 = time.time()
            try:
                raw = request(m, data=body, timeout=timeout,
                              headers={"Content-Type": "application/x-www-form-urlencoded"})
            except net.HttpError as e:
                errors.append(str(e))
                if e.status == 400:
                    raise OverpassError("The map server rejected the query (%s)" % e)
                _failed(progress, host, str(e))
                continue
            try:
                data = json.loads(raw.decode("utf-8"))
            except ValueError:
                errors.append("%s sent a response that isn't JSON" % host)
                _failed(progress, host, "the response wasn't JSON")
                continue
            remark = data.get("remark") or ""
            if "error" in remark.lower():
                errors.append("%s: %s" % (host, remark.strip()))
                _failed(progress, host, remark.strip())
                continue
            _last_good[0] = m
            data["_seconds"] = round(time.time() - t0, 1)
            return data, m
    raise OverpassError("Couldn't download OpenStreetMap data; every server failed or timed out. "
                        "Try again in a few minutes. Details: " + "; ".join(errors[-4:]))


def _failed(progress, host, why):
    if progress:
        progress("%s didn't deliver (%s); trying another server" % (host, why[:160]))


# ------------------------------------------------------------------ parsing
def parse(data):
    """Split Overpass JSON into nodes {id: (lat, lon)}, ways {id: {tags, nodes}},
    relations {id: {tags, members}}. Tagged copies win over skeleton copies."""
    nodes, ways, rels = {}, {}, {}
    for el in data.get("elements", ()):
        t = el.get("type")
        if t == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
        elif t == "way":
            old = ways.get(el["id"])
            if old is None or (not old["tags"] and el.get("tags")):
                ways[el["id"]] = {"tags": el.get("tags") or {}, "nodes": el.get("nodes") or []}
        elif t == "relation":
            old = rels.get(el["id"])
            if old is None or (not old["tags"] and el.get("tags")):
                rels[el["id"]] = {"tags": el.get("tags") or {}, "members": el.get("members") or []}
    return nodes, ways, rels


def assemble_rings(node_lists):
    """Join open node-id sequences end to end into closed rings.

    Returns (rings, unclosed): rings are node-id lists with first == last."""
    pool = [list(s) for s in node_lists if len(s) >= 2]
    rings, unclosed = [], []
    while pool:
        cur = pool.pop(0)
        while cur[0] != cur[-1]:
            for i, s in enumerate(pool):
                if s[0] == cur[-1]:
                    cur.extend(s[1:])
                elif s[-1] == cur[-1]:
                    cur.extend(reversed(s[:-1]))
                elif s[-1] == cur[0]:
                    cur[:0] = s[:-1]
                elif s[0] == cur[0]:
                    cur[:0] = list(reversed(s[1:]))
                else:
                    continue
                pool.pop(i)
                break
            else:
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur)
        else:
            unclosed.append(cur)
    return rings, unclosed


def relation_rings(rel, ways):
    """[(role, node_ids)] for a multipolygon relation; unclosed rings are dropped."""
    by_role = {"outer": [], "inner": []}
    for m in rel["members"]:
        if m.get("type") != "way":
            continue
        w = ways.get(m.get("ref"))
        if w is None or len(w["nodes"]) < 2:
            continue
        role = "inner" if m.get("role") == "inner" else "outer"
        by_role[role].append(w["nodes"])
    out = []
    for role in ("outer", "inner"):
        rings, _ = assemble_rings(by_role[role])
        out += [(role, r) for r in rings]
    return out


def merge_chains(node_lists):
    """Join open node-id sequences that meet end to end at nodes where exactly two of them meet.

    Lossless: used to join a street that OSM splits into many short ways. Closed ways and
    junctions of three or more ways are left alone."""
    lists = [list(s) for s in node_lists if len(s) >= 2]
    ends = {}
    for i, s in enumerate(lists):
        if s[0] == s[-1]:
            continue
        ends.setdefault(s[0], []).append(i)
        ends.setdefault(s[-1], []).append(i)
    used = [False] * len(lists)
    out = []

    def partner(node, me):
        ids = ends.get(node, ())
        if len(ids) != 2:
            return None
        j = ids[0] if ids[1] == me else ids[1]
        return None if used[j] or j == me else j

    for i, s in enumerate(lists):
        if used[i]:
            continue
        used[i] = True
        chain = list(s)
        if chain[0] != chain[-1]:
            last = i
            while chain[0] != chain[-1]:
                j = partner(chain[-1], last)
                if j is None:
                    break
                t = lists[j]
                chain.extend(t[1:] if t[0] == chain[-1] else list(reversed(t[:-1])))
                used[j] = True
                last = j
            first = i
            while chain[0] != chain[-1]:
                j = partner(chain[0], first)
                if j is None:
                    break
                t = lists[j]
                chain[:0] = t[:-1] if t[-1] == chain[0] else list(reversed(t[1:]))
                used[j] = True
                first = j
        out.append(chain)
    return out
