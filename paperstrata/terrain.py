"""Elevation from AWS Terrain Tiles (Terrarium PNG) with a small standard-library PNG decoder.

    elevation (m) = R * 256 + G + B / 256 - 32768

Tiles are Web Mercator 256x256. sample_grid() bilinearly resamples them onto a regular
lat/lon grid (row 0 = north edge, col 0 = west edge).
"""
import math
import os
import struct
import time
import zlib

from . import net

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
SOURCE = "AWS Terrain Tiles (Terrarium), Mapzen/Tilezen joerd"
# Required attribution, https://github.com/tilezen/joerd/blob/master/docs/attribution.md
ATTRIBUTION_LINES = (
    "ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under "
    "National Science Foundation awards 1043681, 1559691, and 1542736",
    "Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017",
    "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich",
    "Canada terrain data contains information licensed under the Open Government Licence – Canada",
    "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers",
    "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration",
    "Mexico terrain data source: INEGI, Continental relief, 2016",
    "New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the "
    "New Zealand Government (All rights reserved)",
    "Norway terrain data © Kartverket",
    "United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved",
    "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey",
)
ATTRIBUTION = "Elevation: AWS Terrain Tiles (Mapzen/Tilezen joerd). " + "; ".join(ATTRIBUTION_LINES) + "."

PNG_SIG = b"\x89PNG\r\n\x1a\n"


class PNGError(ValueError):
    pass


# ------------------------------------------------------------------ PNG decoding
def decode_png(data):
    """Decode an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB or RGBA).

    Returns (width, height, channels, pixels) where pixels is a bytearray of
    height * width * channels samples, row-major from the top."""
    if data[:8] != PNG_SIG:
        raise PNGError("not a PNG file")
    pos = 8
    width = height = None
    depth = ctype = interlace = None
    idat = []
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            raise PNGError("truncated %s chunk" % kind.decode("latin-1"))
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if width is None:
        raise PNGError("missing IHDR")
    if depth != 8:
        raise PNGError("only 8-bit PNGs are supported (bit depth %d)" % depth)
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(ctype)
    if channels is None:
        raise PNGError("unsupported PNG colour type %d" % ctype)
    if interlace:
        raise PNGError("interlaced PNGs are not supported")
    raw = zlib.decompress(b"".join(idat))
    stride = width * channels
    if len(raw) < height * (stride + 1):
        raise PNGError("image data too short")
    return width, height, channels, _unfilter(raw, width, height, channels)


def _unfilter(raw, width, height, bpp):
    stride = width * bpp
    out = bytearray(height * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ft = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += stride + 1
        if ft == 0:
            pass
        elif ft == 1:          # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ft == 2:          # Up
            line = bytearray((a + b) & 0xFF for a, b in zip(line, prev))
        elif ft == 3:          # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ft == 4:          # Paeth
            for i in range(stride):
                if i >= bpp:
                    a = line[i - bpp]
                    c = prev[i - bpp]
                else:
                    a = c = 0
                b = prev[i]
                p = a + b - c
                pa = abs(p - a)
                pb = abs(p - b)
                pc = abs(p - c)
                if pa <= pb and pa <= pc:
                    pr = a
                elif pb <= pc:
                    pr = b
                else:
                    pr = c
                line[i] = (line[i] + pr) & 0xFF
        else:
            raise PNGError("bad filter type %d on row %d" % (ft, y))
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return out


def terrarium_elevations(width, height, channels, px):
    """List of elevations (metres) from decoded Terrarium pixels, row-major."""
    n = width * height
    return [px[i * channels] * 256.0 + px[i * channels + 1] + px[i * channels + 2] / 256.0 - 32768.0
            for i in range(n)]


# ------------------------------------------------------------------ tile maths
def lonlat_to_tile(lon, lat, z):
    """Fractional tile coordinates (Web Mercator)."""
    n = 2.0 ** z
    lat = max(-85.05112878, min(85.05112878, lat))
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def choose_zoom(lat, diameter_m, target_px=600):
    """Zoom where one tile pixel is about diameter / target_px metres, clamped to 1..15."""
    want = max(diameter_m / float(target_px), 0.01)
    mpp0 = 156543.03392 * math.cos(math.radians(lat))   # metres per pixel at z0
    z = int(round(math.log(max(mpp0 / want, 1.0), 2)))
    return max(1, min(15, z))


class TileSource(object):
    """Fetches and caches decoded Terrarium tiles (elevation lists, 256*256)."""

    def __init__(self, fetch=None, cache_dir=None, progress=None):
        self._fetch = fetch or self._download
        self.cache_dir = cache_dir
        self.tiles = {}
        self.progress = progress

    def _download(self, z, x, y):
        url = TILE_URL.format(z=z, x=x, y=y)
        last = None
        for attempt in range(4):
            try:
                return net.request(url, timeout=30)
            except net.HttpError as e:
                last = e
                if e.status == 404 or e.status == 403:
                    raise
                time.sleep(1.5 * (attempt + 1))
        raise last

    def png_bytes(self, z, x, y):
        path = None
        if self.cache_dir:
            path = os.path.join(self.cache_dir, "%d-%d-%d.png" % (z, x, y))
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    return f.read()
        data = self._fetch(z, x, y)
        if path:
            os.makedirs(self.cache_dir, exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)
        return data

    def tile(self, z, x, y):
        key = (z, x, y)
        t = self.tiles.get(key)
        if t is None:
            w, h, ch, px = decode_png(self.png_bytes(z, x, y))
            if w != 256 or h != 256 or ch < 3:
                raise PNGError("unexpected Terrarium tile shape %dx%dx%d" % (w, h, ch))
            t = terrarium_elevations(w, h, ch, px)
            self.tiles[key] = t
        return t


def grid_points(lat0, lat1, lon0, lon1, rows, cols):
    """(lat, lon) for each grid sample, row 0 = north (lat1), col 0 = west (lon0)."""
    for r in range(rows):
        lat = lat1 - (lat1 - lat0) * r / (rows - 1)
        for c in range(cols):
            yield lat, lon0 + (lon1 - lon0) * c / (cols - 1)


def pixel_metres(lat, z):
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** z)


