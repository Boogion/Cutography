"""Planar geometry in metres: clipping, areas, minimum-area rectangles."""
import math


def dedupe(pts):
    out = []
    for p in pts:
        if not out or p[0] != out[-1][0] or p[1] != out[-1][1]:
            out.append(p)
    return out


def open_ring(pts):
    """Drop a repeated closing point."""
    pts = dedupe(pts)
    if len(pts) > 1 and pts[0][0] == pts[-1][0] and pts[0][1] == pts[-1][1]:
        pts = pts[:-1]
    return pts


def signed_area(ring):
    """Shoelace area of an open or closed ring (positive = counter-clockwise in x-right/y-up)."""
    n = len(ring)
    s = 0.0
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return s / 2.0


def area(ring):
    return abs(signed_area(ring))


def centroid(ring):
    n = float(len(ring))
    return sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n


def clip_polyline(pts, xmin, ymin, xmax, ymax):
    """Clip an open polyline to a rectangle; returns a list of pieces (Liang-Barsky per segment)."""
    pieces, cur = [], []
    for i in range(len(pts) - 1):
        seg = _clip_segment(pts[i], pts[i + 1], xmin, ymin, xmax, ymax)
        if seg is None:
            if len(cur) >= 2:
                pieces.append(cur)
            cur = []
            continue
        a, b, a_in, b_in = seg
        if not cur or not a_in:
            if len(cur) >= 2:
                pieces.append(cur)
            cur = [a]
        cur.append(b)
        if not b_in:
            pieces.append(cur)
            cur = []
    if len(cur) >= 2:
        pieces.append(cur)
    return pieces


def _clip_segment(p, q, xmin, ymin, xmax, ymax):
    x0, y0 = p
    dx, dy = q[0] - x0, q[1] - y0
    t0, t1 = 0.0, 1.0
    for pp, qq in ((-dx, x0 - xmin), (dx, xmax - x0), (-dy, y0 - ymin), (dy, ymax - y0)):
        if pp == 0:
            if qq < 0:
                return None
        else:
            r = qq / pp
            if pp < 0:
                if r > t1:
                    return None
                t0 = max(t0, r)
            else:
                if r < t0:
                    return None
                t1 = min(t1, r)
    a = (x0 + t0 * dx, y0 + t0 * dy)
    b = (x0 + t1 * dx, y0 + t1 * dy)
    return a, b, t0 == 0.0, t1 == 1.0


def clip_polygon(ring, xmin, ymin, xmax, ymax):
    """Sutherland-Hodgman clip of a ring (open or closed) to a rectangle. Returns an open ring."""
    out = open_ring([tuple(p) for p in ring])
    for edge in range(4):
        if not out:
            break
        inp, out = out, []
        n = len(inp)
        for i in range(n):
            cur, prev = inp[i], inp[i - 1]
            cin, pin = _inside(cur, edge, xmin, ymin, xmax, ymax), _inside(prev, edge, xmin, ymin, xmax, ymax)
            if cin:
                if not pin:
                    out.append(_intersect(prev, cur, edge, xmin, ymin, xmax, ymax))
                out.append(cur)
            elif pin:
                out.append(_intersect(prev, cur, edge, xmin, ymin, xmax, ymax))
    return out


def _inside(p, edge, xmin, ymin, xmax, ymax):
    return (p[0] >= xmin, p[0] <= xmax, p[1] >= ymin, p[1] <= ymax)[edge]


def _intersect(a, b, edge, xmin, ymin, xmax, ymax):
    (x0, y0), (x1, y1) = a, b
    if edge < 2:
        x = xmin if edge == 0 else xmax
        t = (x - x0) / (x1 - x0)
        return (x, y0 + t * (y1 - y0))
    y = ymin if edge == 2 else ymax
    t = (y - y0) / (y1 - y0)
    return (x0 + t * (x1 - x0), y)


def convex_hull(pts):
    P = sorted(set((p[0], p[1]) for p in pts))
    if len(P) < 3:
        return P

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in P:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(P):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


def min_rect(pts):
    """Minimum-area bounding rectangle: (centre [x, y], length, width, angle in degrees).

    length >= width; angle is the direction of the long side in -90..90 measured from +x
    toward +y (the convention the map page uses)."""
    H = convex_hull(pts)
    if len(H) < 3:
        if len(H) == 2:
            (ax, ay), (bx, by) = H
            return ([round((ax + bx) / 2, 1), round((ay + by) / 2, 1)], round(math.hypot(bx - ax, by - ay), 1),
                    0.0, round(math.degrees(math.atan2(by - ay, bx - ax)), 1))
        return [round(H[0][0], 1), round(H[0][1], 1)], 0.0, 0.0, 0.0
    best = None
    for i in range(len(H)):
        a, b = H[i], H[(i + 1) % len(H)]
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        c, s = math.cos(ang), math.sin(ang)
        xs = [p[0] * c + p[1] * s for p in H]
        ys = [-p[0] * s + p[1] * c for p in H]
        A = (max(xs) - min(xs)) * (max(ys) - min(ys))
        if best is None or A < best[0]:
            cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
            best = (A, (cx * c - cy * s, cx * s + cy * c), max(xs) - min(xs), max(ys) - min(ys), math.degrees(ang))
    _, cen, L, W, ang = best
    if W > L:
        L, W, ang = W, L, ang + 90
    return [round(cen[0], 1), round(cen[1], 1)], round(L, 1), round(W, 1), round(((ang + 90) % 180) - 90, 1)
