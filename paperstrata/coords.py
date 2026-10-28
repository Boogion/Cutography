"""Parse coordinates the way people paste them from Google Maps and Google Earth.

    parse("35.93201, -84.30970")            -> (35.93201, -84.3097, "decimal")
    parse('35°55\'55.2"N 84°18\'34.9"W')     -> (35.932, -84.30969..., "dms")
    parse("https://www.google.com/maps/@35.93201,-84.30970,15z") -> (..., "url")

Raises CoordError with a message meant for the person who pasted the text.
"""
import re
from urllib.parse import unquote_plus


class CoordError(ValueError):
    pass


_NUM = r"[-+]?\d+(?:\.\d+)?"

# Google Maps / Earth URL forms, most specific first. !3d!4d is the dropped pin; @ is the view.
_URL_PATTERNS = (
    re.compile(r"!3d(" + _NUM + r")!4d(" + _NUM + r")"),
    re.compile(r"[?&](?:q|query|ll|sll|center|destination|daddr|saddr|cbll|viewpoint)=(?:loc:)?\s*(" + _NUM + r")\s*,\s*(" + _NUM + r")"),
    re.compile(r"@(" + _NUM + r"),\s*(" + _NUM + r")"),
    re.compile(r"/(?:place|search|dir)/(" + _NUM + r")\s*,\s*(" + _NUM + r")"),
)

_TOKEN = re.compile(r"""
    (?P<num>[-+]?(?:\d+(?:\.\d*)?|\.\d+))
  | (?P<deg>[°º˚])
  | (?P<min>')
  | (?P<sec>")
  | (?P<hem>[NSEW])
  | (?P<sep>[,;/|])
""", re.X)


def _looks_like_url(s):
    low = s.lower()
    return ("http://" in low or "https://" in low or "google." in low or "goo.gl" in low
            or "maps.app" in low or "!3d" in low or "/@" in low or low.startswith("www."))


def _parse_url(s):
    s = unquote_plus(s)
    for pat in _URL_PATTERNS:
        m = pat.search(s)
        if m:
            return float(m.group(1)), float(m.group(2))
    low = s.lower()
    if "goo.gl" in low or "maps.app" in low:
        raise CoordError("Short Google links don't contain the coordinates. Open the link, then copy "
                         "the full address from the browser bar, or right-click the map and copy the numbers.")
    raise CoordError("That link doesn't contain coordinates. In Google Maps, right-click the spot and "
                     "click the numbers at the top of the menu to copy them, then paste them here.")


def _normalize(s):
    s = s.strip().upper()
    for a, b in (("′", "'"), ("’", "'"), ("‘", "'"), ("`", "'"), ("´", "'"),
                 ("″", '"'), ("”", '"'), ("“", '"'), ("''", '"'),
                 ("−", "-"), ("–", "-"), ("—", "-"), (" ", " ")):
        s = s.replace(a, b)
    # words: drop labels such as "LAT", "LONG:", "DEG" so only single hemisphere letters remain
    s = re.sub(r"\b(?:NORTH|SOUTH|EAST|WEST)\b", lambda m: m.group(0)[0], s)
    s = re.sub(r"\bDEG(?:REES?)?\b|(?<=\d)\s*D(?=\s*\d)", "°", s)
    s = re.sub(r"[A-Z]{2,}", " ", s)
    return s


def _tokens(s):
    out = []
    for m in _TOKEN.finditer(s):
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
    return out


class _Coord(object):
    def __init__(self):
        self.parts = []      # [(value_str, unit)] unit in deg/min/sec
        self.hem = None

    def value(self):
        units = [u for _, u in self.parts]
        if len(set(units)) != len(units):
            raise CoordError("Couldn't read %s: a degree, minute or second value appears twice." % self.text())
        d = m = sec = 0.0
        neg = False
        for v, u in self.parts:
            x = float(v)
            if u == "deg":
                neg = v.startswith("-")
                d = abs(x)
            elif u == "min":
                if x < 0 or x >= 60:
                    raise CoordError("Minutes must be between 0 and 60 (got %s)." % v)
                m = x
            else:
                if x < 0 or x >= 60:
                    raise CoordError("Seconds must be between 0 and 60 (got %s)." % v)
                sec = x
        val = d + m / 60.0 + sec / 3600.0
        if self.hem in ("S", "W"):
            if neg:
                raise CoordError("%s has both a minus sign and %s; use one or the other." % (self.text(), self.hem))
            neg = True
        return -val if neg else val

    def text(self):
        marks = {"deg": "°", "min": "'", "sec": '"'}
        return "".join(v + marks[u] for v, u in self.parts) + (self.hem or "")

    def has_minutes(self):
        return any(u != "deg" for _, u in self.parts)


_NEXT = {None: "deg", "deg": "min", "min": "sec"}


