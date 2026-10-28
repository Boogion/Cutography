"""Shared test helpers: repo path setup, fixture paths, a tiny PNG encoder."""
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURES = os.path.join(HERE, "fixtures")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def fixture(name):
    return os.path.join(FIXTURES, name)


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def filter_row(ft, row, prev, bpp):
    out = bytearray([ft])
    for i, x in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        pred = (0, a, b, (a + b) >> 1, _paeth(a, b, c))[ft]
        out.append((x - pred) & 0xFF)
    return out


def encode_png(width, height, channels, pixels, filters=(0,), split_idat=1):
    """Encode 8-bit pixels; row y uses filters[y % len(filters)]."""
    ctype = {1: 0, 2: 4, 3: 2, 4: 6}[channels]
    stride = width * channels
    raw = bytearray()
    prev = bytearray(stride)
    for y in range(height):
        row = bytearray(pixels[y * stride:(y + 1) * stride])
        raw += filter_row(filters[y % len(filters)], row, prev, channels)
        prev = row
    comp = zlib.compress(bytes(raw), 9)

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, ctype, 0, 0, 0))
    step = max(1, len(comp) // split_idat + 1)
    for i in range(0, len(comp), step):
        out += chunk(b"IDAT", comp[i:i + step])
    return out + chunk(b"IEND", b"")


def terrarium_tile_png(elev_fn, filters=(1, 2, 3, 4, 0)):
    """A 256x256 Terrarium tile whose pixel (col, row) encodes elev_fn(col, row)."""
    px = bytearray()
    for r in range(256):
        for c in range(256):
            v = int(round((elev_fn(c, r) + 32768) * 256))
            px += bytes(((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF))
    return encode_png(256, 256, 3, px, filters)
