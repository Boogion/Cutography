# Site format (schema 1)

A *site* is one JSON file describing a circular patch of the world: an elevation grid plus
buildings, roads and water from OpenStreetMap, all in metres around the site's centre. The
map generator in `web/` reads it; `cutography/sitefetch.py` writes it.

Where sites live:

| Source     | Folder                                              | Listed as `source` |
|------------|-----------------------------------------------------|--------------------|
| Examples   | `sites/` in the repo (bundled, read-only when frozen) | `example`          |
| Fetched    | `~/Documents/Cutography/sites/`         | `user`             |
| Internal   | `internal/<name>/site.json` (source checkout only, never shipped) | `internal` |

Files are written with compact separators (`(",", ":")`), UTF-8, no BOM.

## Top level

```jsonc
{
  "schema": 1,
  "id": "san-francisco",          // [a-z0-9][a-z0-9_-]*, unique across all sources; file name is <id>.json
  "name": "San Francisco",
  "center": [37.765, -122.445],   // [lat, lon] in degrees (WGS 84)
  "diameterM": 10000,             // circle diameter in metres (200..30000)
  "createdAt": "2026-10-28T01:26:30Z",
  "kx": 88001.7,                  // metres per degree of longitude at the centre = 111320 * cos(lat)
  "ky": 110950,                   // metres per degree of latitude
  "dem": { ... },
  "buildings": [ ... ],
  "roads": [ ... ],
  "water": [ ... ],
  "mainShapes": [ ... ],
  "attribution": "Map data © OpenStreetMap contributors, ODbL 1.0 ... Elevation: AWS Terrain Tiles ...",
  "sources": { ... }
}
```

Unknown keys must be ignored by readers. Some sites carry optional extra keys (see the end of this page).

## Coordinates

Every `x, y` is in metres relative to `center`, rounded to 0.1 m:

```
x = (lon - center.lon) * kx      // east is +x
y = (center.lat - lat) * ky      // SOUTH is +y (screen-style)
```

and back: `lat = center.lat - y / ky`, `lon = center.lon + x / kx`.

Features are clipped to the square `|x| <= R * 1.1`, `|y| <= R * 1.1` (R = diameterM / 2), the
circle's bounding box plus 10 %. Lines crossing the box edge are cut there (one OSM way can
become several pieces); polygons are clipped to the box, so a lake that covers the whole
area comes back as the box itself.

## `dem`: elevation grid

```jsonc
{
  "lat0": 37.7204, "lat1": 37.8096,  // south and north edges
  "lon0": -122.5075, "lon1": -122.3825, // west and east edges
  "cols": 160, "rows": 160,
  "elev": [ ... rows*cols numbers, metres, 1 decimal ... ],
  "source": "AWS Terrain Tiles (Terrarium), Mapzen/Tilezen joerd, zoom 13, bilinear"
}
```

* Row-major. **Row 0 is the north edge (`lat1`)**, row `rows-1` the south edge (`lat0`).
  **Col 0 is the west edge (`lon0`)**. Sample `(r, c)` sits exactly at
  `lat = lat1 - (lat1 - lat0) * r / (rows - 1)`, `lon = lon0 + (lon1 - lon0) * c / (cols - 1)`
  (the corners are samples, not cell edges).