def _group(tokens):
    """Split tokens into coordinates. Returns a list of _Coord."""
    has_marks = any(k in ("deg", "min", "sec") for k, _ in tokens)
    has_hem = any(k == "hem" for k, _ in tokens)
    has_sep = any(k == "sep" for k, _ in tokens)
    nums = [v for k, v in tokens if k == "num"]

    # bare numbers: "a b", "d m d m", "d m s d m s"
    if not has_marks and not has_hem and not has_sep:
        if len(nums) in (2, 4, 6):
            half = len(nums) // 2
            coords = []
            for chunk in (nums[:half], nums[half:]):
                c = _Coord()
                for v, u in zip(chunk, ("deg", "min", "sec")):
                    c.parts.append((v, u))
                coords.append(c)
            return coords

    prefix = bool(tokens) and tokens[0][0] == "hem"
    coords = []
    cur = _Coord()

    def close():
        if cur.parts or cur.hem:
            coords.append(cur)
        return _Coord()

    i = 0
    while i < len(tokens):
        kind, v = tokens[i]
        if kind == "sep":
            cur = close()
        elif kind == "hem":
            if prefix:
                if cur.parts or cur.hem:
                    cur = close()
                cur.hem = v
            else:
                if not cur.parts:
                    raise CoordError("Found the letter %s without a number before it." % v)
                cur.hem = v
                cur = close()
        elif kind == "num":
            unit = None
            if i + 1 < len(tokens) and tokens[i + 1][0] in ("deg", "min", "sec"):
                unit = tokens[i + 1][0]
                i += 1
            last = cur.parts[-1][1] if cur.parts else None
            if unit is None:
                if cur.parts and (last == "sec" or v[0] in "+-"):
                    cur = close()   # a sign only ever starts a new coordinate
                    last = None
                unit = _NEXT[last]
            elif unit == "deg" and cur.parts:
                cur = close()
            elif cur.parts and _order(unit) <= _order(last):
                cur = close()
            cur.parts.append((v, unit))
        else:
            raise CoordError("Found a %s mark without a number before it." % {"deg": "degree", "min": "minute", "sec": "second"}[kind])
        i += 1
    close_last = cur.parts or cur.hem
    if close_last:
        coords.append(cur)
    for c in coords:
        if not c.parts:
            raise CoordError("Found the letter %s without a number after it." % c.hem)
    return coords


def _order(u):
    return {"deg": 0, "min": 1, "sec": 2}.get(u, -1)


def _check(lat, lon):
    if not -90 <= lat <= 90:
        hint = " Did you swap latitude and longitude?" if -180 <= lat <= 180 and -90 <= lon <= 90 else ""
        raise CoordError("Latitude must be between -90 and 90 (got %g).%s" % (lat, hint))
    if not -180 <= lon <= 180:
        raise CoordError("Longitude must be between -180 and 180 (got %g)." % lon)
    return lat, lon


def parse(text):
    """Return (lat, lon, format) with format in "decimal", "dms", "url"."""
    if text is None or not str(text).strip():
        raise CoordError("Paste coordinates or a Google Maps link, for example 35.93201, -84.30970.")
    s = str(text).strip()
    if len(s) > 4000:
        raise CoordError("That text is too long to be a coordinate or a map link.")
    if _looks_like_url(s):
        lat, lon = _parse_url(s)
        lat, lon = _check(lat, lon)
        return lat, lon, "url"

    s = _normalize(s).replace("(", " ").replace(")", " ").replace("[", " ").replace("]", " ")
    tokens = _tokens(s)
    nums = [v for k, v in tokens if k == "num"]
    if len(nums) < 2:
        raise CoordError("Couldn't find two numbers (latitude and longitude) in that text. "
                         "Try something like 35.93201, -84.30970.")
    coords = _group(tokens)
    if len(coords) != 2:
        if len(coords) < 2:
            raise CoordError("Couldn't find two numbers (latitude and longitude) in that text. "
                             "Try something like 35.93201, -84.30970.")
        raise CoordError("Found %d coordinates; paste just one latitude and one longitude." % len(coords))
    a, b = coords
    va, vb = a.value(), b.value()
    lat_h, lon_h = ("N", "S"), ("E", "W")
    if a.hem in lon_h and (b.hem in lat_h or b.hem is None):
        va, vb = vb, va           # written longitude first, e.g. "84.3W 35.9N"
    elif (a.hem in lat_h and b.hem in lat_h) or (a.hem in lon_h and b.hem in lon_h):
        raise CoordError("Both numbers are marked %s/%s; one should be N or S and the other E or W."
                         % (a.hem, b.hem))
    elif a.hem is None and b.hem in lat_h:
        va, vb = vb, va
    lat, lon = _check(va, vb)
    fmt = "dms" if (a.has_minutes() or b.has_minutes()) else "decimal"
    return lat, lon, fmt


def parse_dict(text):
    """API helper: {"ok": True, "lat", "lon", "format"} or {"ok": False, "error"}."""
    try:
        lat, lon, fmt = parse(text)
        return {"ok": True, "lat": round(lat, 7), "lon": round(lon, 7), "format": fmt}
    except CoordError as e:
        return {"ok": False, "error": str(e)}
