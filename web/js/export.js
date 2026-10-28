/* export.js — file writers shared by the photo and map tools. No DOM access.

   Both tools hand over a LayerSet:
     { name, bounds: [x0, y0, x1, y1],           inches, y down (screen orientation)
       origin: 'center' | 'lowerLeft',           where (0, 0) lands in a GDS file
       layers: [{ id, name, hex, paper, loops }] } bottom -> top
   loops are closed polygons [x0, y0, x1, y1, ...] in inches, filled with the even-odd rule:
   a loop inside another loop is a hole, a loop inside a hole is an island, and so on.
   Optional extras (the lithography modes):
     set.unitNm                    nanometres per coordinate unit (absent = inches, 25.4e6; µm sets use 1000)
     layer.gdsLayer, .gdsDatatype  GDS numbers 0..255 (default layer i + 1, datatype 0)
     set.cells {NAME: {polygons, layer, datatype}}, layer.refs [{cell, x, y, dx, dy, cols, rows, rx, ry}]
                                   structure cells placed as GDS arrays (see X.gds)

   Writers:  GDSII (+ KLayout .lyp), PNG (1-bit, indexed, with DPI), TIFF (bilevel, 8-bit, RGB;
   PackBits), BMP (1-bit, 8-bit, 24-bit), and a scale.json manifest. Rasters are drawn row by row with a scanline fill, so
   size is limited only by memory for the compressed output, not by the browser's canvas cap.
   Fill generators: gratings, blazed (staircase) gratings and pillar lattices clipped to a region. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CutExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const X = {};
  const NM_PER_IN = 25.4e6;
  const unitNmOf = set => (set && set.unitNm > 0 ? set.unitNm : NM_PER_IN);
  X.unitNm = unitNmOf;
  // Physical dpi of a raster drawn at ppu pixels per coordinate unit (X.frame's second argument).
  X.physDpi = (set, ppu) => { const u = unitNmOf(set); return u === NM_PER_IN ? ppu : ppu * NM_PER_IN / u; };

  /* ------------------------------------------------------------ geometry */
  X.loopArea = function (p) {
    let a = 0; const n = p.length / 2;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
    return a / 2;
  };
  const reversed = p => { const o = []; for (let i = p.length / 2 - 1; i >= 0; i--) o.push(p[i * 2], p[i * 2 + 1]); return o; };
  function bbox(p) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < p.length; i += 2) { if (p[i] < a) a = p[i]; if (p[i] > c) c = p[i]; if (p[i + 1] < b) b = p[i + 1]; if (p[i + 1] > d) d = p[i + 1]; }
    return [a, b, c, d];
  }
  function inLoop(x, y, p) {
    let ins = false; const n = p.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }
  X.bounds = function (loops) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const l of loops) { const q = bbox(l); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
    return b;
  };

  /* Even-odd loops -> pieces [{outer, holes}]. Nesting depth decides the role: even = solid, odd = hole,
     and each hole belongs to the smallest solid around it. Assumes loops don't cross each other,
     which holds for traced masks and for the map's cut lines. */
  X.loopsToPieces = function (loops) {
    const L = loops.filter(l => l.length >= 6).map(p => ({ p, a: Math.abs(X.loopArea(p)), b: bbox(p) }));
    L.sort((u, v) => v.a - u.a);
    const depth = new Int32Array(L.length), parent = new Int32Array(L.length).fill(-1);
    for (let i = 0; i < L.length; i++) {
      const p = L[i].p, x = (p[0] + p[2]) / 2, y = (p[1] + p[3]) / 2; // midpoint of the first edge: never a shared vertex
      for (let j = 0; j < i; j++) {
        const b = L[j].b;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (inLoop(x, y, L[j].p)) { depth[i]++; if (parent[i] < 0 || L[j].a < L[parent[i]].a) parent[i] = j; }
      }
    }
    const pieces = new Map();
    for (let i = 0; i < L.length; i++) if (depth[i] % 2 === 0) pieces.set(i, { outer: L[i].p, holes: [] });
    for (let i = 0; i < L.length; i++) if (depth[i] % 2 === 1 && pieces.has(parent[i])) pieces.get(parent[i]).holes.push(L[i].p);
    return [...pieces.values()];
  };

  /* One polygon with its holes joined to the outline by zero-width slits (keyholes), because GDSII has
     no holes. Holes are bridged right-most first along a horizontal ray to the nearest edge, so every
     slit only crosses boundary that is already part of the polygon (Eberly's ordering). */
  X.keyhole = function (piece) {
    let poly = [];
    const outer = X.loopArea(piece.outer) >= 0 ? piece.outer : reversed(piece.outer);
    for (let i = 0; i < outer.length; i += 2) poly.push([outer[i], outer[i + 1]]);
    const holes = piece.holes.map(h => {
      const hh = X.loopArea(h) <= 0 ? h : reversed(h);   // opposite turn to the outline
      const pts = []; let mi = 0;
      for (let i = 0; i < hh.length; i += 2) { pts.push([hh[i], hh[i + 1]]); if (hh[i] > pts[mi][0]) mi = pts.length - 1; }
      return { pts, mi, maxX: pts[mi][0] };
    }).sort((a, b) => b.maxX - a.maxX);
    for (const h of holes) {
      const [mx, my] = h.pts[h.mi];
      let best = -1, bx = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((a[1] > my) === (b[1] > my)) continue;
        const x = a[0] + (my - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
        if (x >= mx && x < bx) { bx = x; best = i; }
      }
      if (best < 0) {   // numerically lost the ray: bridge to the nearest vertex instead
        let d = Infinity;
        for (let i = 0; i < poly.length; i++) { const e = (poly[i][0] - mx) ** 2 + (poly[i][1] - my) ** 2; if (e < d) { d = e; best = i; } }
        bx = poly[best][0];
        const P = poly[best], ring = [];
        for (let k = 0; k <= h.pts.length; k++) ring.push(h.pts[(h.mi + k) % h.pts.length]);
        poly = poly.slice(0, best + 1).concat(ring, [P], poly.slice(best + 1));
        continue;
      }
      const P = [bx, my], ring = [];
      for (let k = 0; k <= h.pts.length; k++) ring.push(h.pts[(h.mi + k) % h.pts.length]);
      poly = poly.slice(0, best + 1).concat([P], ring, [P], poly.slice(best + 1));
    }
    const flat = []; for (const q of poly) flat.push(q[0], q[1]);
    return flat;
  };

  // Sutherland–Hodgman clip of a closed loop to one side of an axis line (keep where sign*(v - c) <= 0).
  function clipHalf(p, axis, c, sign) {
    const out = [], n = p.length / 2;
    const inside = i => sign * (p[i * 2 + axis] - c) <= 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ai = inside(i), aj = inside(j);
      if (ai) out.push(p[i * 2], p[i * 2 + 1]);
      if (ai !== aj) {
        const t = (c - p[i * 2 + axis]) / (p[j * 2 + axis] - p[i * 2 + axis]);
        out.push(p[i * 2] + t * (p[j * 2] - p[i * 2]), p[i * 2 + 1] + t * (p[j * 2 + 1] - p[i * 2 + 1]));
      }
    }
    return out;
  }
  // Split a polygon into parts of at most maxPts vertices by halving its bounding box.
  X.splitLarge = function (p, maxPts) {
    if (p.length / 2 <= maxPts) return [p];
    const b = bbox(p), axis = (b[2] - b[0]) >= (b[3] - b[1]) ? 0 : 1, c = (b[axis] + b[axis + 2]) / 2;
    const parts = [clipHalf(p, axis, c, 1), clipHalf(p, axis, c, -1)].filter(q => q.length >= 6);
    if (parts.some(q => q.length >= p.length)) return [p]; // no progress: leave it (the writer will refuse it loudly)
    return parts.flatMap(q => X.splitLarge(q, maxPts));
  };

  /* Hole-free decomposition of a piece {outer, holes} (or a plain list of even-odd loops) into simple
     polygons whose union is exactly the piece, for writers that refuse keyholes. Horizontal slabs are cut
     at every vertex y; in each slab the crossing edges, ordered by x, pair up (even-odd) into trapezoids.
     A trapezoid joins the polygon of the one below when each is the other's only neighbour across the
     slab boundary, so every output polygon is y-monotone (one interval per row: no holes, no slits).
     A run along the same left/right edges stays 4 points; a rectangle with a square hole gives 4 polygons,
     a disc gives 1. maxPts (default 8000) caps the points per polygon. Assumes loops don't cross. */
  X.trapezoids = function (piece, maxPts) {
    maxPts = Math.max(8, maxPts || 8000);
    const loops = Array.isArray(piece) ? piece : [piece.outer].concat(piece.holes || []);
    const E = [], ys = [];
    let x0 = Infinity, x1 = -Infinity;
    for (const p of loops) {
      const n = p.length / 2;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
        ys.push(ay); if (ax < x0) x0 = ax; if (ax > x1) x1 = ax;
        if (ay === by) continue;                        // horizontal edges only bound slabs
        E.push(ay < by ? { xa: ax, ya: ay, xb: bx, yb: by, xm: 0 } : { xa: bx, ya: by, xb: ax, yb: ay, xm: 0 });
      }
    }
    if (!E.length) return [];
    ys.sort((a, b) => a - b);
    E.sort((a, b) => a.ya - b.ya);
    const eps = (x1 - x0) * 1e-12;
    // x on an edge at height y, exact at its end points so shared vertices match bit for bit
    const xAt = (e, y) => y === e.ya ? e.xa : y === e.yb ? e.xb : e.xa + (y - e.ya) * (e.xb - e.xa) / (e.yb - e.ya);
    const chains = [];
    const side = (P, e, last, x0_, y0_, x1_, y1_) => {   // extend one side of a chain; returns its edge
      if (e === last) { P[P.length - 2] = x1_; P[P.length - 1] = y1_; return e; }   // same edge: move its end
      if (P[P.length - 2] !== x0_ || P[P.length - 1] !== y0_) P.push(x0_, y0_);
      P.push(x1_, y1_); return e;
    };
    let next = 0, act = [], prev = [], prevY = NaN;
    for (let k = 0; k + 1 < ys.length; k++) {
      const ya = ys[k], yb = ys[k + 1];
      if (yb === ya) continue;
      while (next < E.length && E[next].ya <= ya) act.push(E[next++]);
      act = act.filter(e => e.yb > ya);
      const ym = (ya + yb) / 2;
      for (const e of act) e.xm = xAt(e, ym);
      for (let i = 1; i < act.length; i++) {             // insertion sort: the order barely changes between slabs
        const e = act[i]; let q = i - 1;
        while (q >= 0 && act[q].xm > e.xm) { act[q + 1] = act[q]; q--; }
        act[q + 1] = e;
      }
      const cur = [];
      for (let q = 0; q + 1 < act.length; q += 2) {
        const l = act[q], r = act[q + 1];
        const t = { l, r, xl0: xAt(l, ya), xl1: xAt(l, yb), xr0: xAt(r, ya), xr1: xAt(r, yb), dn: null, nDn: 0, nUp: 0, ch: null };
        if (t.xr0 - t.xl0 <= eps && t.xr1 - t.xl1 <= eps) continue;
        cur.push(t);
      }
      // neighbours across y = ya: both lists are sorted and disjoint, so walk them together
      if (prevY === ya) {
        let i = 0, j = 0;
        while (i < prev.length && j < cur.length) {
          const a = prev[i], b = cur[j];
          if (Math.min(a.xr1, b.xr0) - Math.max(a.xl1, b.xl0) > eps) { a.nUp++; b.nDn++; b.dn = a; }
          if (a.xr1 < b.xr1) i++; else j++;
        }
      }
      for (const t of cur) {
        const c = t.nDn === 1 && t.dn.nUp === 1 ? t.dn.ch : null;
        if (c && c.L.length / 2 + c.R.length / 2 + 4 <= maxPts) {
          c.el = side(c.L, t.l, c.el, t.xl0, ya, t.xl1, yb);
          c.er = side(c.R, t.r, c.er, t.xr0, ya, t.xr1, yb);
          t.ch = c;
        } else {
          t.ch = { L: [t.xl0, ya, t.xl1, yb], R: [t.xr0, ya, t.xr1, yb], el: t.l, er: t.r };
          chains.push(t.ch);
        }
      }
      prev = cur; prevY = yb;
    }
    const out = [];
    for (const c of chains) {
      const p = c.L.slice();
      for (let i = c.R.length - 2; i >= 0; i -= 2) p.push(c.R[i], c.R[i + 1]);
      const q = [];                                      // drop repeated points (pointed tops and bottoms)
      for (let i = 0; i < p.length; i += 2) if (!q.length || p[i] !== q[q.length - 2] || p[i + 1] !== q[q.length - 1]) q.push(p[i], p[i + 1]);
      while (q.length >= 4 && q[0] === q[q.length - 2] && q[1] === q[q.length - 1]) q.length -= 2;
      if (q.length >= 6) out.push(q);
    }
    return out;
  };

  /* ------------------------------------------------------------ fills */
  /* Gratings and lattices are worked out in a frame turned by angleDeg: u runs along the lines (or the
     lattice rows), v across them: u = x cos a + y sin a, v = -x sin a + y cos a. The angle turns from +x
     toward +y of the input coordinates (y down in a LayerSet: clockwise on screen); 0 = lines along x.
     Every pattern is phase-locked to (0, 0), so neighbouring regions with the same settings line up.
     Nothing is ever tested per line point or per site: each line or lattice row is one sweep step. */
  function stripSweep(loops, c, s) {
    const E = [];
    let vmin = Infinity, vmax = -Infinity;
    for (const p of loops) {
      const n = p.length / 2;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ua = p[i * 2] * c + p[i * 2 + 1] * s, va = -p[i * 2] * s + p[i * 2 + 1] * c;
        const ub = p[j * 2] * c + p[j * 2 + 1] * s, vb = -p[j * 2] * s + p[j * 2 + 1] * c;
        E.push(va <= vb ? { v0: va, v1: vb, u0: ua, u1: ub } : { v0: vb, v1: va, u0: ub, u1: ua });
        if (va < vmin) vmin = va; if (va > vmax) vmax = va;
      }
    }
    E.sort((a, b) => a.v0 - b.v0);
    const uAt = (e, v) => v === e.v0 ? e.u0 : v === e.v1 ? e.u1 : e.u0 + (v - e.v0) * (e.u1 - e.u0) / (e.v1 - e.v0);
    let next = 0, act = [];
    /* Where the band lo <= v <= hi lies inside the region, keeping pad from its boundary: the even-odd
       inside spans of the centre line v = vc, minus the u-range of every edge passing through the open
       band, each widened by pad. A rectangle [u0, u1] x [lo, hi] from the result has no boundary inside it
       and its centre line inside, so it is inside (with pad to spare when lo, hi were widened by pad).
       Calls must come in non-decreasing lo. Returns [u0, u1, u0, u1, ...], sorted. */
    function runs(vc, lo, hi, pad) {
      while (next < E.length && E[next].v0 <= hi) act.push(E[next++]);
      act = act.filter(e => e.v1 > lo);
      const xs = [], bad = [];
      for (const e of act) {
        if (e.v0 <= vc && vc < e.v1) xs.push(uAt(e, vc));
        const a = Math.max(e.v0, lo), b = Math.min(e.v1, hi);
        if (e.v0 === e.v1 ? lo < e.v0 && e.v0 < hi : a < b) {
          const ua = e.v0 === e.v1 ? e.u0 : uAt(e, a), ub = e.v0 === e.v1 ? e.u1 : uAt(e, b);
          bad.push([Math.min(ua, ub) - pad, Math.max(ua, ub) + pad]);
        }
      }
      xs.sort((a, b) => a - b);
      bad.sort((a, b) => a[0] - b[0]);
      const M = [];                                      // merged forbidden ranges
      for (const r of bad) { if (M.length && r[0] <= M[M.length - 1][1]) { if (r[1] > M[M.length - 1][1]) M[M.length - 1][1] = r[1]; } else M.push(r); }
      const out = [];
      let m = 0;
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const a = xs[q], b = xs[q + 1];
        while (m < M.length && M[m][1] <= a) m++;
        let cur = a;
        for (let k = m; k < M.length && M[k][0] < b; k++) { if (M[k][0] > cur) out.push(cur, M[k][0]); if (M[k][1] > cur) cur = M[k][1]; }
        if (cur < b) out.push(cur, b);
      }
      return out;
    }
    return { runs, vmin, vmax, empty: !E.length };
  }

  // Strips from + k*period <= v <= from + k*period + width, clipped as described above, as rectangles.
  function strips(loops, period, from, width, o) {
    const a = (o.angleDeg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const inset = Math.max(0, o.edgeInset || 0), minLen = Math.max(0, o.minLength || 0), out = [];
    const S = stripSweep(loops, c, s);
    if (!(period > 0) || !(width > 0) || S.empty) return out;
    const k0 = Math.floor((S.vmin - from - width - inset) / period), k1 = Math.ceil((S.vmax - from + inset) / period);
    if (k1 - k0 > 2e7) throw new Error(`A grating of period ${period} over this region would have ${k1 - k0} lines`);
    for (let k = k0; k <= k1; k++) {
      const v0 = from + k * period, v1 = v0 + width, r = S.runs((v0 + v1) / 2, v0 - inset, v1 + inset, inset);
      for (let q = 0; q < r.length; q += 2) {
        const u0 = r[q], u1 = r[q + 1];
        if (u1 - u0 <= 0 || u1 - u0 < minLen) continue;
        out.push(u0 * c - v0 * s, u0 * s + v0 * c, u1 * c - v0 * s, u1 * s + v0 * c, u1 * c - v1 * s, u1 * s + v1 * c, u0 * c - v1 * s, u0 * s + v1 * c);
      }
    }
    const loopsOut = [];
    for (let i = 0; i < out.length; i += 8) loopsOut.push(out.slice(i, i + 8));
    return loopsOut;
  }

  /* Line grating inside the even-odd region of loops: lines of `width` every `period`, line k covering
     k*period + phase <= v <= k*period + phase + width (v across the lines, see above). Each line keeps
     the parts where its whole width is inside the region with edgeInset to spare (so neighbouring regions
     keep a gap), parts shorter than minLength are dropped. Returns rectangles as loops, same units. */
  X.fillGrating = function (loops, o) {
    return strips(loops, o.period, o.phase || 0, o.width, o);
  };
  /* Staircase (blazed) grating: `steps` strips per period, step j covering
     [k*period + j*period/steps, k*period + (j+1)*period/steps] across the lines, clipped as in fillGrating.
     Returns one loop list per step (the caller gives each its own dose). */
  X.blazedGrating = function (loops, o) {
    const n = Math.max(1, Math.round(o.steps || 2)), w = o.period / n, out = [];
    for (let j = 0; j < n; j++) out.push(strips(loops, o.period, (o.phase || 0) + j * w, w, o));
    return out;
  };
  /* Lattice sites inside the even-odd region of loops, as runs along the lattice rows:
     [{x, y, dx, dy, n}] = n sites at (x + m*dx, y + m*dy), m = 0..n-1 (a GDS AREF with rows = 1).
     Square lattice: sites (i*pitch, j*pitch) in the turned frame; hex: rows pitch*sqrt(3)/2 apart, odd rows
     shifted by pitch/2. A site is kept when the square of half-size keepOut around it (in the turned frame)
     is entirely inside the region. runs.sites = total number of sites. */
  X.fillLattice = function (loops, o) {
    const pitch = o.pitch, hex = o.lattice === 'hex', a = (o.angleDeg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const ko = Math.max(0, o.keepOut || 0), h = hex ? pitch * Math.sqrt(3) / 2 : pitch, out = [];
    out.sites = 0;
    const S = stripSweep(loops, c, s);
    if (!(pitch > 0) || S.empty) return out;
    const j0 = Math.ceil(S.vmin / h), j1 = Math.floor(S.vmax / h);
    if (j1 - j0 > 2e7) throw new Error(`A lattice of pitch ${pitch} over this region would have ${j1 - j0} rows`);
    const dx = pitch * c, dy = pitch * s;
    for (let j = j0; j <= j1; j++) {
      const v = j * h, off = hex && (j & 1) ? pitch / 2 : 0, r = S.runs(v, v - ko, v + ko, ko);
      let last = null, lastI = 0;
      for (let q = 0; q < r.length; q += 2) {
        const i0 = Math.ceil((r[q] - off) / pitch), i1 = Math.floor((r[q + 1] - off) / pitch);
        if (i1 < i0) continue;
        out.sites += i1 - i0 + 1;
        if (last && lastI + 1 === i0) { last.n += i1 - i0 + 1; lastI = i1; continue; }
        const u = i0 * pitch + off;
        last = { x: u * c - v * s, y: u * s + v * c, dx, dy, n: i1 - i0 + 1 }; lastI = i1;
        out.push(last);
      }
    }
    return out;
  };
  // Regular n-gon (default 32) approximating a circle, counter-clockwise in x-right y-up terms.
  X.circleLoop = function (cx, cy, r, n) {
    n = Math.max(3, n || 32);
    const o = [];
    for (let i = 0; i < n; i++) { const t = 2 * Math.PI * i / n; o.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); }
    return o;
  };

  /* ------------------------------------------------------------ GDSII */
  // GDSII 8-byte real: sign bit, 7-bit excess-64 base-16 exponent, 56-bit mantissa.
  function real8(v) {
    const out = new Uint8Array(8);
    if (v === 0) return out;
    let sign = 0; if (v < 0) { sign = 0x80; v = -v; }
    let exp = 64;
    while (v >= 1) { v /= 16; exp++; }
    while (v < 1 / 16) { v *= 16; exp--; }
    out[0] = sign | exp;
    const hi = Math.floor(v * 2 ** 24), lo = Math.floor((v * 2 ** 24 - hi) * 2 ** 32);   // truncate, as other GDS writers do
    out[1] = (hi >>> 16) & 255; out[2] = (hi >>> 8) & 255; out[3] = hi & 255;
    out[4] = (lo >>> 24) & 255; out[5] = (lo >>> 16) & 255; out[6] = (lo >>> 8) & 255; out[7] = lo & 255;
    return out;
  }
  X._real8 = real8;

  function GdsWriter() {
    const parts = []; let size = 0;
    const rec = (type, dtype, body) => {
      const len = 4 + (body ? body.length : 0);
      if (len > 65534) throw new Error('GDS record too long (' + len + ' bytes)');
      const h = new Uint8Array(4); h[0] = len >> 8; h[1] = len & 255; h[2] = type; h[3] = dtype;
      parts.push(h); size += 4;
      if (body && body.length) { parts.push(body); size += body.length; }
    };
    const int2 = arr => { const b = new Uint8Array(arr.length * 2), dv = new DataView(b.buffer); arr.forEach((v, i) => dv.setInt16(i * 2, v)); return b; };
    const int4 = arr => { const b = new Uint8Array(arr.length * 4), dv = new DataView(b.buffer); arr.forEach((v, i) => dv.setInt32(i * 4, v)); return b; };
    const ascii = s => { s = String(s).replace(/[^\x20-\x7e]/g, '_'); if (s.length % 2) s += '\0'; const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };
    return {
      header: () => rec(0x00, 0x02, int2([600])),
      bgnlib: d => rec(0x01, 0x02, int2(d.concat(d))),
      libname: s => rec(0x02, 0x06, ascii(s)),
      units: (user, db) => { const b = new Uint8Array(16); b.set(real8(user), 0); b.set(real8(db), 8); rec(0x03, 0x05, b); },
      bgnstr: d => rec(0x05, 0x02, int2(d.concat(d))),
      strname: s => rec(0x06, 0x06, ascii(s)),
      boundary: (layer, dt, xy) => { rec(0x08, 0x00); rec(0x0D, 0x02, int2([layer])); rec(0x0E, 0x02, int2([dt])); rec(0x10, 0x03, int4(xy)); rec(0x11, 0x00); },
      sref: (name, xy) => { rec(0x0A, 0x00); rec(0x12, 0x06, ascii(name)); rec(0x10, 0x03, int4(xy)); rec(0x11, 0x00); },
      aref: (name, cols, rows, xy) => { rec(0x0B, 0x00); rec(0x12, 0x06, ascii(name)); rec(0x13, 0x02, int2([cols, rows])); rec(0x10, 0x03, int4(xy)); rec(0x11, 0x00); },
      text: (layer, x, y, s) => { rec(0x0C, 0x00); rec(0x0D, 0x02, int2([layer])); rec(0x16, 0x02, int2([0])); rec(0x10, 0x03, int4([x, y])); rec(0x19, 0x06, ascii(s)); rec(0x11, 0x00); },
      endstr: () => rec(0x07, 0x00),
      endlib: () => rec(0x04, 0x00),
      bytes: () => { const out = new Uint8Array(size); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
    };
  }

  /* LayerSet -> GDSII bytes. One top cell; sheet i (bottom = 1) goes on layer i, datatype 0, unless the
     layer gives gdsLayer / gdsDatatype. Units: 1 database unit = 1 nm, 1 user unit = 1 µm, true physical
     size from set.unitNm (default inches). Y is flipped to GDS's y-up; set.origin picks where (0, 0) lands.
     set.cells {NAME: {polygons: [loops, cell-local units, even-odd], layer, datatype}} become structures
     written before the top cell (layer/datatype default to the first set layer that places them).
     layer.refs [{cell, x, y, dx, dy, cols, rows, rx, ry}] place a cell cols x rows times: site (c, r) at
     (x + c*dx + r*rx, y + c*dy + r*ry) in set units, written as AREF (SREF for a single site). They go
     through the same transform as polygons, so on a y-down set a step (dx, dy) becomes (dx, -dy) nm*unitNm
     in the file. AREF steps are integers in the file: a step that isn't a whole number of database units
     (after grid snapping) drifts, so arrays are cut into pieces whose sites stay within opts.arrayTol
     (database units, default = grid) of their exact place, on top of rounding each piece's origin to the
     grid. Integer steps (e.g. a 300 nm pitch at 0°) never cut; a 300 nm pitch at 7° (step 297.76 nm) gives
     arrays of 3 at the default, so pass a larger arrayTol or pick such angles knowingly. Arrays are also
     cut at 32767 columns/rows.
     opts: {cellName, layerOf(i) -> number, labels (bool: a text label per layer outside the art),
            grid (database units: snap every coordinate to multiples of it; collapsed polygons are dropped),
            holes: 'keyhole' (default: holes joined to the outline by slits) | 'split' (X.trapezoids, no slits),
            arrayTol} */
  X.gds = function (set, opts) {
    opts = opts || {};
    const MAX_PTS = 8000;   // XY record limit is 8191 points including the closing one
    const u = unitNmOf(set), grid = Math.max(1, Math.round(opts.grid || 1)), split = opts.holes === 'split';
    const q = grid > 1 ? v => Math.round(v / grid) * grid : Math.round;
    const b = set.bounds, ox = set.origin === 'center' ? (b[0] + b[2]) / 2 : b[0], oy = set.origin === 'center' ? (b[1] + b[3]) / 2 : b[3];
    const T = (x, y) => [q((x - ox) * u), q((oy - y) * u)];
    const now = new Date(), d = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()];
    const w = GdsWriter();
    w.header(); w.bgnlib(d); w.libname(gdsName(set.name || 'LAYERS') + '.DB'); w.units(1e-3, 1e-9);
    const nums = gdsNumbers(set, opts), used = new Set(), topName = uniqueName(gdsName(opts.cellName || set.name || 'TOP'), used);

    // even-odd loops -> boundaries on one layer/datatype; returns [polygons, points]
    const emit = (loops, layerNo, dt, Tf, what) => {
      let polys = 0, pts = 0;
      for (const pc of X.loopsToPieces(loops)) {
        for (const whole of split ? X.trapezoids(pc, MAX_PTS) : [X.keyhole(pc)]) {
          for (const part of X.splitLarge(whole, MAX_PTS)) {
            const xy = [];
            let px = null, py = null;
            for (let k = 0; k < part.length; k += 2) {
              const [x, y] = Tf(part[k], part[k + 1]);
              if (x === px && y === py) continue;      // rounding can merge neighbours
              xy.push(x, y); px = x; py = y;
            }
            while (xy.length >= 4 && xy[0] === xy[xy.length - 2] && xy[1] === xy[xy.length - 1]) xy.length -= 2;
            if (xy.length < 6) continue;
            let a2 = 0;                                  // collapsed to a line by rounding or snapping: drop
            for (let k = 0; k < xy.length; k += 2) { const k2 = (k + 2) % xy.length; a2 += xy[k] * xy[k2 + 1] - xy[k2] * xy[k + 1]; }
            if (a2 === 0) continue;
            if (xy.length / 2 > 8190) throw new Error(`${what}: a polygon kept ${xy.length / 2} points after splitting`);
            xy.push(xy[0], xy[1]);
            w.boundary(layerNo, dt, xy); polys++; pts += xy.length / 2;
          }
        }
      }
      return [polys, pts];
    };

    // structure cells first: cell-local coordinates, same scale and y flip, no origin shift
    const cells = set.cells || {}, cellName = {};
    for (const key of Object.keys(cells)) {
      const C = cells[key], dflt = cellDefaults(set, nums, key);
      cellName[key] = uniqueName(gdsName(key), used);
      w.bgnstr(d); w.strname(cellName[key]);
      emit(C.polygons || [], C.layer != null ? C.layer : dflt[0], C.datatype != null ? C.datatype : dflt[1], (x, y) => [q(x * u), q(-y * u)], 'Cell ' + key);
      w.endstr();
    }

    const tol = opts.arrayTol != null ? opts.arrayTol : grid;
    const place = r => {   // one ref -> AREF/SREF records; returns [records, instances]
      const name = cellName[r.cell];
      if (!name) throw new Error(`Reference to unknown cell "${r.cell}"`);
      const cols = Math.max(1, Math.round(r.cols || 1)), rows = Math.max(1, Math.round(r.rows || 1));
      const X0 = (r.x - ox) * u, Y0 = (oy - r.y) * u;                       // exact, database units
      const cv = [(r.dx || 0) * u, -(r.dy || 0) * u], rv = [(r.rx || 0) * u, -(r.ry || 0) * u];
      const ci = cv.map(q), ri = rv.map(q);
      const run = (n, e, ei) => { const err = Math.hypot(ei[0] - e[0], ei[1] - e[1]); return Math.min(32767, n, err > 0 ? Math.floor(tol / 2 / err) + 1 : n); };
      const nc = run(cols, cv, ci), nr = run(rows, rv, ri);
      // a 1-long direction still needs a non-zero vector in the file
      const cvec = ci[0] || ci[1] ? ci : ri[0] || ri[1] ? [-ri[1], ri[0]] : [grid, 0];
      const rvec = ri[0] || ri[1] ? ri : [-cvec[1], cvec[0]];
      let recs = 0;
      for (let c0 = 0; c0 < cols; c0 += nc) for (let r0 = 0; r0 < rows; r0 += nr) {
        const mc = Math.min(nc, cols - c0), mr = Math.min(nr, rows - r0);
        const px = q(X0 + c0 * cv[0] + r0 * rv[0]), py = q(Y0 + c0 * cv[1] + r0 * rv[1]);
        if (mc === 1 && mr === 1) w.sref(name, [px, py]);
        else w.aref(name, mc, mr, [px, py, px + mc * cvec[0], py + mc * cvec[1], px + mr * rvec[0], py + mr * rvec[1]]);
        recs++;
      }
      return [recs, cols * rows];
    };

    w.bgnstr(d); w.strname(topName);
    const stats = [];
    const lab = u === NM_PER_IN ? [0.15, 0.12] : [0.05, 0.04].map(f => f * Math.max(b[2] - b[0], b[3] - b[1]));
    set.layers.forEach((L, i) => {
      const [layerNo, dt] = nums[i];
      const [polys, pts] = emit(L.loops || [], layerNo, dt, T, 'Layer ' + L.name);
      let refs = 0, instances = 0;
      for (const r of L.refs || []) { const [n, m] = place(r); refs += n; instances += m; }
      if (opts.labels) { const [x, y] = T(b[0], b[3] + lab[0] + i * lab[1]); w.text(layerNo, x, y, `L${layerNo} ${L.name}`); }
      stats.push({ layer: layerNo, datatype: dt, name: L.name, polygons: polys, points: pts, refs, instances });
    });
    w.endstr(); w.endlib();
    const bytes = w.bytes();
    bytes.stats = stats;
    return bytes;
  };
  const gdsName = s => (String(s).toUpperCase().replace(/[^A-Z0-9_$?]+/g, '_').replace(/^_+|_+$/g, '') || 'TOP').slice(0, 32);
  X.gdsName = gdsName;
  function uniqueName(n, used) {
    let s = n;
    for (let k = 2; used.has(s); k++) s = n.slice(0, 31 - String(k).length) + '_' + k;
    used.add(s); return s;
  }
  // [layer, datatype] for every set layer: the layer's own gdsLayer/gdsDatatype, else layerOf(i) or i + 1, and 0.
  function gdsNumbers(set, opts) {
    const num = (v, what, L) => {
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`Layer ${L.name}: ${what} must be a whole number from 0 to 255 (got ${v})`);
      return v;
    };
    return set.layers.map((L, i) => [
      L.gdsLayer != null ? num(L.gdsLayer, 'gdsLayer', L) : opts && opts.layerOf ? opts.layerOf(i) : i + 1,
      L.gdsDatatype != null ? num(L.gdsDatatype, 'gdsDatatype', L) : 0]);
  }
  // A cell without its own layer/datatype takes those of the first set layer that places it (else 1/0).
  function cellDefaults(set, nums, key) {
    const i = set.layers.findIndex(L => (L.refs || []).some(r => r.cell === key));
    return i >= 0 ? nums[i] : [1, 0];
  }

  /* KLayout layer properties: names and paper colors for each GDS layer/datatype, the same numbers X.gds
     writes (cells on a layer/datatype no set layer uses get their own entry).
     In KLayout: File > Load Layer Properties, or put it next to the .gds with the same name. */
  X.lyp = function (set, opts) {
    opts = opts || {};
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const entry = (n, dt, name, hex) => ' <properties>\n' +
      `  <frame-color>${hex}</frame-color>\n  <fill-color>${hex}</fill-color>\n` +
      '  <frame-brightness>-40</frame-brightness>\n  <fill-brightness>0</fill-brightness>\n' +
      '  <dither-pattern>I0</dither-pattern>\n  <line-style/>\n  <valid>true</valid>\n  <visible>true</visible>\n' +
      '  <transparent>false</transparent>\n  <width>1</width>\n  <marked>false</marked>\n  <xfill>false</xfill>\n  <animation>0</animation>\n' +
      `  <name>${esc(String(n).padStart(2, '0') + (dt ? '/' + dt : '') + ' ' + name)}</name>\n  <source>${n}/${dt}@1</source>\n </properties>\n`;
    const nums = gdsNumbers(set, opts), seen = new Set();
    let s = '<?xml version="1.0" encoding="utf-8"?>\n<layer-properties>\n';
    set.layers.forEach((L, i) => { s += entry(nums[i][0], nums[i][1], L.name, L.hex); seen.add(nums[i].join('/')); });
    for (const key of Object.keys(set.cells || {})) {
      const C = set.cells[key], dflt = cellDefaults(set, nums, key), n = C.layer != null ? C.layer : dflt[0], dt = C.datatype != null ? C.datatype : dflt[1];
      if (seen.has(n + '/' + dt)) continue;
      seen.add(n + '/' + dt);
      const user = set.layers.find(L => (L.refs || []).some(r => r.cell === key));
      s += entry(n, dt, 'cell ' + gdsName(key), user ? user.hex : '#808080');
    }
    return s + '</layer-properties>\n';
  };

  /* ------------------------------------------------------------ rasterizer */
  /* Scanline even-odd fill of a set of loops onto a pixel grid, one row at a time, top to bottom.
     frame: {x0, y0, dpi, width, height, mirror}. spans(j) returns [i0, i1, i0, i1, ...] inclusive. */
  function Scanner(loops, f) {
    const edges = [];
    for (const p of loops) {
      const n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let ax = (p[i * 2] - f.x0) * f.dpi, ay = (p[i * 2 + 1] - f.y0) * f.dpi, bx = (p[j * 2] - f.x0) * f.dpi, by = (p[j * 2 + 1] - f.y0) * f.dpi;
        if (f.mirror) { ax = f.width - ax; bx = f.width - bx; }
        if (ay === by) continue;
        if (ay > by) { let t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; }
        edges.push({ y0: ay, y1: by, x0: ax, k: (bx - ax) / (by - ay) });
      }
    }
    edges.sort((a, b) => a.y0 - b.y0);
    let next = 0, active = [];
    const xs = [];
    this.spans = function (j) {
      const yc = j + 0.5;
      while (next < edges.length && edges[next].y0 <= yc) active.push(edges[next++]);
      active = active.filter(e => e.y1 > yc);
      xs.length = 0;
      for (const e of active) if (e.y0 <= yc) xs.push(e.x0 + (yc - e.y0) * e.k);
      xs.sort((a, b) => a - b);
      const out = [];
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil(xs[q] - 0.5)), i1 = Math.min(f.width - 1, Math.ceil(xs[q + 1] - 0.5) - 1);
        if (i1 >= i0) out.push(i0, i1);
      }
      return out;
    };
  }
  X.Scanner = Scanner;

  /* Pixel frame for a LayerSet at a given dpi: really pixels per coordinate unit, which is dpi for inch
     sets. For other units, X.physDpi(set, ppu) gives the dpi to record in the image files. */
  X.frame = function (set, dpi, mirror) {
    const b = set.bounds;
    return { x0: b[0], y0: b[1], dpi, width: Math.max(1, Math.round((b[2] - b[0]) * dpi)), height: Math.max(1, Math.round((b[3] - b[1]) * dpi)), mirror: !!mirror };
  };
  // Pixel frame with square pixels of pixelNm nanometres.
  X.frameForPixel = (set, pixelNm, mirror) => X.frame(set, unitNmOf(set) / pixelNm, mirror);
  /* Pixels per metre for the PNG/BMP headers: opts.ppm when given, else from opts.dpi without going through
     0.0254 (10 nm pixels = 2.54e6 dpi = exactly 1e8 px/m). */
  const ppmOf = o => o.ppm > 0 ? Math.round(o.ppm) : Math.round((o.dpi || 72) * 1e4 / 254);
  X._ppm = ppmOf;

  /* Row sources. Each returns {width, height, rowBytes, row(j) -> Uint8Array} for one image kind.
     - mask:  1 bit per pixel, MSB first, bit set where the layer has paper (invert flips it).
     - label: 1 byte per pixel, value = 1 + index of the top-most layer covering the pixel, 0 = empty.
     - rgb:   3 bytes per pixel, layer colors stacked bottom to top over `background`. */
  X.maskRows = function (loops, f, invert) {
    const sc = new Scanner(loops, f), rowBytes = Math.ceil(f.width / 8), buf = new Uint8Array(rowBytes);
    return {
      width: f.width, height: f.height, rowBytes,
      row(j) {
        buf.fill(invert ? 255 : 0);
        const s = sc.spans(j);
        for (let q = 0; q < s.length; q += 2) for (let i = s[q]; i <= s[q + 1]; i++) buf[i >> 3] ^= 0x80 >> (i & 7);
        if (invert && f.width % 8) buf[rowBytes - 1] &= (0xff << (8 - f.width % 8)) & 0xff;
        return buf;
      }
    };
  };
  X.labelRows = function (set, f) {
    const scs = set.layers.map(L => new Scanner(L.loops, f)), buf = new Uint8Array(f.width);
    return {
      width: f.width, height: f.height, rowBytes: f.width,
      row(j) {
        buf.fill(0);
        scs.forEach((sc, li) => { const s = sc.spans(j); for (let q = 0; q < s.length; q += 2) buf.fill(li + 1, s[q], s[q + 1] + 1); });
        return buf;
      }
    };
  };
  X.rgbRows = function (set, f, background) {
    const lab = X.labelRows(set, f), buf = new Uint8Array(f.width * 3);
    const lut = [hexRgb(background || '#ffffff')].concat(set.layers.map(L => hexRgb(L.hex)));
    return {
      width: f.width, height: f.height, rowBytes: f.width * 3,
      row(j) {
        const l = lab.row(j);
        for (let i = 0; i < f.width; i++) { const c = lut[l[i]]; buf[i * 3] = c[0]; buf[i * 3 + 1] = c[1]; buf[i * 3 + 2] = c[2]; }
        return buf;
      }
    };
  };
  function hexRgb(hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  X.hexRgb = hexRgb;

  // Yield to the page every so often so progress can paint during long exports.
  const tick = () => new Promise(r => setTimeout(r, 0));

  /* ------------------------------------------------------------ PNG */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bufs) { let c = 0xffffffff; for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function chunk(type, data) {
    const t = new Uint8Array(4); for (let i = 0; i < 4; i++) t[i] = type.charCodeAt(i);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
    const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32([t, data]));
    return [len, t, data, crc];
  }
  const u32 = (...v) => { const b = new Uint8Array(v.length * 4), dv = new DataView(b.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x)); return b; };

  /* rows: a row source. kind: 'gray1' | 'index1' | 'index8' | 'rgb'.
     palette: [[r,g,b], ...] for index kinds; transparent: palette indices drawn transparent. */
  X.png = async function (rows, opts) {
    if (typeof CompressionStream === 'undefined') throw new Error('This browser cannot compress PNGs (no CompressionStream). Use a current Chrome, Edge, Firefox or Safari.');
    const kind = opts.kind;
    const depth = kind === 'gray1' || kind === 'index1' ? 1 : 8, ct = kind === 'gray1' ? 0 : kind === 'rgb' ? 2 : 3;
    const out = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
    const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, rows.width); dv.setUint32(4, rows.height); ihdr[8] = depth; ihdr[9] = ct; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    out.push(...chunk('IHDR', ihdr));
    if (ct === 3) {
      const pal = opts.palette, pl = new Uint8Array(pal.length * 3);
      pal.forEach((c, i) => { pl[i * 3] = c[0]; pl[i * 3 + 1] = c[1]; pl[i * 3 + 2] = c[2]; });
      out.push(...chunk('PLTE', pl));
      if (opts.transparent && opts.transparent.length) {
        const tr = new Uint8Array(pal.length).fill(255); for (const i of opts.transparent) tr[i] = 0;
        out.push(...chunk('tRNS', tr));
      }
    }
    if (opts.dpi || opts.ppm) { const ppm = Math.min(0xffffffff, ppmOf(opts)), p = new Uint8Array(9); new DataView(p.buffer).setUint32(0, ppm); new DataView(p.buffer).setUint32(4, ppm); p[8] = 1; out.push(...chunk('pHYs', p)); }
    if (opts.text) for (const [k, v] of Object.entries(opts.text)) { const s = k + '\0' + String(v).replace(/[^\x20-\x7e\n]/g, '?'); out.push(...chunk('tEXt', Uint8Array.from(s, c => c.charCodeAt(0)))); }

    const cs = new CompressionStream('deflate'), writer = cs.writable.getWriter();
    const collected = [];
    const reading = (async () => { const rd = cs.readable.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; collected.push(value); } })();
    const line = new Uint8Array(rows.rowBytes + 1);
    for (let j = 0; j < rows.height; j++) {
      line[0] = 0; line.set(rows.row(j), 1);
      writer.write(line.slice());
      if ((j & 255) === 255) { if (opts.onProgress) opts.onProgress((j + 1) / rows.height); await tick(); }
    }
    await writer.close(); await reading;
    // Pack the compressed stream into IDAT chunks of up to 1 MB.
    let pending = [], pendingLen = 0;
    const flush = () => { if (!pendingLen) return; const d = new Uint8Array(pendingLen); let o = 0; for (const p of pending) { d.set(p, o); o += p.length; } out.push(...chunk('IDAT', d)); pending = []; pendingLen = 0; };
    for (const c of collected) { pending.push(c); pendingLen += c.length; if (pendingLen >= 1 << 20) flush(); }
    flush();
    out.push(...chunk('IEND', new Uint8Array(0)));
    if (opts.onProgress) opts.onProgress(1);
    return new Blob(out, { type: 'image/png' });
  };

  /* ------------------------------------------------------------ TIFF */
  function packBits(src) {
    const out = []; let i = 0; const n = src.length;
    while (i < n) {
      let run = 1;
      while (i + run < n && run < 128 && src[i + run] === src[i]) run++;
      if (run >= 2) { out.push(257 - run, src[i]); i += run; continue; }
      let j = i + 1;
      while (j < n && j - i < 128 && !(j + 1 < n && src[j] === src[j + 1])) j++;
      out.push(j - i - 1); for (let k = i; k < j; k++) out.push(src[k]); i = j;
    }
    return Uint8Array.from(out);
  }
  X._packBits = packBits;

  /* Baseline little-endian TIFF, PackBits strips. kind: 'bilevel' (1-bit, 1 = white) | 'gray8' | 'rgb'. */
  X.tiff = async function (rows, opts) {
    const kind = opts.kind, spp = kind === 'rgb' ? 3 : 1, bps = kind === 'bilevel' ? 1 : 8;
    const rowsPerStrip = Math.max(1, Math.floor(65536 / rows.rowBytes));
    const strips = [];
    let raw = new Uint8Array(rows.rowBytes * rowsPerStrip), fill = 0;
    for (let j = 0; j < rows.height; j++) {
      raw.set(rows.row(j), fill * rows.rowBytes); fill++;
      if (fill === rowsPerStrip || j === rows.height - 1) {
        // PackBits works row by row: runs must not cross scanlines
        const parts = []; let len = 0;
        for (let r = 0; r < fill; r++) { const p = packBits(raw.subarray(r * rows.rowBytes, (r + 1) * rows.rowBytes)); parts.push(p); len += p.length; }
        const s = new Uint8Array(len); let o = 0; for (const p of parts) { s.set(p, o); o += p.length; }
        strips.push(s); fill = 0;
      }
      if ((j & 255) === 255) { if (opts.onProgress) opts.onProgress((j + 1) / rows.height); await tick(); }
    }
    const enc = s => Uint8Array.from(String(s).replace(/[^\x20-\x7e\n]/g, '?') + '\0', c => c.charCodeAt(0));
    const desc = enc(opts.description || ''), soft = enc('Cutography');
    const tags = [];   // [tag, type, count, value(s) | {bytes}]
    tags.push([254, 4, 1, 0]);
    tags.push([256, 4, 1, rows.width]);
    tags.push([257, 4, 1, rows.height]);
    tags.push([258, 3, spp, spp === 1 ? bps : { shorts: [8, 8, 8] }]);
    tags.push([259, 3, 1, 32773]);
    tags.push([262, 3, 1, kind === 'rgb' ? 2 : 1]);
    if (opts.description) tags.push([270, 2, desc.length, { bytes: desc }]);
    tags.push([273, 4, strips.length, { offsets: true }]);
    tags.push([277, 3, 1, spp]);
    tags.push([278, 4, 1, rowsPerStrip]);
    tags.push([279, 4, strips.length, { longs: strips.map(s => s.length) }]);
    const dpi = opts.ppm > 0 ? opts.ppm * 0.0254 : opts.dpi || 72;
    tags.push([282, 5, 1, { rational: dpi }]);
    tags.push([283, 5, 1, { rational: dpi }]);
    tags.push([284, 3, 1, 1]);
    tags.push([296, 3, 1, 2]);
    tags.push([305, 2, soft.length, { bytes: soft }]);
    // layout: header | strips | IFD | out-of-line values
    let off = 8; const stripOff = []; for (const s of strips) { stripOff.push(off); off += s.length; if (off & 1) off++; }
    const ifdOff = off, ifdLen = 2 + tags.length * 12 + 4;
    let extraOff = ifdOff + ifdLen; const extras = [];
    const ifd = new Uint8Array(ifdLen), dv = new DataView(ifd.buffer);
    dv.setUint16(0, tags.length, true);
    tags.forEach(([tag, type, count, v], i) => {
      const p = 2 + i * 12; dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, count, true);
      let bytes = null;
      if (typeof v === 'number') { if (type === 3) dv.setUint16(p + 8, v, true); else dv.setUint32(p + 8, v, true); return; }
      if (v.offsets) { if (count === 1) { dv.setUint32(p + 8, stripOff[0], true); return; } bytes = new Uint8Array(count * 4); const d2 = new DataView(bytes.buffer); stripOff.forEach((o, k) => d2.setUint32(k * 4, o, true)); }
      else if (v.longs) { if (count === 1) { dv.setUint32(p + 8, v.longs[0], true); return; } bytes = new Uint8Array(count * 4); const d2 = new DataView(bytes.buffer); v.longs.forEach((o, k) => d2.setUint32(k * 4, o, true)); }
      else if (v.shorts) { bytes = new Uint8Array(v.shorts.length * 2); const d2 = new DataView(bytes.buffer); v.shorts.forEach((o, k) => d2.setUint16(k * 2, o, true)); }
      else if (v.rational) {   // n/1000, with a smaller denominator when n would overflow (nm-sized pixels)
        let den = 1000; while (den > 1 && v.rational * den > 0xffffffff) den /= 10;
        bytes = new Uint8Array(8); const d2 = new DataView(bytes.buffer); d2.setUint32(0, Math.min(0xffffffff, Math.round(v.rational * den)), true); d2.setUint32(4, den, true);
      }
      else if (v.bytes) { if (v.bytes.length <= 4) { ifd.set(v.bytes, p + 8); return; } bytes = v.bytes; }
      dv.setUint32(p + 8, extraOff, true); extras.push(bytes); extraOff += bytes.length; if (extraOff & 1) { extras.push(new Uint8Array(1)); extraOff++; }
    });
    const head = new Uint8Array(8); head.set([0x49, 0x49, 42, 0]); new DataView(head.buffer).setUint32(4, ifdOff, true);
    const parts = [head];
    for (const s of strips) { parts.push(s); if (s.length & 1) parts.push(new Uint8Array(1)); }
    parts.push(ifd, ...extras);
    if (opts.onProgress) opts.onProgress(1);
    return new Blob(parts, { type: 'image/tiff' });
  };

  /* ------------------------------------------------------------ BMP */
  /* Uncompressed Windows bitmap. kind: 'gray1' (1-bit, 1 = white) | 'index8' (palette) | 'rgb' (24-bit).
     Rows are stored bottom-up and padded to 4 bytes, so the whole image is held until the end. */
  X.bmp = async function (rows, opts) {
    const kind = opts.kind, bpp = kind === 'gray1' ? 1 : kind === 'index8' ? 8 : 24;
    const palette = kind === 'gray1' ? [[0, 0, 0], [255, 255, 255]] : kind === 'index8' ? opts.palette : [];
    const stride = Math.ceil(rows.width * bpp / 32) * 4, dataSize = stride * rows.height;
    const offset = 14 + 40 + palette.length * 4, fileSize = offset + dataSize;
    if (fileSize > 0xffffffff) throw new Error('This image would be larger than 4 GB, the BMP limit. Use PNG or TIFF, or a lower resolution.');
    const head = new Uint8Array(offset), dv = new DataView(head.buffer);
    head[0] = 0x42; head[1] = 0x4d; dv.setUint32(2, fileSize, true); dv.setUint32(10, offset, true);
    dv.setUint32(14, 40, true); dv.setInt32(18, rows.width, true); dv.setInt32(22, rows.height, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, bpp, true); dv.setUint32(30, 0, true); dv.setUint32(34, dataSize, true);
    const ppm = Math.min(0x7fffffff, ppmOf(opts)); dv.setInt32(38, ppm, true); dv.setInt32(42, ppm, true);   // int32: fine down to ~0.5 nm pixels
    dv.setUint32(46, palette.length, true); dv.setUint32(50, 0, true);
    palette.forEach((c, i) => { head[54 + i * 4] = c[2]; head[55 + i * 4] = c[1]; head[56 + i * 4] = c[0]; });
    const lines = new Array(rows.height);
    for (let j = 0; j < rows.height; j++) {
      const src = rows.row(j), line = new Uint8Array(stride);
      if (bpp === 24) for (let i = 0; i < rows.width; i++) { line[i * 3] = src[i * 3 + 2]; line[i * 3 + 1] = src[i * 3 + 1]; line[i * 3 + 2] = src[i * 3]; }
      else line.set(src.subarray(0, Math.min(src.length, stride)));
      lines[rows.height - 1 - j] = line;
      if ((j & 255) === 255) { if (opts.onProgress) opts.onProgress((j + 1) / rows.height); await tick(); }
    }
    if (opts.onProgress) opts.onProgress(1);
    return new Blob([head].concat(lines), { type: 'image/bmp' });
  };

  /* ------------------------------------------------------------ manifest */
  X.manifest = function (set, info) {
    const f = info.frame, u = unitNmOf(set), dpi = X.physDpi(set, f.dpi), nums = gdsNumbers(set);
    return JSON.stringify({
      generator: 'Cutography', created: new Date().toISOString(), project: set.name,
      dpi, inchesPerPixel: 1 / dpi, micrometresPerPixel: 25400 / dpi, nanometresPerPixel: u / f.dpi, widthPx: f.width, heightPx: f.height,
      widthIn: f.width / dpi, heightIn: f.height / dpi, mirrored: f.mirror, inverted: !!info.invert,
      boundsIn: u === NM_PER_IN ? set.bounds : set.bounds.map(v => v * u / NM_PER_IN), unitNm: u,
      note: 'Pixel (0,0) is the top-left of boundsIn. Layers are listed bottom to top; in label images pixel value = layer number of the top-most layer, 0 = no paper.',
      layers: set.layers.map((L, i) => ({ number: i + 1, id: L.id, name: L.name, paper: L.paper || L.name, hex: L.hex, gdsLayer: nums[i][0], gdsDatatype: nums[i][1], files: (info.files && info.files[i]) || [] }))
    }, null, 1);
  };

  // Rough output sizes so the UI can warn before a long export.
  X.estimate = function (set, dpi) {
    const f = X.frame(set, dpi);
    return { width: f.width, height: f.height, megapixels: f.width * f.height / 1e6, rgbMB: f.width * f.height * 3 / 1e6, maskMB: f.width * f.height / 8 / 1e6 };
  };

  return X;
});