* The grid covers the same box as the clip box above (circle bbox + 10 %), about 160 × 160.
* Values at or below 0 are sea (or below sea level); bathymetry is kept as-is (e.g. -111 m in
  San Francisco Bay's Golden Gate). The browser treats `elev <= 0` as sea; coastlines are not fetched.
* Elevation comes from Terrarium tiles at a zoom where one tile pixel ≈ diameter / 600, resampled
  bilinearly. Accuracy is roughly that of the underlying source (USGS 3DEP 10 m in the US, SRTM
  30 m in much of the world). Checked against a USGS 10 m grid in Tennessee: median difference 1.8 m,
  95th percentile 7 m.

## `buildings`

```jsonc
{ "name": "Chase Center", "ref": "", "area": 19537, "pts": [[x, y], ...] }
```

* `pts` is an **open ring** (the first point is not repeated), at least 3 points, either winding.
* `area` is the polygon area in m², integer, after clipping.
* `ref` is OSM `ref`, else `addr:housenumber`, else `""`.
* Sorted by `area`, largest first.
* Which buildings: OSM ways (and named multipolygon relations, one entry per outer ring) tagged
  `building=*` **with a `name`** at any diameter; **every** building when `diameterM <= 1500`.
  Skipped always: `building=house|residential|apartments|roof|garage|garages|detached|semidetached_house|terrace`.
  A building is kept only if its centroid lies inside the clip box.

## `roads`

```jsonc
{ "name": "Market Street", "kind": "primary", "tunnel": false, "pts": [[x, y], ...], "ref": "US 101" }
```

* `kind` is the OSM `highway` value.
* `tunnel` is true when OSM `tunnel` is set to anything but `no` (includes `building_passage`, `culvert`).
* `ref` (optional key) is the OSM road number when present.
* Open polyline, at least 2 points. Consecutive OSM ways with the same name, kind, tunnel and
  ref that meet end to end (exactly two ways at the joint) are joined into one line; nothing is
  simplified away.
* Which roads: `motorway`, `trunk`, `primary`, `secondary` and their `_link`s always;
  `tertiary(_link)` when `diameterM <= 12000`; `residential`, `unclassified`, `living_street`
  when `diameterM <= 3000`. Never `service`, `footway`, `path`, etc.

## `water`

```jsonc
{ "name": "Lake Merced", "kind": "water", "closed": true, "role": "outer", "pts": [[x, y], ...] }
```

* `kind`: `river`, `stream`, `canal` (lines, `closed: false`); `water` (OSM `natural=water`),
  `riverbank` (`waterway=riverbank`), `reservoir` (`landuse=reservoir`) for areas (`closed: true`).
* Areas (`closed: true`) are **open rings** like buildings. Lines (`closed: false`) are polylines.
* `role` is `outer` or `inner`. Inner rings are holes (islands) of a multipolygon; they come
  right after the outer rings of the same relation, but the relation grouping isn't stored, so
  draw all closed rings with an even-odd fill or subtract `inner` rings from `outer` ones.
* Multipolygon relations are assembled from their member ways by joining endpoints; rings that
  can't be closed are dropped.

## `mainShapes`

```jsonc
{ "i": 0, "name": "Chase Center", "area": 19537, "type": "rect",
  "c": [5066.0, -319.9], "len": 155.1, "wid": 154.1, "ang": -10.0 }
```

The minimum-area bounding rectangle of each building, for drawing simplified footprints.
`i` indexes `buildings`. `len >= wid` (metres); `ang` is the direction of the long side in
degrees, -90..90, measured from +x toward +y (i.e. clockwise on screen, since +y is south).
Sorted by area, largest first; at most 60.

## `attribution`, `sources`

`attribution` is a single string to print on exports (OpenStreetMap ODbL notice plus the
Terrarium data providers' required credits). `sources` holds details:

```jsonc
{
  "elevation": { "name": "...", "url": "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
                 "zoom": 13, "tiles": 16, "attribution": ["...one line per provider..."] },
  "osm": { "name": "OpenStreetMap via Overpass API", "server": "https://overpass-api.de/api/interpreter",
           "dataTimestamp": "2026-10-28T01:25:51Z", "seconds": 37.7, "license": "ODbL 1.0", "attribution": "..." }
}
```

## Optional keys and add-ons

Readers ignore keys they don't know, so a site can carry more than schema 1. The map page uses these
when present:

* `frames`: named fixed views, `{id: {name, offset: [x, y] metres from center, scale: N for 1:N, dem?}}`.
  The page then offers a Frame choice instead of fitting `diameterM` to the wafer.
* `demFine`: a second, finer elevation grid (same layout as `dem`) used by frames that set `dem`.
* `extrasScript`: a script the page loads before drawing the site. It registers
  `window.MaskSetExtras[<site id>] = {defaults, options, items(ctx), lettering(ctx), placard(ctx), status(M)}`
  to add hand-built features for that one place (see the comment at the top of `web/js/map.js`).
* `buildings[].group`: buildings in a named group are handled by an add-on rather than the
  landmark-building list.

Sites under the repo's `internal/` folder are listed with source `internal` when running from source,
and are never listed or served by a packaged build.