def sample_grid(lat0, lat1, lon0, lon1, rows, cols, z, source, progress=None, stats=None):
    """Bilinearly resample Terrarium tiles at zoom z onto the grid. Returns list of floats.

    Single-pixel spikes and pits (a known artefact of some source datasets, e.g. -1300 m pits in
    Sydney at z14) are replaced by the median of their 8 neighbours when they differ from it by
    more than max(50 m, 3 pixel widths). stats["despiked"] counts the pixels fixed."""
    n = 2 ** z
    size = 256
    # which tiles are needed
    xa, ya = lonlat_to_tile(lon0, lat1, z)
    xb, yb = lonlat_to_tile(lon1, lat0, z)
    tx0, tx1 = int(math.floor(xa - 2.0 / size)), int(math.floor(xb + 2.0 / size))
    ty0, ty1 = max(0, int(math.floor(ya - 2.0 / size))), min(n - 1, int(math.floor(yb + 2.0 / size)))
    needed = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    for k, (tx, ty) in enumerate(needed):
        source.tile(z, tx % n, ty)
        if progress:
            progress((k + 1) / float(len(needed)), "Downloading elevation tiles (%d of %d)" % (k + 1, len(needed)))

    gw = n * size
    limit = max(50.0, 3 * pixel_metres((lat0 + lat1) / 2.0, z))
    fixed = {}

    def raw(gx, gy):
        gy = min(max(gy, 0), gw - 1)
        tx, ty = gx // size, gy // size
        t = source.tile(z, tx % n, ty)
        return t[(gy - ty * size) * size + (gx - tx * size)]

    def clean(gx, gy):
        v = fixed.get((gx, gy))
        if v is None:
            v = raw(gx, gy)
            nb = sorted(raw(gx + dx, gy + dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dx or dy)
            med = (nb[3] + nb[4]) / 2.0
            if abs(v - med) > limit:
                v = med
                if stats is not None:
                    stats["despiked"] = stats.get("despiked", 0) + 1
            fixed[(gx, gy)] = v
        return v

    out = []
    for lat, lon in grid_points(lat0, lat1, lon0, lon1, rows, cols):
        fx, fy = lonlat_to_tile(lon, lat, z)
        px, py = fx * size - 0.5, fy * size - 0.5        # pixel centres sit at +0.5
        x0, y0 = int(math.floor(px)), int(math.floor(py))
        ax, ay = px - x0, py - y0
        e00, e10 = raw(x0, y0), raw(x0 + 1, y0)
        e01, e11 = raw(x0, y0 + 1), raw(x0 + 1, y0 + 1)
        if max(e00, e10, e01, e11) - min(e00, e10, e01, e11) > limit:
            e00, e10 = clean(x0, y0), clean(x0 + 1, y0)
            e01, e11 = clean(x0, y0 + 1), clean(x0 + 1, y0 + 1)
        e = (e00 * (1 - ax) + e10 * ax) * (1 - ay) + (e01 * (1 - ax) + e11 * ax) * ay
        out.append(round(e, 1))
    return out
