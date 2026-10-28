/* map.js — "Mask Set": real terrain, streets and water as a stack of cardstock wafers, drawn like a
   photomask set. Depends on engine.js, palettes.js, export.js, export-ui.js; JSZip optional.

   The map data (a "site") comes from the local app: GET api/sites/<id>, in the format described in
   docs/site-format.md. A site may name an add-on script (site.extrasScript) that registers
   window.MaskSetExtras[site.id] = {controls, items(ctx), lettering(ctx), placard(ctx)} for features
   specific to that place. An add-on may also list `options` (extra settings it draws in the Buildings
   section), `defaults` and `status(M)` (extra words for the status line).

   Coordinates: wafer inches, origin at the wafer centre, x right, y down (screen).
   Fine raster pitch GF = 1/48 in; terrain is quantised on a coarser grid (k fine pixels per cell). */
(function () {
  'use strict';
  const E = CutEngine, P = CutPalettes;
  let SITE = null, EXTRA = null;
  const $ = id => document.getElementById(id);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const GF = 1 / 48;

  /* ------------------------------------------------------------ settings */
  const S = {
    palette: 'white', levels: 8, spacing: 'height', geom: 'octi', grid: 4, orient: 'north', wafer: '200',
    frame: null, mount: 'top', mainShape: 'trace', water: true, sea: true, streetDetail: 'all', streetPaper: 'Silver Holo', waterPaper: 'Blue Holo', mainPaper: 'Light Gray', mainCount: 8, dense: true, bclass: {}, roads: true,
    align: true, fields: true, gauge: true, north: true, lettering: true,
    ring: 0.5, smooth: 1.0, minArea: 0.03, view: 'stack', explode: 0.6
  };

  /* ------------------------------------------------------------ paper */
  function paper(name) {
    for (const p of P.DEFAULT_PACKS) for (const c of p.colors) if (c.name === name) return { name, hex: c.hex, pack: p.name, material: p.material, finish: p.finish };
    return { name, hex: '#cccccc', pack: '', material: 'Medium Cardstock - 80 lb', finish: '' };
  }
  const pick = (list, n) => Array.from({ length: n }, (_, i) => paper(list[Math.min(list.length - 1, Math.round(i * (list.length - 1) / Math.max(1, n - 1)))]));
  const PALETTES = {
    white: { name: 'White relief', note: 'All white cardstock; shadows draw the terrain and foil lights the streets.', sheets: n => Array.from({ length: n }, () => paper('White')) },
    oxide: { name: 'Oxide colors', note: 'Sheets follow the interference colors of thermal oxide on silicon, thinnest at the bottom.',
      sheets: n => ['Peach', 'Rose Gold Holo', 'Purple', 'Blue', 'Sky Blue', 'Butter Yellow', 'Gold Holo', 'Orange', 'Pink Holo', 'Blue Holo', 'Light Aqua', 'Pastel Green'].slice(0, n).map(paper) },
    greens: { name: 'Topo greens', note: 'Classic hypsometric tint: valley floor dark, ridge tops pale.',
      sheets: n => pick(['Dark Green', 'Pine Green', 'Grass Green', 'Olive', 'Sage Green', 'Pastel Green', 'Mint', 'Ivory', 'White'], n) }
  };

  /* ------------------------------------------------------------ small geometry helpers */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function area(p) { let a = 0; const n = p.length / 2; for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; } return a / 2; }
  function reverse(p) { const o = []; for (let i = p.length / 2 - 1; i >= 0; i--) o.push(p[i * 2], p[i * 2 + 1]); return o; }
  const ccw = p => area(p) > 0 ? reverse(p) : p;   // holes
  const cw = p => area(p) < 0 ? reverse(p) : p;    // solids
  function rectLoop(cx, cy, w, h) { const a = w / 2, b = h / 2; return [cx - a, cy - b, cx + a, cy - b, cx + a, cy + b, cx - a, cy + b]; }
  function plusLoop(cx, cy, arm, wid) {
    const a = arm, w = wid / 2;
    return [cx - w, cy - a, cx + w, cy - a, cx + w, cy - w, cx + a, cy - w, cx + a, cy + w, cx + w, cy + w, cx + w, cy + a, cx - w, cy + a, cx - w, cy + w, cx - a, cy + w, cx - a, cy - w, cx - w, cy - w];
  }
  function rotLoop(p, ang, cx, cy) { const c = Math.cos(ang), s = Math.sin(ang), o = []; for (let i = 0; i < p.length; i += 2) { const x = p[i] - cx, y = p[i + 1] - cy; o.push(cx + x * c - y * s, cy + x * s + y * c); } return o; }

  // Trim every corner of an axis-aligned pixel outline by min(c, half of each adjacent edge):
  // single steps become 45° lines and every edge ends up at 0°, 45° or 90°.
  function octi(pts, c) {   // c: a number, or a function (x, y) -> trim for the corner at that pixel vertex
    const n = pts.length / 2, cf = typeof c === 'function' ? c : () => c;
    if (n < 4) return mergeCollinear(pts.slice());
    const len = new Float64Array(n), t = new Float64Array(n);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; len[i] = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]); }
    let any = false;
    for (let i = 0; i < n; i++) { t[i] = Math.max(0, Math.min(cf(pts[i * 2], pts[i * 2 + 1]), len[(i - 1 + n) % n] / 2, len[i] / 2)); if (t[i] > 0) any = true; }
    if (!any) return mergeCollinear(pts.slice());
    const out = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, L = len[i] || 1;
      const x0 = pts[i * 2], y0 = pts[i * 2 + 1], dx = (pts[j * 2] - x0) / L, dy = (pts[j * 2 + 1] - y0) / L;
      out.push(x0 + dx * t[i], y0 + dy * t[i]);
      if (L - t[i] - t[j] > 1e-6) out.push(x0 + dx * (L - t[j]), y0 + dy * (L - t[j]));
    }
    return mergeCollinear(out);
  }
  function mergeCollinear(p) {
    let pts = p;
    for (let pass = 0; pass < 4; pass++) {
      const n = pts.length / 2; if (n < 4) break;
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n, b = (i + 1) % n;
        const ax = pts[a * 2], ay = pts[a * 2 + 1], x = pts[i * 2], y = pts[i * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
        const cross = (x - ax) * (by - y) - (y - ay) * (bx - x);
        if (Math.abs(cross) < 1e-7) continue;
        out.push(x, y);
      }
      if (out.length === pts.length) break;
      pts = out;
    }
    return pts;
  }
  function simplifyOpen(pts, tol) { // Douglas–Peucker on an open polyline [[x,y],...]
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [s, e] = st.pop(); const [ax, ay] = pts[s], [bx, by] = pts[e];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      let md = -1, mi = -1;
      for (let i = s + 1; i < e; i++) {
        const t = clamp(((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L2, 0, 1);
        const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy);
        if (d > md) { md = d; mi = i; }
      }
      if (md > tol) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  /* ------------------------------------------------------------ raster helpers */
  function fillPoly(mask, W, pts, val) { // pts flat, pixel units; even-odd scanline at pixel centres
    let y0 = Infinity, y1 = -Infinity; const n = pts.length / 2;
    for (let i = 0; i < n; i++) { y0 = Math.min(y0, pts[i * 2 + 1]); y1 = Math.max(y1, pts[i * 2 + 1]); }
    const H = mask.length / W;
    for (let j = Math.max(0, Math.floor(y0)); j <= Math.min(H - 1, Math.ceil(y1)); j++) {
      const yc = j + 0.5, xs = [];
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n, ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[k * 2], by = pts[k * 2 + 1];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + (yc - ay) * (bx - ax) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const i0 = Math.max(0, Math.ceil(xs[q] - 0.5)), i1 = Math.min(W - 1, Math.ceil(xs[q + 1] - 0.5) - 1);
        for (let i = i0; i <= i1; i++) mask[j * W + i] = val;
      }
    }
  }
  function strokeLine(mask, W, pts, hw) { // round-capped thick polyline, pixel units
    const H = mask.length / W;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + hw));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - hw)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + hw));
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
        const px = i + 0.5, py = j + 0.5;
        const t = clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1);
        if ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2 <= hw * hw) mask[j * W + i] = 1;
      }
    }
  }
  function gaussBlur(f, w, h, sigma) {
    if (sigma <= 0) return f;
    const r = Math.ceil(sigma * 3), k = []; let sum = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(f.length), out = new Float32Array(f.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += f[y * w + clamp(x + i, 0, w - 1)] * k[i + r]; tmp[y * w + x] = s; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += tmp[clamp(y + i, 0, h - 1) * w + x] * k[i + r]; out[y * w + x] = s; }
    return out;
  }

  /* ------------------------------------------------------------ site data */
  let DEM_FINE = false, GRID_ANGLE = 0;
  function elevAt(mx, my) {
    const lat = SITE.center[0] - my / SITE.ky, lon = SITE.center[1] + mx / SITE.kx;
    const fine = SITE.demFine, inFine = fine && lat > fine.lat0 && lat < fine.lat1 && lon > fine.lon0 && lon < fine.lon1;
    const DEM = (inFine && DEM_FINE) ? fine : SITE.dem;
    const c = clamp((lon - DEM.lon0) / (DEM.lon1 - DEM.lon0) * (DEM.cols - 1), 0, DEM.cols - 1.0001);
    const r = clamp((DEM.lat1 - lat) / (DEM.lat1 - DEM.lat0) * (DEM.rows - 1), 0, DEM.rows - 1.0001);
    const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, e = DEM.elev, i = r0 * DEM.cols + c0;
    return (e[i] * (1 - fc) + e[i + 1] * fc) * (1 - fr) + (e[i + DEM.cols] * (1 - fc) + e[i + DEM.cols + 1] * fc) * fr;
  }
  // Dominant direction of building edges (mod 90°; streets too when there are few buildings), so a street grid can be laid square to the wafer.
  function gridAngle(site) {
    let sx = 0, sy = 0;
    const add = (p, closed) => {
      const q = closed ? p.concat([p[0]]) : p;
      for (let i = 0; i + 1 < q.length; i++) { const dx = q[i + 1][0] - q[i][0], dy = q[i + 1][1] - q[i][1], L = Math.hypot(dx, dy), a = Math.atan2(dy, dx); sx += L * Math.cos(4 * a); sy += L * Math.sin(4 * a); }
    };
    for (const b of site.buildings) add(b.pts, true);
    if (site.buildings.length < 20) for (const r of site.roads) add(r.pts, false);   // few buildings: let the streets set the grid
    return (sx || sy) ? Math.atan2(sy, sx) / 4 : 0;
  }
  // Switch to another site. The add-on registry is filled by the site's extrasScript, if it has one.
  function setSite(site) {
    SITE = site;
    SITE.buildings = SITE.buildings || []; SITE.roads = SITE.roads || []; SITE.water = SITE.water || []; SITE.mainShapes = SITE.mainShapes || [];
    GRID_ANGLE = gridAngle(SITE);
    EXTRA = (window.MaskSetExtras || {})[SITE.id] || null;
    S.bclass = {};
    S.frame = SITE.frames ? Object.keys(SITE.frames)[0] : null;
    S.streetDetail = SITE.diameterM <= 3000 ? 'all' : SITE.diameterM <= 7000 ? 'major' : 'main';
    S.orient = 'north';
    if (EXTRA && EXTRA.defaults) Object.assign(S, EXTRA.defaults);
  }
  const bName = i => { const b = SITE.buildings[i]; return b.name || (b.ref ? 'Bldg. ' + b.ref : 'Unnamed building'); };
  const centroid = pts => [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  // Streets: main roads always; with "all", every named street too. Unnamed lanes merge into blobs at this scale.
  // Street detail: 'main' (motorway to primary), 'major' (+ secondary), 'all' (+ tertiary and every named street).
  // Cut lines are a fixed width, so wide views need fewer streets or they bury the terrain.
  const MAIN = /^(motorway|trunk|primary)(_link)?$/, MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/, WIDE = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
  const isStreet = r => !r.tunnel && (S.streetDetail === 'main' ? MAIN.test(r.kind) : S.streetDetail === 'major' ? MAJOR.test(r.kind) : (WIDE.test(r.kind) || !!r.name));
  const streetHalfWidth = r => WIDE.test(r.kind) ? 2.6 : 2.1;   // fine-raster pixels
  // The 5x7 stencil font only has A–Z, 0–9 and a little punctuation.
  const ascii = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 .:/-]+/g, ' ').replace(/\s+/g, ' ').trim();

  /* ------------------------------------------------------------ simple shapes (wafer inches) */
  // rect {c, len, wid, ang} · disc {c, r} · annulus {c, r0, r1} · arch {c, r0, r1, a0, a1} · poly {pts}
  // e inflates the shape. pad = true fills ring interiors (for graded pads); otherwise rings just get thicker.
  function inShape(sh, u, v, e, pad) {
    e = (e || 0) + (sh.grow || 0);
    const dx = u - (sh.c ? sh.c[0] : 0), dy = v - (sh.c ? sh.c[1] : 0);
    if (sh.type === 'rsq') {   // rounded-square ring: centreline half-straight s, corner radius R, wall w
      const c = Math.cos(sh.ang), sn = Math.sin(sh.ang), x = Math.abs(dx * c + dy * sn) - sh.s, y = Math.abs(-dx * sn + dy * c) - sh.s;
      const sd = Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) - sh.R;
      return pad || sh.solid ? sd <= sh.w / 2 + e : Math.abs(sd) <= sh.w / 2 + e;
    }
    if (sh.type === 'rect') { const c = Math.cos(sh.ang), sn = Math.sin(sh.ang), x = dx * c + dy * sn, y = -dx * sn + dy * c; return Math.abs(x) <= sh.len / 2 + e && Math.abs(y) <= sh.wid / 2 + e; }
    if (sh.type === 'disc') return Math.hypot(dx, dy) <= sh.r + e;
    if (sh.type === 'annulus') { const d = Math.hypot(dx, dy); return pad ? d <= sh.r1 + e : (d <= sh.r1 + e && d >= sh.r0 - e); }
    if (sh.type === 'arch') {
      const d = Math.hypot(dx, dy); if (d < sh.r0 - e || d > sh.r1 + e) return false;
      const ext = e / Math.max(d, 1e-6), a0 = sh.a0 - ext, span = sh.a1 - sh.a0 + 2 * ext, TAU = 2 * Math.PI;
      return (((Math.atan2(dy, dx) - a0) % TAU) + TAU) % TAU <= span;
    }
    if (sh.type === 'poly') {
      const p = sh.pts, n = p.length / 2; let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) { const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1]; if (((yi > v) !== (yj > v)) && (u < (xj - xi) * (v - yi) / (yj - yi) + xi)) inside = !inside; }
      if (inside || e <= 0) return inside;
      for (let i = 0, j = n - 1; i < n; j = i++) { const ax = p[j * 2], ay = p[j * 2 + 1], ex = p[i * 2] - ax, ey = p[i * 2 + 1] - ay, L2 = ex * ex + ey * ey || 1e-12, t = clamp(((u - ax) * ex + (v - ay) * ey) / L2, 0, 1); if (Math.hypot(u - ax - t * ex, v - ay - t * ey) <= e) return true; }
      return false;
    }
    return false;
  }
  function shapeBox(sh) {
    if (sh.type === 'poly') { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (let i = 0; i < sh.pts.length; i += 2) { a = Math.min(a, sh.pts[i]); c = Math.max(c, sh.pts[i]); b = Math.min(b, sh.pts[i + 1]); d = Math.max(d, sh.pts[i + 1]); } const g = sh.grow || 0; return [a - g, b - g, c + g, d + g]; }
    const h = sh.type === 'rect' ? Math.hypot(sh.len, sh.wid) / 2 : sh.type === 'rsq' ? (sh.s + sh.R + sh.w / 2) * Math.SQRT2 : (sh.r1 || sh.r);
    return [sh.c[0] - h, sh.c[1] - h, sh.c[0] + h, sh.c[1] + h];
  }
  function minRect(P) { // flat [x, y, ...] -> {c, len, wid, ang}
    const pts = []; for (let i = 0; i < P.length; i += 2) pts.push([P[i], P[i + 1]]);
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    const H = lo.slice(0, -1).concat(up.slice(0, -1)); let best = null;
    for (let i = 0; i < H.length; i++) {
      const a = H[i], b = H[(i + 1) % H.length], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), sn = Math.sin(ang);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of H) { const x = p[0] * c + p[1] * sn, y = -p[0] * sn + p[1] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const A = (x1 - x0) * (y1 - y0);
      if (!best || A < best.A) { const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; best = { A, c: [cx * c - cy * sn, cx * sn + cy * c], len: x1 - x0, wid: y1 - y0, ang }; }
    }
    if (best.wid > best.len) { const t = best.len; best.len = best.wid; best.wid = t; best.ang += Math.PI / 2; }
    return best;
  }
  function inLoop(x, y, p) { let ins = false; const n = p.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }
  // traced loops -> pieces, each an outer loop with the holes inside it
  const splitPieces = loops => { const outs = loops.filter(l => area(l) > 0), holes = loops.filter(l => area(l) < 0); return outs.map(o => ({ outer: o, holes: holes.filter(h => inLoop(h[0], h[1], o)) })); };
  // Pack pieces in rows, long side horizontal, inside a band `width` wide centred on the origin.
  function packPieces(pieces, width, gap) {
    const box = ls => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const l of ls) for (let i = 0; i < l.length; i += 2) { a = Math.min(a, l[i]); c = Math.max(c, l[i]); b = Math.min(b, l[i + 1]); d = Math.max(d, l[i + 1]); } return [a, b, c, d]; };
    const rot = l => { const o = []; for (let i = 0; i < l.length; i += 2) o.push(-l[i + 1], l[i]); return o; };
    const items = pieces.map(pc => { let ls = [pc.outer, ...pc.holes], b = box(ls); if ((b[3] - b[1]) > (b[2] - b[0]) * 1.05 || (b[2] - b[0]) > width) { ls = ls.map(rot); b = box(ls); } return { ls, b, w: b[2] - b[0], h: b[3] - b[1] }; });
    items.sort((p, q) => q.h - p.h);
    let x = 0, y = 0, rowH = 0; const placed = [];
    for (const it of items) {
      if (x > 0 && x + it.w > width) { x = 0; y += rowH + gap; rowH = 0; }
      placed.push({ it, dx: x - it.b[0], dy: y - it.b[1] });
      x += it.w + gap; rowH = Math.max(rowH, it.h);
    }
    const total = y + rowH, ox = -width / 2, oy = -total / 2;
    return placed.flatMap(({ it, dx, dy }) => it.ls.map(l => { const o = []; for (let i = 0; i < l.length; i += 2) o.push(l[i] + dx + ox, l[i + 1] + dy + oy); return o; }));
  }
  const unionBox = (shapes, pad) => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const sh of shapes) { const x = shapeBox(sh); b = [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])]; } return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]; };
  // Union of shapes rasterised at 300 dpi, traced and simplified: straight edges stay straight, circles stay round.
  function traceShapes(shapes, e) {
    e = e || 0;
    const hr = 1 / 300, [u0, v0, u1, v1] = unionBox(shapes, 3 / 300 + e);
    const W = Math.ceil((u1 - u0) / hr), H = Math.ceil((v1 - v0) / hr), m = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) { const v = v0 + (j + 0.5) * hr; for (let i = 0; i < W; i++) { const u = u0 + (i + 0.5) * hr; for (const sh of shapes) if (inShape(sh, u, v, e)) { m[j * W + i] = 1; break; } } }
    return E.traceMask(m, W, H).map(l => { const p = E.simplify(l, 1.25), o = []; for (let i = 0; i < p.length; i += 2) o.push(u0 + p[i] * hr, v0 + p[i + 1] * hr); return o; });
  }

  /* ------------------------------------------------------------ model */
  function compute() {
    const D = S.wafer === '200' ? 200 / 25.4 : 150 / 25.4;
    // A site is one circle of ground `diameterM` across, filling the wafer; some sites also name fixed frames.
    const F = (SITE.frames && SITE.frames[S.frame]) || { offset: [0, 0], scale: SITE.diameterM / (D * 0.0254) };
    DEM_FINE = !!F.dem;
    const scale = F.scale;
    const R = D / 2, Rin = R - S.ring, Rmid = (R + Rin) / 2;
    const k = S.grid, NF = Math.ceil((D + 0.25) / GF / 12) * 12, NC = NF / k;
    const mPerIn = scale * 0.0254;
    const theta = S.orient === 'grid' ? GRID_ANGLE : 0;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const off = F.offset;
    const toGround = (u, v) => [off[0] + mPerIn * (u * cosT - v * sinT), off[1] + mPerIn * (u * sinT + v * cosT)];
    const toWafer = (mx, my) => { const x = mx - off[0], y = my - off[1]; return [(x * cosT + y * sinT) / mPerIn, (-x * sinT + y * cosT) / mPerIn]; };
    const toPx = (u, v) => [u / GF + NF / 2, v / GF + NF / 2];
    const fromPx = (x, y) => [(x - NF / 2) * GF, (y - NF / 2) * GF];

    // --- coarse terrain
    const innerC = new Uint8Array(NC * NC), seaC = new Uint8Array(NC * NC);
    let elevC = new Float32Array(NC * NC);
    for (let cj = 0; cj < NC; cj++) for (let ci = 0; ci < NC; ci++) {
      const [u, v] = fromPx(ci * k + k / 2, cj * k + k / 2);
      const g = toGround(u, v);
      elevC[cj * NC + ci] = elevAt(g[0], g[1]);
      innerC[cj * NC + ci] = Math.hypot(u, v) <= Rin ? 1 : 0;
    }
    // Sea: elevation tiles carry the sea floor as negative heights. Ground at or below 0 m becomes water,
    // and its depth is flattened to the lowest land so the contours describe the land alone.
    if (S.sea) {
      let landMin = Infinity;
      for (let i = 0; i < elevC.length; i++) { if (elevC[i] <= 0) seaC[i] = 1; else if (innerC[i] && elevC[i] < landMin) landMin = elevC[i]; }
      if (landMin === Infinity) landMin = 0;
      for (let i = 0; i < elevC.length; i++) if (seaC[i]) elevC[i] = Math.min(landMin, 0.1);
    }
    elevC = gaussBlur(elevC, NC, NC, S.smooth * 4 / k);
    const inside = []; for (let i = 0; i < NC * NC; i++) if (innerC[i] && !seaC[i]) inside.push(elevC[i]);
    if (!inside.length) throw new Error('This map is all water at this size. Pick a spot with some land, or a larger field of view.');
    inside.sort((a, b) => a - b);
    const eMin = inside[0], eMax = inside[inside.length - 1], N = S.levels;
    const levels = [-Infinity];
    for (let i = 1; i < N; i++) levels.push(S.spacing === 'area' ? inside[Math.floor(inside.length * i / N)] : eMin + (eMax - eMin) * i / N);
    const interval = (eMax - eMin) / N;
    const cellArea = (k * GF) ** 2, minC = Math.max(3, Math.round(S.minArea / cellArea));
    const solidC = [];
    for (let s = 0; s < N; s++) {
      const m = new Uint8Array(NC * NC);
      for (let i = 0; i < m.length; i++) m[i] = !innerC[i] || elevC[i] >= levels[s] ? 1 : 0;
      if (s > 0) {
        for (let pass = 0; pass < 2; pass++) {
          const cc = E.components(m, NC, NC, false);
          for (let c = 0; c < cc.count; c++) if (cc.sizes[c] < minC) for (let q = cc.start[c]; q < cc.start[c + 1]; q++) m[cc.order[q]] = cc.label[c] ? 0 : 1;
          for (let j = 0; j + 1 < NC; j++) for (let i = 0; i + 1 < NC; i++) {
            const a = j * NC + i, b = a + 1, c = a + NC, d = c + 1;
            if (m[a] && m[d] && !m[b] && !m[c]) m[elevC[b] >= elevC[c] ? b : c] = 1;
            else if (m[b] && m[c] && !m[a] && !m[d]) m[elevC[a] >= elevC[d] ? a : d] = 1;
          }
        }
        const prev = solidC[s - 1]; for (let i = 0; i < m.length; i++) m[i] &= prev[i];
      }
      solidC.push(m);
    }
    const NN = NF * NF, innerF = new Uint8Array(NN);
    for (let j = 0; j < NF; j++) for (let i = 0; i < NF; i++) innerF[j * NF + i] = innerC[Math.floor(j / k) * NC + Math.floor(i / k)];
    const ptsPx = pts => { const o = []; for (const [mx, my] of pts) { const w = toWafer(mx, my), p = toPx(w[0], w[1]); o.push(p[0], p[1]); } return o; };
    const lineWafer = pts => pts.map(([mx, my]) => toPx(...toWafer(mx, my)));
    const stats = { main: 0, roads: 0 };

    // --- buildings as simple shapes
    const W_MIN = 0.075, APRON = 0.09, TAU = 2 * Math.PI, FIT = 0.008;
    const toW = p => toWafer(p[0], p[1]);
    const snap = a => { const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2); return Math.abs(a - q) < 12 * Math.PI / 180 ? q : a; };   // nearest 0°/90° within 12°
    const convert = p => {
      if (p.type === 'bar') { const a = toW(p.a), b = toW(p.b); return { type: 'rect', c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len: Math.hypot(b[0] - a[0], b[1] - a[1]), wid: Math.max(p.w / mPerIn, W_MIN), ang: Math.atan2(b[1] - a[1], b[0] - a[0]) }; }
      if (p.type === 'rect') return { type: 'rect', c: toW(p.c), len: Math.max(p.len / mPerIn, W_MIN), wid: Math.max(p.wid / mPerIn, W_MIN), ang: p.ang * Math.PI / 180 - theta };
      if (p.type === 'ring') { const r1 = Math.max(p.r / mPerIn, W_MIN), w = Math.max(p.w / mPerIn, W_MIN); return r1 - w < 0.06 ? { type: 'disc', c: toW(p.c), r: r1 } : { type: 'annulus', c: toW(p.c), r0: r1 - w, r1 }; }
      if (p.type === 'arch') { let r0 = p.r0 / mPerIn, r1 = p.r1 / mPerIn; if (r1 - r0 < W_MIN) { const mid = (r0 + r1) / 2; r0 = mid - W_MIN / 2; r1 = mid + W_MIN / 2; } return { type: 'arch', c: toW(p.c), r0, r1, a0: p.a0 * Math.PI / 180 - theta, a1: p.a1 * Math.PI / 180 - theta }; }
      return null;
    };
    const fits = shapes => { const b = unionBox(shapes, APRON); return Math.max(Math.hypot(b[0], b[1]), Math.hypot(b[2], b[1]), Math.hypot(b[0], b[3]), Math.hypot(b[2], b[3])) < Rin - 0.05; };
    const items = [];
    const MODE = S.mount === 'inlay' ? 'piece' : S.mount;           // 'top' | 'piece' | 'via'
    // footprint -> straight-edged polygon in wafer inches; thickened only where too thin to cut
    const footprint = (b, square) => {
      const flat = []; for (const p of b.pts) flat.push(p[0], p[1]);
      const simp = E.simplify(flat, 1.0); let pts = [];
      for (let i = 0; i < simp.length; i += 2) { const w = toWafer(simp[i], simp[i + 1]); pts.push(w[0], w[1]); }
      if (square) {   // turn the footprint about its centre onto the campus grid when it is within 8°
        const m0 = minRect(pts), d = snap(m0.ang) - m0.ang;
        if (Math.abs(d) > 1e-6 && Math.abs(d) < 8 * Math.PI / 180) pts = rotLoop(pts, d, m0.c[0], m0.c[1]);
        // orthogonalize: edges within 5° of horizontal or vertical become exactly so
        const n = pts.length / 2, tol = Math.tan(5 * Math.PI / 180);
        for (const axis of [1, 0]) for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, dx = pts[j * 2] - pts[i * 2], dy = pts[j * 2 + 1] - pts[i * 2 + 1];
          if (axis === 1 && Math.abs(dy) <= Math.abs(dx) * tol) { const m = (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2; pts[i * 2 + 1] = pts[j * 2 + 1] = m; }
          if (axis === 0 && Math.abs(dx) <= Math.abs(dy) * tol) { const m = (pts[i * 2] + pts[j * 2]) / 2; pts[i * 2] = pts[j * 2] = m; }
        }
      }
      const A = Math.abs(area(pts)); let P = 0; for (let i = 0; i < pts.length; i += 2) { const j = (i + 2) % pts.length; P += Math.hypot(pts[j] - pts[i], pts[j + 1] - pts[i + 1]); }
      const mr = minRect(pts), thick = 2 * A / Math.max(P, 1e-9);           // mean width of the building's wings
      if (mr.wid < W_MIN && mr.len / Math.max(mr.wid, 1e-6) > 4) return { A, mr, sh: { type: 'rect', c: mr.c, len: mr.len, wid: W_MIN, ang: mr.ang } };
      return { A, mr, sh: { type: 'poly', pts, grow: Math.max(0, (W_MIN - thick) / 2) } };
    };
    // Site add-on: hand-built features for one place, placed before and after the landmark buildings.
    const ext = EXTRA && EXTRA.items ? EXTRA.items({ SITE, S, toW, footprint, fits, paper, centroid, mPerIn, W_MIN, MODE, theta }) || {} : {};
    const accel = ext.accel || null;   // kept on the model for add-ons and debugging
    if (ext.before) items.push(...ext.before);
    if (ext.stats) Object.assign(stats, ext.stats);
    const mainOn = new Set();
    if (S.mainCount > 0 && SITE.mainShapes) {
      let auto = 0;
      for (const m of SITE.mainShapes) {
        const cw2 = toW(m.c); if (Math.hypot(cw2[0], cw2[1]) > Rin - 0.25) continue;
        const want = S.bclass[m.i] ? S.bclass[m.i] === 'on' : auto < S.mainCount;
        auto++;
        if (!want) continue;
        const sh = S.mainShape === 'trace' ? footprint(SITE.buildings[m.i], S.orient === 'grid').sh
          : { type: 'rect', c: cw2, len: Math.max(m.len / mPerIn, 0.09), wid: Math.max(m.wid / mPerIn, 0.09), ang: snap(m.ang * Math.PI / 180 - theta) };
        if (sh.type === 'poly' && Math.abs(area(sh.pts)) < 0.004) { sh.grow = Math.max(sh.grow || 0, 0.012); }
        if (!fits([sh])) continue;
        items.push({ kind: 'main', mode: MODE, color: paper(S.mainPaper), name: m.name || 'Building', shapes: [sh], bid: m.i });
        mainOn.add(m.i); stats.main++;
      }
    }
    // add-on items placed after the landmark buildings
    const padCenter = ext.padCenter || null;
    if (ext.after) items.push(...ext.after);
    for (const it of items) it.apron = it.mode === 'top' ? 0.04 : APRON;
    // pads: each item sits on a flat pad (its shape plus an apron); overlapping pads share one level
    const padLabel = new Int32Array(NN).fill(-1), parent = items.map((_, i) => i);
    const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    items.forEach((it, idx) => {
      const [u0, v0, u1, v1] = unionBox(it.shapes, it.apron), [i0, j0] = toPx(u0, v0), [i1, j1] = toPx(u1, v1);
      it.pad = []; it.foot = [];
      for (let j = Math.max(0, Math.floor(j0)); j <= Math.min(NF - 1, Math.ceil(j1)); j++) for (let i = Math.max(0, Math.floor(i0)); i <= Math.min(NF - 1, Math.ceil(i1)); i++) {
        const [u, v] = fromPx(i + 0.5, j + 0.5), q = j * NF + i;
        if (!it.shapes.some(sh => inShape(sh, u, v, it.apron, true))) continue;
        it.pad.push(q);
        if (it.shapes.some(sh => inShape(sh, u, v, 0))) it.foot.push(q);
        if (padLabel[q] >= 0 && find(padLabel[q]) !== find(idx)) parent[find(padLabel[q])] = find(idx);
        padLabel[q] = idx;
      }
    });
    const groupsMap = new Map();
    items.forEach((it, idx) => { const r = find(idx); if (!groupsMap.has(r)) groupsMap.set(r, []); groupsMap.get(r).push(it); });
    const groups = [...groupsMap.values()];
    const inPad = new Uint8Array(NN); for (const it of items) for (const q of it.pad) inPad[q] = 1;
    const bidAll = new Int32Array(NN).fill(-1);
    SITE.buildings.forEach((b, i) => fillPoly(bidAll, NF, ptsPx(b.pts), i));

    // --- traces and marks cut to the foil
    // streets and grid marks cut through to the streets layer; rivers and the pond stop on the water layer
    const via = new Uint8Array(NN), viaStreet = new Uint8Array(NN), viaRiver = new Uint8Array(NN);
    // true paths, simplified to half a pixel (0.01 in): accurate to the mapped centreline
    if (S.roads) for (const r of SITE.roads) {
      if (!isStreet(r)) continue;
      strokeLine(viaStreet, NF, simplifyOpen(lineWafer(r.pts), 0.5), streetHalfWidth(r)); stats.roads++;
    }
    let rivers = 0, seaPx = 0, lakes = 0;
    if (S.water) {
      // lakes and riverbanks: outer rings filled, then islands (inner rings) put back
      // ponds, pools and fountains under ~0.01 in² would be specks; leave them out
      const bigEnough = w => Math.abs(area(w.pts.flat())) / (mPerIn * mPerIn) >= 0.01;
      for (const w of SITE.water) if (w.closed && w.role !== 'inner' && bigEnough(w)) { fillPoly(viaRiver, NF, ptsPx(w.pts), 1); lakes++; }
      for (const w of SITE.water) if (w.closed && w.role === 'inner') fillPoly(viaRiver, NF, ptsPx(w.pts), 0);
      for (const w of SITE.water) {
        if (w.closed || !/^(stream|river|canal)$/.test(w.kind)) continue;
        strokeLine(viaRiver, NF, simplifyOpen(lineWafer(w.pts), 0.5), 2.1); rivers++;
      }
      if (S.sea) for (let j = 0; j < NF; j++) for (let i = 0; i < NF; i++) {
        const q = j * NF + i; if (!innerF[q]) continue;
        const [u, v] = fromPx(i + 0.5, j + 0.5), g = toGround(u, v);
        if (elevAt(g[0], g[1]) <= 0) { viaRiver[q] = 1; seaPx++; }
      }
      const o = E.dilate(E.erode(viaRiver, NF, NF, 1.5), NF, NF, 1.5); for (let q = 0; q < NN; q++) viaRiver[q] = o[q] || (viaRiver[q] && 0);
    }
    stats.rivers = rivers; stats.lakes = lakes; stats.sea = seaPx > 0;
    let fieldCount = 0;
    if (S.fields) {
      const fx = 26 / 25.4, fy = 33 / 25.4, arm = 0.22 / GF, hw = Math.max(0.083 / 2, (k / 2 + 1) * GF) / GF;
      for (let jy = -6; jy <= 6; jy++) for (let ix = -6; ix <= 6; ix++) {
        const u = (ix + 0.5) * fx, v = (jy + 0.5) * fy;
        if (Math.hypot(u, v) > Rin - 0.25) continue;
        const [px, py] = toPx(u, v), t = new Uint8Array(NN);
        fillPoly(t, NF, [px - hw, py - arm, px + hw, py - arm, px + hw, py + arm, px - hw, py + arm], 1);
        fillPoly(t, NF, [px - arm, py - hw, px + arm, py - hw, px + arm, py + hw, px - arm, py + hw], 1);
        let hit = false; for (let q = 0; q < NN && !hit; q++) if (t[q] && inPad[q]) hit = true;
        if (hit) continue;
        for (let q = 0; q < NN; q++) if (t[q]) viaStreet[q] = 1;
        fieldCount++;
      }
    }
    for (let q = 0; q < NN; q++) { if (inPad[q] || !innerF[q]) { viaStreet[q] = 0; viaRiver[q] = 0; } via[q] = viaStreet[q] | viaRiver[q]; }

    // --- fine sheets: terrain + traces
    const minF = Math.round(S.minArea / (GF * GF));
    const papers = [];
    for (let s = 0; s < N; s++) {
      const sc = solidC[s];
      let p = new Uint8Array(NN);
      for (let j = 0; j < NF; j++) for (let i = 0; i < NF; i++) { const q = j * NF + i; p[q] = innerF[q] ? (sc[Math.floor(j / k) * NC + Math.floor(i / k)] && !via[q] ? 1 : 0) : 1; }
      p = E.dilate(E.erode(p, NF, NF, 1.5), NF, NF, 1.5);
      for (let q = 0; q < NN; q++) if (!innerF[q]) p[q] = 1;
      if (s > 0) { const prev = papers[s - 1]; for (let q = 0; q < NN; q++) p[q] &= prev[q]; }
      const cc = E.components(p, NF, NF, false);
      for (let c = 0; c < cc.count; c++) {
        if (cc.sizes[c] >= minF) continue;
        let hasVia = false;
        if (cc.label[c] === 0) for (let q = cc.start[c]; q < cc.start[c + 1]; q++) if (via[cc.order[q]]) { hasVia = true; break; }
        if (hasVia) continue;
        for (let q = cc.start[c]; q < cc.start[c + 1]; q++) { const i = cc.order[q]; p[i] = cc.label[c] ? 0 : (s === 0 || papers[s - 1][i] ? 1 : 0); }
      }
      papers.push(p);
    }
    // --- grade a flat pad for each group at the median ground level under it
    const surfAt = q => { for (let s2 = N - 1; s2 >= 0; s2--) if (papers[s2][q]) return s2; return 0; };
    for (const g of groups) {
      const lv = []; for (const it of g) for (const q of it.foot) lv.push(surfAt(q));
      lv.sort((a, b) => a - b);
      g.level = lv.length ? lv[Math.floor(lv.length / 2)] : 0;
      for (const it of g) for (const q of it.pad) if (innerF[q]) for (let s2 = 0; s2 < N; s2++) papers[s2][q] = s2 <= g.level ? 1 : 0;
    }
    for (let s2 = 0; s2 < N; s2++) {
      let p = E.dilate(E.erode(papers[s2], NF, NF, 1.5), NF, NF, 1.5);
      for (let q = 0; q < NN; q++) if (!innerF[q]) p[q] = 1;
      if (s2 > 0) { const prev = papers[s2 - 1]; for (let q = 0; q < NN; q++) p[q] &= prev[q]; }
      papers[s2] = p;
    }

    // --- vector marks on the ring
    const extras = Array.from({ length: N }, () => []), islandsAdd = new Int32Array(N);
    const occupied = [];
    const ringPos = deg => { const a = deg * Math.PI / 180; return [Rmid * Math.sin(a), -Rmid * Math.cos(a)]; };
    const markRoom = S.ring - 0.14;
    if (S.align) {
      const step = Math.max(0.012, (markRoom - 0.1) / (2 * Math.max(1, N - 1)));
      const [bx, by] = ringPos(270), [cx, cy] = ringPos(90);
      for (let s2 = 0; s2 < N; s2++) {
        const sz = 0.1 + 2 * s2 * step;
        extras[s2].push(ccw(rectLoop(bx, by, sz, sz)));
        extras[s2].push(ccw(plusLoop(cx, cy, sz / 2, 0.08 + 2 * s2 * step * 0.5)));
      }
      occupied.push([262, 278], [82, 98]);
    }
    let gaugeHalfDeg = 0;
    if (S.gauge) {
      const pitch = 0.166, slotW = 0.083, slotH = Math.min(0.18, markRoom), cy = -Rmid;
      for (let i = 0; i < N; i++) {
        const x = (i - (N - 1) / 2) * pitch, loop = ccw(rectLoop(x, cy, slotW, slotH));
        for (let s2 = i; s2 < N; s2++) extras[s2].push(loop);
      }
      gaugeHalfDeg = ((N * pitch) / 2 + 0.08) / Rmid * 180 / Math.PI;
      occupied.push([-gaugeHalfDeg, gaugeHalfDeg]);
    }
    occupied.push([174, 186]);
    let northDeg = null;
    if (S.north) {
      northDeg = ((-theta * 180 / Math.PI) % 360 + 360) % 360;
      const norm = x => ((x % 360) + 360) % 360;
      const clash = d => occupied.some(([a, b]) => norm(d - (a - 6)) <= norm((b + 6) - (a - 6)));
      for (let t = 0; t < 36 && clash(northDeg); t++) northDeg = (northDeg + 5) % 360;
      const [nx, ny] = ringPos(northDeg), a = northDeg * Math.PI / 180, h = 0.2;
      extras[N - 1].push(ccw(rotLoop([nx, ny - h * 0.55, nx + h * 0.45, ny + h * 0.35, nx - h * 0.45, ny + h * 0.35], a, nx, ny)));
      occupied.push([northDeg - 5, northDeg + 5]);
    }

    const chamfer = S.geom === 'octi' ? k / 2 : 0;
    const toIn = loop => { const o = []; for (let i = 0; i < loop.length; i += 2) o.push((loop[i] - NF / 2) * GF, (loop[i + 1] - NF / 2) * GF); return o; };
    // --- building cuts and pieces (exact vector outlines inside their paper aprons)
    const inlayMap = new Map();
    const addPieces = (kind, mode, color, name, b, loops) => {
      const key = kind + '/' + mode;
      if (!inlayMap.has(key)) inlayMap.set(key, { id: kind, mode, name, color, pieces: [] });
      inlayMap.get(key).pieces.push({ b, loops });
    };
    for (const g of groups) {
      const L = g.level;
      const holeShapes = g.filter(it => it.mode !== 'top').flatMap(it => it.shapes);
      if (holeShapes.length) {
        const all = traceShapes(holeShapes, g.some(it => it.mode === 'piece') ? FIT : 0);   // a little clearance so pieces drop in
        for (const l of all) extras[L].push(reverse(l));
        islandsAdd[L] += all.filter(l => area(l) < 0).length;
      }
      const viaShapes = g.filter(it => it.mode === 'via').flatMap(it => it.shapes);
      if (viaShapes.length) {
        const vl = traceShapes(viaShapes);
        for (let s2 = 0; s2 < L; s2++) { for (const l of vl) extras[s2].push(reverse(l)); islandsAdd[s2] += vl.filter(l => area(l) < 0).length; }
      }
      const byKind = new Map();
      for (const it of g) if (it.mode === 'piece' || it.mode === 'top') { const key = it.kind + '/' + it.mode; if (!byKind.has(key)) byKind.set(key, []); byKind.get(key).push(it); }
      for (const its of byKind.values()) {
        const kind = its[0].kind, mode = its[0].mode;
        const nm = its[0].groupName || (kind === 'main' ? 'Buildings' : its[0].name);
        addPieces(kind, mode, its[0].color, nm, mode === 'top' ? L + 1 : L, traceShapes(its.flatMap(it => it.shapes)));
      }
    }
    const inlays = [...inlayMap.values()].map(x => {
      const loopsAll = x.pieces.flatMap(p => p.loops), pcs = splitPieces(loopsAll);
      return { ...x, loopsAll, pieces_n: pcs.length, dense: packPieces(pcs, Math.min(7.4, D - 0.4), 0.08) };
    });
    // stencil for buildings placed on top: one disc with every top piece's outline cut out
    const stencil = [];
    for (const g of groups) { const top = g.filter(it => it.mode === 'top').flatMap(it => it.shapes); if (top.length) for (const pc of splitPieces(traceShapes(top, FIT))) stencil.push(reverse(pc.outer)); }
    // water layer: a full disc with the streets and grid marks cut through it
    let water = null;
    if (S.water && (rivers || lakes || seaPx)) {
      const wh = new Uint8Array(NN); for (let q = 0; q < NN; q++) wh[q] = innerF[q] && viaStreet[q] ? 1 : 0;
      water = { loops: E.traceMask(wh, NF, NF).map(l => toIn(reverse(octi(l, chamfer)))) };
    }

    // --- trace sheets
    const colors = PALETTES[S.palette].sheets(N);
    const sheets = [];
    for (let s2 = 0; s2 < N; s2++) {
      const holes = new Uint8Array(NN);
      for (let q = 0; q < NN; q++) holes[q] = innerF[q] && !papers[s2][q] ? 1 : 0;
      const loops = E.traceMask(holes, NF, NF).map(l => toIn(reverse(octi(l, chamfer))));
      const cc = E.components(papers[s2], NF, NF, false);
      let pieces = islandsAdd[s2]; for (let c = 0; c < cc.count; c++) if (cc.label[c] === 1) pieces++;
      let paperPx = 0; for (let q = 0; q < NN; q++) if (innerF[q] && papers[s2][q]) paperPx++;
      sheets.push({ index: s2, level: levels[s2], color: colors[s2], loops, extras: extras[s2], pieces, holeCount: loops.length, areaIn2: paperPx * GF * GF, name: s2 === 0 ? 'Base' : `${Math.round(levels[s2])} m` });
    }

    // --- ring lettering: stencil letters cut out of the top sheet's border
    let lettering = 0;
    if (S.lettering) {
      const latN = SITE.center[0] - off[1] / SITE.ky, lonE = SITE.center[1] + off[0] / SITE.kx;
      const lat = Math.abs(latN).toFixed(3) + (latN >= 0 ? 'N' : 'S'), lon = Math.abs(lonE).toFixed(3) + (lonE >= 0 ? 'E' : 'W');
      const sk = scale >= 10000 ? Math.round(scale / 1000) + 'K' : (Math.round(scale / 100) / 10) + 'K';
      const ctx = { SITE, S, lat, lon, scale, sk, interval, N };
      let texts;
      if (EXTRA && EXTRA.lettering) texts = EXTRA.lettering(ctx);
      else {
        const name = ascii(SITE.name), words = name.split(' ');
        texts = [
          { v: [name, words.slice(0, 2).join(' '), words[0]], zone: [-84, -6] },
          { v: [`${lat} ${lon}`, lat], zone: [6, 84] },
          { v: [`1:${sk} ${S.wafer}MM`, `1:${sk}`], zone: [96, 176], flip: true },
          { v: [`CI ${Math.round(interval)}M ${N} MASKS`, `${N} MASKS`], zone: [184, 264], flip: true }
        ];
      }
      const maxCell = Math.min(0.04, (S.ring - 0.2) / 7);
      for (const t of texts) lettering += placeArcText(extras[N - 1], t, occupied, Rmid, maxCell);
    }
    return { viaStreet, viaRiver, off, water, accel, stencil, via, bidAll, mainOn, scale, D, R, Rin, Rmid, N, NF, k, levels, interval, eMin, eMax, sheets, inlays, lettering, stats, fieldCount, theta, northDeg, padCenter, papers, innerF, gaugeHalfDeg, groups: groups.map(g => ({ level: g.level, kinds: g.map(it => it.kind), modes: g.map(it => it.mode), items: g.map(it => ({ name: it.name, c: it.shapes[0].c ? it.shapes[0].c.map(v => +v.toFixed(2)) : null, pad: it.pad.length, foot: it.foot.length })) })) };
  }

  /* ------------------------------------------------------------ stencil lettering */
  const FONT = {
    'A': '.###.|#...#|#...#|#####|#...#|#...#|#...#', 'B': '####.|#...#|#...#|####.|#...#|#...#|####.', 'C': '.###.|#...#|#....|#....|#....|#...#|.###.',
    'D': '####.|#...#|#...#|#...#|#...#|#...#|####.', 'E': '#####|#....|#....|####.|#....|#....|#####', 'F': '#####|#....|#....|####.|#....|#....|#....',
    'G': '.###.|#...#|#....|#.###|#...#|#...#|.####', 'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#', 'I': '.###.|..#..|..#..|..#..|..#..|..#..|.###.',
    'J': '..###|...#.|...#.|...#.|...#.|#..#.|.##..', 'K': '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', 'L': '#....|#....|#....|#....|#....|#....|#####',
    'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', 'N': '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#', 'O': '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
    'P': '####.|#...#|#...#|####.|#....|#....|#....', 'Q': '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', 'R': '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
    'S': '.####|#....|#....|.###.|....#|....#|####.', 'T': '#####|..#..|..#..|..#..|..#..|..#..|..#..', 'U': '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
    'V': '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', 'W': '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', 'X': '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
    'Y': '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', 'Z': '#####|....#|...#.|..#..|.#...|#....|#####',
    '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.', '2': '.###.|#...#|....#|...#.|..#..|.#...|#####',
    '3': '#####|...#.|..#..|...#.|....#|#...#|.###.', '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', '5': '#####|#....|####.|....#|....#|#...#|.###.',
    '6': '..##.|.#...|#....|####.|#...#|#...#|.###.', '7': '#####|....#|...#.|..#..|.#...|.#...|.#...', '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
    '9': '.###.|#...#|#...#|.####|....#|...#.|.##..', '.': '.....|.....|.....|.....|.....|.....|..#..', '-': '.....|.....|.....|.###.|.....|.....|.....',
    ':': '.....|..#..|.....|.....|.....|..#..|.....', '/': '.....|....#|...#.|..#..|.#...|#....|.....', ' ': '.....|.....|.....|.....|.....|.....|.....'
  };
  // 5x7 glyph -> cuttable stencil: diagonal-only contacts filled, enclosed counters bridged to the outside.
  const GLYPHS = {};
  function stencilGlyph(ch) {
    if (GLYPHS[ch]) return GLYPHS[ch];
    const rows = (FONT[ch] || FONT[' ']).split('|'), W = 7, H = 9, m = new Uint8Array(W * H);
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (rows[r][c] === '#') m[(r + 1) * W + c + 1] = 1;
    const fixDiagonals = () => {
      let changed = false;
      for (let y = 0; y + 1 < H; y++) for (let x = 0; x + 1 < W; x++) {
        const a = y * W + x, b = a + 1, c = a + W, d = c + 1;
        if (m[a] && m[d] && !m[b] && !m[c]) { m[b] = 1; changed = true; }
        else if (m[b] && m[c] && !m[a] && !m[d]) { m[a] = 1; changed = true; }
      }
      return changed;
    };
    for (let pass = 0; pass < 6; pass++) {
      fixDiagonals();
      // background reachable from outside (4-connected); anything else is a counter that would fall out
      const seen = new Uint8Array(W * H), st = [0]; seen[0] = 1;
      while (st.length) { const q = st.pop(), x = q % W, y = (q / W) | 0; for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) { if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (!seen[n] && !m[n]) { seen[n] = 1; st.push(n); } } }
      let counter = -1;
      for (let q = 0; q < W * H; q++) if (!m[q] && !seen[q]) { counter = q; break; }
      if (counter < 0) break;
      // bridge: carve straight to the nearer edge (top or bottom) from the counter's middle column
      const cx = counter % W, cy = (counter / W) | 0, dir = cy <= 4 ? -1 : 1;
      for (let y = cy + dir; y >= 0 && y < H; y += dir) { const q = y * W + cx; if (seen[q]) break; m[q] = 0; }
    }
    const loops = E.traceMask(m, W, H).map(l => { const o = []; for (let i = 0; i < l.length; i += 2) o.push(l[i] - 1, l[i + 1] - 1); return o; });
    return (GLYPHS[ch] = loops);
  }
  // Places one text item on the ring: tries each variant at the largest cell that fits, down to 0.03 in.
  function placeArcText(out, t, occupied, Rmid, maxCell) {
    let free = [t.zone];
    const occ = [];
    for (const [a, b] of occupied) for (const sh of [-360, 0, 360]) occ.push([a + sh, b + sh]);
    for (const [a, b] of occ) {
      const nf = [];
      for (const [x, y] of free) { if (b <= x || a >= y) nf.push([x, y]); else { if (a > x) nf.push([x, a]); if (b < y) nf.push([b, y]); } }
      free = nf;
    }
    if (!free.length) return 0;
    const [z0, z1] = free.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
    const arcLen = (z1 - z0 - 4) * Math.PI / 180 * Rmid;
    for (const text of t.v) {
      const n = text.length, cell = Math.min(maxCell, arcLen / (n * 6 - 1));
      if (cell < 0.03) continue;
      const L = (n * 6 - 1) * cell, mid = ((z0 + z1) / 2) * Math.PI / 180, dir = t.flip ? -1 : 1, up = t.flip ? -1 : 1;
      text.split('').forEach((ch, i) => {
        if (ch === ' ') return;
        const a = mid + dir * ((i * 6 + 2.5) * cell - L / 2) / Rmid;
        const px = Rmid * Math.sin(a), py = -Rmid * Math.cos(a), tx = Math.cos(a), ty = Math.sin(a), nx = Math.sin(a), ny = -Math.cos(a);
        for (const l of stencilGlyph(ch)) {
          const o = [];
          for (let k = 0; k < l.length; k += 2) {
            const lx = (l[k] - 2.5) * cell * dir, ly = (l[k + 1] - 3.5) * cell * up;
            o.push(px + lx * tx - ly * nx, py + lx * ty - ly * ny);
          }
          out.push(ccw(o));
        }
      });
      return 1;
    }
    return 0;
  }

  /* ------------------------------------------------------------ outlines and paths */
  function outerD(M) {
    const R = M.R, f = v => v.toFixed(4);
    if (S.wafer === '200') {
      const depth = 0.13, hn = depth, yb = Math.sqrt(R * R - hn * hn);
      return `M${f(-hn)} ${f(yb)}A${f(R)} ${f(R)} 0 1 1 ${f(hn)} ${f(yb)}L0 ${f(R - depth)}Z`;
    }
    const hf = (57.5 / 25.4) / 2, yf = Math.sqrt(R * R - hf * hf);
    return `M${f(-hf)} ${f(yf)}A${f(R)} ${f(R)} 0 1 1 ${f(hf)} ${f(yf)}Z`;
  }
  // outerD as a polygon (for GDS and raster exports): the same arc, chords within 0.0005 in of it.
  function outerLoop(M) {
    const R = M.R, half = S.wafer === '200' ? 0.13 : (57.5 / 25.4) / 2, y = Math.sqrt(R * R - half * half);
    const a0 = Math.atan2(y, -half), a1 = Math.atan2(y, half) + 2 * Math.PI;
    const n = Math.ceil((a1 - a0) / (2 * Math.acos(1 - 0.0005 / R))), out = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push(R * Math.cos(a), R * Math.sin(a)); }
    if (S.wafer === '200') out.push(0, R - 0.13);   // notch tip
    return out;
  }
  const loopsD = loops => loops.map(l => { let d = 'M' + l[0].toFixed(4) + ' ' + l[1].toFixed(4); for (let i = 2; i < l.length; i += 2) d += 'L' + l[i].toFixed(4) + ' ' + l[i + 1].toFixed(4); return d + 'Z'; }).join('');
  const sheetD = (M, sh) => outerD(M) + loopsD(sh.loops) + loopsD(sh.extras);

  /* ------------------------------------------------------------ rendering */
  let MODEL = null, cache = {}, LAST_STACK = null;
  function hexRgb(h) { return E.hexToRgb(h); }
  function mix(h1, h2, t) { const a = hexRgb(h1), b = hexRgb(h2); return E.rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t); }
  const isHolo = c => /holo/i.test(c.name) || /foil/i.test(c.finish);
  function fillFor(ctx, color, cx, cy, r) {
    if (!isHolo(color) || !ctx.createConicGradient) return color.hex;
    const g = ctx.createConicGradient(0.7, cx, cy), h = color.hex;
    [[0, h], [0.14, mix(h, '#ffffff', 0.45)], [0.28, mix(h, '#b9e3ff', 0.45)], [0.42, mix(h, '#ffd2ef', 0.4)], [0.56, mix(h, '#fff2c2', 0.45)],
     [0.7, mix(h, '#c9ffd9', 0.35)], [0.84, mix(h, '#ffffff', 0.3)], [1, h]].forEach(([o, c]) => g.addColorStop(o, c));
    return g;
  }
  const BACKER = () => paper(S.streetPaper);
  function tokens() { const cs = getComputedStyle(document.documentElement); return { bg: cs.getPropertyValue('--panel').trim() || '#fbfaf6', ink: cs.getPropertyValue('--ink').trim() || '#221f1b', muted: cs.getPropertyValue('--muted').trim() || '#6f685c' }; }
  function pathOf(key, d) { if (!cache[key]) cache[key] = new Path2D(d); return cache[key]; }

  function drawStack(cv, M, opts) {
    opts = opts || {};
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, T = tokens();
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    if (!opts.transparent) { g.fillStyle = T.bg; g.fillRect(0, 0, W, H); }
    const sc = Math.min(W, H) / (M.D + 0.5), cx = W / 2, cy = H / 2;
    const outer = pathOf('outer', outerD(M));
    g.setTransform(sc, 0, 0, sc, cx, cy);
    const sh = Math.max(1, sc * 0.012);
    // backer
    g.save(); g.shadowColor = 'rgba(25,20,10,0.35)'; g.shadowBlur = sh * 4; g.shadowOffsetY = sh * 2;
    g.fillStyle = fillFor(g, BACKER(), 0, 0, M.R); g.fill(outer); g.restore();
    if (M.water) { g.save(); g.shadowColor = 'rgba(25,20,10,0.3)'; g.shadowBlur = sh * 1.6; g.shadowOffsetX = sh * 0.6; g.shadowOffsetY = sh * 1.0; g.fillStyle = fillFor(g, paper(S.waterPaper), 0, 0, M.R); g.fill(pathOf('water', outerD(M) + loopsD(M.water.loops)), 'evenodd'); g.restore(); }
    for (const s of M.sheets) {
      const p = pathOf('sheet-' + s.index, sheetD(M, s));
      g.save();
      g.shadowColor = 'rgba(25,20,10,0.42)'; g.shadowBlur = sh * 2.6; g.shadowOffsetX = sh * 1.1; g.shadowOffsetY = sh * 1.7;
      g.fillStyle = fillFor(g, s.color, 0, 0, M.R); g.fill(p, 'evenodd');
      g.restore();
      if (opts.highlight === s.index) { g.save(); g.strokeStyle = '#c7461f'; g.lineWidth = 2 / sc; g.stroke(p); g.restore(); }
    }
    for (const inl of M.inlays) {
      g.save(); g.shadowColor = 'rgba(25,20,10,0.35)'; g.shadowBlur = sh * 1.5; g.shadowOffsetX = sh * 0.6; g.shadowOffsetY = sh * 0.9;
      if (inl.mode === 'top') { g.shadowColor = 'rgba(25,20,10,0.45)'; g.shadowBlur = sh * 2.6; g.shadowOffsetX = sh * 1.2; g.shadowOffsetY = sh * 1.8; }
      g.fillStyle = fillFor(g, inl.color, 0, 0, M.R); g.fill(new Path2D(loopsD(inl.loopsAll)), 'evenodd'); g.restore();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    LAST_STACK = { sc, cx, cy, W, H };
  }

  function drawExploded(cv, M) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, T = tokens();
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
    const wOff = M.water ? 1 : 0, n = 1 + wOff + M.sheets.length, c45 = Math.SQRT1_2, sq = 0.5;
    const f = 0.12 + 0.5 * S.explode;                 // gap as a fraction of the disc's on-screen height
    // disc on screen: width sc*D, height sc*sq*D. Each layer steps up by gy and right by gx.
    const kx = 0.55;
    const scH = (H * 0.86) / (M.D * sq * (1 + (n - 1) * f)), scW = (W * 0.80) / (M.D * (1 + (n - 1) * f * sq * kx));
    const sc = Math.min(scH, scW), gy = f * sc * sq * M.D, gx = gy * kx, th = Math.max(2, sc * 0.035);
    const x0 = (W - (sc * M.D + (n - 1) * gx)) / 2 + sc * M.R, y0 = H - (H - (sc * sq * M.D + (n - 1) * gy)) / 2 - sc * sq * M.R;
    const setT = (i, dz) => g.setTransform(sc * c45, sc * sq * c45, -sc * c45, sc * sq * c45, x0 + i * gx, y0 - i * gy + (dz || 0));
    const outer = pathOf('outer', outerD(M));
    const layer = (i, p, color, rule) => {
      setT(i, th); g.fillStyle = mix(color.hex, '#000000', 0.3); g.fill(p, rule);
      setT(i); g.fillStyle = fillFor(g, color, 0, 0, M.R); g.fill(p, rule);
      g.lineWidth = 0.6 / sc; g.strokeStyle = 'rgba(0,0,0,0.25)'; g.stroke(p);
    };
    const piecesOn = lvl => { for (const inl of M.inlays) for (const p of inl.pieces) if (p.b === lvl) { g.fillStyle = fillFor(g, inl.color, 0, 0, M.R); g.fill(new Path2D(loopsD(p.loops)), 'evenodd'); } };
    layer(0, outer, BACKER(), 'nonzero');
    if (M.water) layer(1, pathOf('water', outerD(M) + loopsD(M.water.loops)), paper(S.waterPaper), 'evenodd');
    setT(wOff); piecesOn(0);
    M.sheets.forEach((s, i) => { layer(i + 1 + wOff, pathOf('sheet-' + s.index, sheetD(M, s)), s.color, 'evenodd'); setT(i + 1 + wOff); piecesOn(i + 1); });
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.muted; g.font = `${Math.max(11, Math.round(W * 0.0125))}px "IBM Plex Mono", monospace`; g.textAlign = 'right';
    const lab = (i, text) => g.fillText(text, x0 + i * gx - sc * M.R - 8, y0 - i * gy + 4);
    lab(0, 'streets');
    if (M.water) lab(1, 'water');
    M.sheets.forEach((s, i) => lab(i + 1 + wOff, `${String(i + 1).padStart(2, '0')}  ${s.name}`));
  }

  function drawSheetCard(cv, M, layer) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, T = tokens();
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = T.bg; g.fillRect(0, 0, W, H);
    const sc = Math.min(W / 9.1, H / 11.6), px = (W - 8.5 * sc) / 2, py = (H - 11 * sc) / 2;
    g.fillStyle = '#fbfaf6'; g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.fillRect(px, py, 8.5 * sc, 11 * sc); g.strokeRect(px, py, 8.5 * sc, 11 * sc);
    const cx = px + 4.25 * sc, cy = py + 5.5 * sc;
    g.setTransform(sc, 0, 0, sc, cx, cy);
    let p, color, rule = 'evenodd';
    if (layer.kind === 'backer') { p = pathOf('outer', outerD(M)); color = BACKER(); rule = 'nonzero'; }
    else if (layer.kind === 'inlay') { p = new Path2D(loopsD(S.dense ? layer.ref.dense : layer.ref.loopsAll)); color = layer.ref.color; }
    else if (layer.kind === 'stencil') { p = new Path2D(outerD(M) + loopsD(M.stencil)); color = layer.color; }
    else if (layer.kind === 'water') { p = new Path2D(outerD(M) + loopsD(M.water.loops)); color = layer.color; }
    else { p = pathOf('sheet-' + layer.ref.index, sheetD(M, layer.ref)); color = layer.ref.color; }
    if (layer.kind === 'inlay' && !S.dense) { g.strokeStyle = 'rgba(0,0,0,0.15)'; g.lineWidth = 1 / sc; g.stroke(pathOf('outer', outerD(M))); }
    g.fillStyle = fillFor(g, color, 0, 0, M.R); g.fill(p, rule);
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.8 / sc; g.stroke(p);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ------------------------------------------------------------ layers list, export */
  function allLayers(M) {
    const L = [{ kind: 'backer', id: 'W00-streets', label: 'Streets and grid marks', color: BACKER(), pieces: 1, note: 'full disc at the bottom; shows through the streets and crosses' }];
    if (M.water) L.push({ kind: 'water', id: 'W01-water', label: 'Water', color: paper(S.waterPaper), pieces: 1, note: 'full disc on the streets layer, streets cut through it' });
    M.sheets.forEach((s, i) => L.push({ kind: 'sheet', id: `L${String(i + 1).padStart(2, '0')}-${s.index === 0 ? 'base' : Math.round(s.level) + 'm'}`, label: `${String(i + 1).padStart(2, '0')} · ${s.name}`, color: s.color, ref: s, pieces: s.pieces, note: s.index === 0 ? 'everything below the first contour' : `ground above ${Math.round(s.level)} m` }));
    M.inlays.forEach((inl, i) => L.push({ kind: 'inlay', id: `P${String(i + 1).padStart(2, '0')}-${inl.id}${inl.mode === 'top' ? '-top' : ''}`, label: inl.name + (inl.mode === 'top' ? ' (on top)' : ''), color: inl.color, ref: inl, pieces: inl.pieces_n, note: inl.mode === 'top' ? 'all pieces on one sheet; glue on top using the stencil' : 'each piece presses into its own hole' }));
    if (M.stencil && M.stencil.length) L.push({ kind: 'stencil', id: 'S01-placement-stencil', label: 'Placement stencil', color: { hex: '#b9b4ab', name: 'Any scrap cardstock', pack: '' }, pieces: 1, note: 'lay on the finished stack, notch to notch; drop each building through its hole' });
    return L;
  }
  function layerPathD(M, layer) {
    if (layer.kind === 'backer') return outerD(M);
    if (layer.kind === 'inlay') return loopsD(S.dense ? layer.ref.dense : layer.ref.loopsAll);
    if (layer.kind === 'stencil') return outerD(M) + loopsD(M.stencil);
    if (layer.kind === 'water') return outerD(M) + loopsD(M.water.loops);
    return sheetD(M, layer.ref);
  }
  // The same outlines as layerPathD, as polygons in wafer inches (even-odd), for GDS and raster exports.
  function layerLoops(M, layer) {
    const outer = outerLoop(M);
    if (layer.kind === 'backer') return [outer];
    if (layer.kind === 'inlay') return (S.dense ? layer.ref.dense : layer.ref.loopsAll).slice();
    if (layer.kind === 'stencil') return [outer].concat(M.stencil);
    if (layer.kind === 'water') return [outer].concat(M.water.loops);
    return [outer].concat(layer.ref.loops, layer.ref.extras);
  }
  function uniqueHexes(layers) {
    const used = new Set();
    return layers.map(l => {
      let h = l.color.hex, [r, g, b] = hexRgb(h), n = 0;
      while (used.has(h)) { n++; h = E.rgbToHex(r - (n % 3 === 1 ? 1 : 0) * Math.ceil(n / 3), g - (n % 3 === 2 ? 1 : 0) * Math.ceil(n / 3), b - (n % 3 === 0 ? 1 : 0) * Math.ceil(n / 3)); }
      used.add(h); return h;
    });
  }
  // Bounding box of a layer in inches. Disc-based layers are the wafer outline; pieces are measured.
  function layerBox(M, l) {
    if (l.kind !== 'inlay') return [-M.R, -M.R, M.R, M.R];
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const lp of (S.dense ? l.ref.dense : l.ref.loopsAll)) for (let i = 0; i < lp.length; i += 2) { a = Math.min(a, lp[i]); c = Math.max(c, lp[i]); b = Math.min(b, lp[i + 1]); d = Math.max(d, lp[i + 1]); }
    return [a, b, c, d];
  }
  const MAT = { w: P.MACHINE.matMaxW, h: P.MACHINE.matMaxH };
  // Every layer must fit the machine mat, or Design Space only offers "Without Mat" (Smart Materials).
  function matCheck(M) {
    const bad = allLayers(M).filter(l => { const b = layerBox(M, l), w = b[2] - b[0], h = b[3] - b[1]; return !((w <= MAT.w && h <= MAT.h) || (h <= MAT.w && w <= MAT.h)); });
    return { ok: !bad.length, bad };
  }
  function buildSvg(M, only) {
    const layers = allLayers(M), hex = uniqueHexes(layers);
    // canvas = exactly the artwork, no margin: Design Space sizes the upload from the SVG canvas
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    layers.forEach((l, i) => { if (only != null && only !== i) return; const b = layerBox(M, l); box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]; });
    const f = v => v.toFixed(4), Wd = box[2] - box[0], Hd = box[3] - box[1];
    let s = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(Wd)}in" height="${f(Hd)}in" viewBox="${f(box[0])} ${f(box[1])} ${f(Wd)} ${f(Hd)}">\n`;
    s += `  <title>Mask Set: ${SITE.name.replace(/[&<>]/g, ' ')}</title>\n`;
    layers.forEach((l, i) => {
      if (only != null && only !== i) return;
      s += `  <g id="${l.id}">\n    <path id="${l.id}-path" fill="${hex[i]}" stroke="none" fill-rule="${l.kind === 'backer' ? 'nonzero' : 'evenodd'}" d="${layerPathD(M, l)}"/>\n  </g>\n`;
    });
    return s + '</svg>\n';
  }
  function assemblyText(M) {
    const L = allLayers(M), hex = uniqueHexes(L);
    const lines = [`MASK SET — ${SITE.name}`, `${S.wafer} mm wafer (${M.D.toFixed(2)} in) · 1:${Math.round(M.scale).toLocaleString('en-US')} · ${M.N} terrain masks, contour interval ${Math.round(M.interval)} m (${Math.round(M.eMin)}–${Math.round(M.eMax)} m)`, ''];
    lines.push('Cut list, bottom to top (SVG fill → paper):');
    L.forEach((l, i) => lines.push(` ${String(i + 1).padStart(2, ' ')}. ${l.label.padEnd(26)} ${hex[i]}  ${l.color.name}${l.color.pack ? ' (' + l.color.pack.replace('Hello Hobby ', '') + ')' : ''} · ${l.pieces} piece${l.pieces === 1 ? '' : 's'} · ${l.note}`));
    lines.push('');
    lines.push('Assembly');
    lines.push(' 1. Upload the SVG to Design Space as a Cut image. It should read W = ' + M.D.toFixed(2) + ' in (the wafer). Do not resize.');
    lines.push(' 2. Make It. Choose "On Mat" (machine mat, 8.5 x 12 in) and a cardstock setting; every layer is under the 8.2 x 11.7 in mat limit. One mat per layer. Lift each sheet with transfer tape so islands keep their places.');
    if (M.lettering) lines.push('    The top sheet has stencil lettering in its ring. If small letters tear, use an "intricate" cardstock setting or a fresh blade.');
    lines.push(` 3. Glue bottom to top: streets layer${M.water ? ', water layer' : ''}, then each mask, notch at 6 o'clock.`);
    if (M.inlays.some(i => i.mode === 'top')) lines.push(`    Buildings on top: the building sheets hold every piece in one tight layout. With the stack glued, lay the stencil on it notch to notch, drop each building through its hole onto its flat seat, glue, and lift the stencil.`);
    if (M.inlays.some(i => i.mode === 'piece')) lines.push(`    Inlaid pieces: each shape fits only its own hole and sits flush with the flat pad around it.`);
    lines.push(`    Overlay check: at 3 and 9 o'clock the nested squares and crosses should show even ledges all round. Uneven ledges mean the last sheet is shifted.`);
    lines.push(`    The step gauge at 12 o'clock reads the depth of the stack, one sheet per slot.`);
    return lines.join('\n');
  }
  function placardText(M) {
    if (EXTRA && EXTRA.placard) return EXTRA.placard({ M, S, SITE, paper, BACKER });
    const sheets = allLayers(M).length, km = SITE.diameterM / 1000;
    const water = M.water ? ` Rivers${M.stats.sea ? ', the sea' : ''}${M.stats.lakes ? ' and lakes' : ''} stop on a ${paper(S.waterPaper).name.toLowerCase()} water layer just above it.` : '';
    return [
      `MASK SET: ${SITE.name.toUpperCase()}`,
      '',
      `Cardstock, ${sheets} cut layers. ${M.D.toFixed(2)} in, the diameter of a ${S.wafer} mm silicon wafer.`,
      '',
      `${SITE.name}, ${km < 10 ? km.toFixed(1) : Math.round(km)} km across at 1:${Math.round(M.scale).toLocaleString('en-US')}, rebuilt as a set of photomasks. Each sheet is one ${Math.round(M.interval)} m contour of the ground, quantized to a layout grid and drawn only at 0°, 45° and 90°, the way chip layouts are drawn.` +
        (M.stats.main ? ` The ${M.stats.main} largest named buildings stand on flat seats at their own ground level.` : '') +
        ` Main streets and the stepper grid are cut through every layer to the bottom sheet in ${BACKER().name.toLowerCase()}.` + water,
      '',
      'Overlay marks at 3 and 9 o\'clock nest one step per layer and register the stack the way overlay metrology registers a chip. The step gauge at 12 o\'clock counts the layers. The small crosses are stepper field marks at the true 26 × 33 mm pitch.',
      '',
      SITE.attribution || 'Elevation: AWS Terrain Tiles. Streets, water and buildings: © OpenStreetMap contributors (ODbL).'
    ].join('\n');
  }

  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }

  /* ------------------------------------------------------------ UI */
  function renderPreview() {
    if (!MODEL) return;
    const cv = $('waferCanvas'), wrap = $('waferWrap');
    const size = Math.min(wrap.clientWidth - 20, Math.max(320, window.innerHeight - 190));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = size + 'px'; cv.style.height = size + 'px'; cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
    $('cutsGridW').hidden = S.view !== 'cuts'; cv.hidden = S.view === 'cuts';
    if (S.view === 'stack') drawStack(cv, MODEL);
    else if (S.view === 'exploded') drawExploded(cv, MODEL);
    else renderCuts();
    $('explodeRow').hidden = S.view !== 'exploded';
  }
  function renderCuts() {
    const grid = $('cutsGridW'); grid.innerHTML = '';
    const L = allLayers(MODEL);
    L.forEach(l => {
      const card = document.createElement('div'); card.className = 'cut-card';
      const cv = document.createElement('canvas'); cv.width = 300; cv.height = 380; drawSheetCard(cv, MODEL, l); card.appendChild(cv);
      const t = document.createElement('div'); t.className = 't';
      t.innerHTML = `<b></b><span></span><span></span>`;
      t.children[0].textContent = l.label; t.children[1].textContent = `${l.color.name}${l.color.pack ? ' · ' + l.color.pack.replace('Hello Hobby ', '') : ''}`;
      t.children[2].textContent = `${l.pieces} piece${l.pieces === 1 ? '' : 's'} · ${l.note}`;
      card.appendChild(t); grid.appendChild(card);
    });
  }
  function renderInfo() {
    const M = MODEL;
    const mc = matCheck(M);
    $('chipSize').textContent = `${S.wafer} mm · ${M.D.toFixed(2)} in · ${mc.ok ? 'fits the mat' : 'too big for the mat'}`;
    $('chipSize').className = 'chip ' + (mc.ok ? 'ok' : 'bad');
    $('chipLayers').textContent = `${allLayers(M).length} cut layers`;
    $('intervalOut').textContent = `${Math.round(M.interval)} m interval · ${Math.round(M.eMin)}–${Math.round(M.eMax)} m · 1:${Math.round(M.scale).toLocaleString('en-US')}`;
    $('paletteNote').textContent = PALETTES[S.palette].note;
    const L = allLayers(M), hex = uniqueHexes(L), list = $('layerListW'); list.innerHTML = '';
    L.forEach((l, i) => {
      const row = document.createElement('div'); row.className = 'lrow';
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = l.color.hex;
      if (isHolo(l.color)) sw.classList.add('holo');
      const nm = document.createElement('div'); nm.className = 'nm'; nm.innerHTML = '<b></b><span></span>';
      nm.children[0].textContent = l.label; nm.children[1].textContent = `${l.color.name} · ${hex[i]}`;
      const st = document.createElement('div'); st.className = 'st num'; st.textContent = `${l.pieces} pc`;
      row.append(sw, nm, st); list.appendChild(row);
    });
    $('statusW').innerHTML = '';
    const bits = [
      ...(EXTRA && EXTRA.status ? EXTRA.status(M) : []),
      M.water ? [M.stats.sea ? 'sea' : null, M.stats.lakes ? `${M.stats.lakes} lakes` : null, M.stats.rivers ? `${M.stats.rivers} river segments` : null].filter(Boolean).join(', ') + ' on the water layer' : null,
      `${M.stats.main} buildings`, `${M.stats.roads} streets`, M.fieldCount ? `${M.fieldCount} field marks` : null,
      `layout grid ${(M.k * GF).toFixed(3)} in`, S.orient === 'grid' ? `street grid square to the wafer (map turned ${Math.round(-M.theta * 180 / Math.PI)}°)` : 'north up'
    ].filter(Boolean);
    bits.forEach(b => { const s = document.createElement('span'); s.textContent = b; $('statusW').appendChild(s); });
    $('assembly').value = assemblyText(M);
    $('placard').value = placardText(M);
    if (exportPanel) exportPanel.refresh();
  }
  let pending = 0;
  function rebuild() {
    if (!SITE) return;
    $('busyW').hidden = false;
    clearTimeout(pending);
    pending = setTimeout(() => {
      try { MODEL = compute(); cache = {}; $('emptyW').hidden = true; renderInfo(); renderPreview(); }
      catch (e) { console.error(e); toast('Could not build: ' + e.message); }
      $('busyW').hidden = true;
    }, 30);
  }

  /* ------------------------------------------------------------ export */
  let exportPanel = null;
  const projectName = () => (SITE ? SITE.name : 'map') + ' mask set';
  function layerSet() {
    const M = MODEL, L = allLayers(M);
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    L.forEach(l => { const b = layerBox(M, l); box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]; });
    return {
      name: projectName(), bounds: box, origin: 'center',
      layers: L.map(l => ({ id: l.id, name: l.label.replace(/^\d+ · /, ''), hex: l.color.hex, paper: l.color.name, loops: layerLoops(M, l) }))
    };
  }
  function previewPng(size) {
    const cv = document.createElement('canvas'); cv.width = size; cv.height = size; drawStack(cv, MODEL);
    return new Promise(r => cv.toBlob(r, 'image/png'));
  }
  function exportProvider() {
    return {
      project: projectName,
      size: () => { if (!MODEL) return null; const b = layerSet().bounds; return { wIn: b[2] - b[0], hIn: b[3] - b[1], layers: allLayers(MODEL).length }; },
      layerSet,
      cricutSvg: () => buildSvg(MODEL),
      cricutSvgLayers: () => allLayers(MODEL).map((l, i) => ({ name: l.id, svg: buildSvg(MODEL, i) })),
      notes: async () => [
        { path: 'assembly.txt', text: assemblyText(MODEL) },
        { path: 'placard.txt', text: placardText(MODEL) },
        { path: 'preview.png', data: await previewPng(1600) }
      ],
      cricutNote: `Import the .svg without resizing: it comes in at ${S.wafer === '200' ? '7.87' : '5.91'} in, the wafer. Each layer has its own fill color, so Design Space puts each on its own mat.`,
      toast
    };
  }

  /* ------------------------------------------------------------ sites */
  async function api(path, opts) {
    const r = await fetch('api/' + path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || `The app answered ${r.status}`);
    return j;
  }
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  let SITES = [];
  async function loadSiteList(selectId) {
    SITES = (await api('sites')).sites || [];
    const sel = $('sitePick'); sel.innerHTML = '';
    const groups = [['example', 'Examples'], ['user', 'Your maps'], ['internal', 'Internal (not shipped)']];
    for (const [src, label] of groups) {
      const list = SITES.filter(s => s.source === src); if (!list.length) continue;
      const g = document.createElement('optgroup'); g.label = label;
      for (const s of list) { const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.name} · ${fmtDia(s.diameterM)}`; g.appendChild(o); }
      sel.appendChild(g);
    }
    const want = selectId || store.get('maskset.site');
    if (want && SITES.some(s => s.id === want)) sel.value = want;
    return sel.value;
  }
  const fmtDia = m => m >= 10000 ? Math.round(m / 1000) + ' km' : (m / 1000).toFixed(1).replace(/\.0$/, '') + ' km';
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  }
  async function openSite(id) {
    if (!id) return;
    $('busyW').hidden = false;
    try {
      const site = await api('sites/' + encodeURIComponent(id));
      if (site.extrasScript && !(window.MaskSetExtras || {})[site.id]) await loadScript(site.extrasScript);
      setSite(site);
      store.set('maskset.site', id);
      syncSiteControls();
      rebuild();
    } catch (e) { $('busyW').hidden = true; toast('Could not open the map: ' + e.message); }
  }
  function syncSiteControls() {
    const info = SITES.find(s => s.id === SITE.id) || {};
    $('siteTitle').textContent = 'Mask Set: ' + SITE.name;
    document.title = `Mask Set: ${SITE.name} · PaperStrata`;
    const c = SITE.center;
    $('siteNote').textContent = `${Math.abs(c[0]).toFixed(4)}° ${c[0] >= 0 ? 'N' : 'S'}, ${Math.abs(c[1]).toFixed(4)}° ${c[1] >= 0 ? 'E' : 'W'} · ${fmtDia(SITE.diameterM)} across · ${SITE.roads.length} streets, ${SITE.water.length} water features, ${SITE.buildings.length} buildings`;
    $('btnDeleteSite').hidden = info.source !== 'user';
    // fixed frames (only some sites have them)
    const fsel = $('frame'); fsel.innerHTML = '';
    if (SITE.frames) for (const [k, f] of Object.entries(SITE.frames)) { const o = document.createElement('option'); o.value = k; o.textContent = f.name || k; fsel.appendChild(o); }
    if (S.frame) fsel.value = S.frame;
    $$('[data-needs="frames"]').forEach(e => { e.hidden = !SITE.frames; });
    renderExtraOptions();
    $('orient').value = S.orient; $('streetDetail').value = S.streetDetail;
  }

  // Settings an add-on brings with it: [{id, label, type: 'check' | 'paper'}], stored in S like the built-in ones.
  function renderExtraOptions() {
    const box = $('extraOptions'), opts = (EXTRA && EXTRA.options) || [];
    box.innerHTML = ''; box.hidden = !opts.length;
    for (const o of opts) {
      if (o.type === 'paper') {
        const row = document.createElement('div'), lab = document.createElement('label'), sel = document.createElement('select');
        row.className = 'row'; lab.textContent = o.label;
        for (const n of paperNames()) { const op = document.createElement('option'); op.value = op.textContent = n; sel.appendChild(op); }
        sel.value = S[o.id]; sel.addEventListener('change', () => { S[o.id] = sel.value; rebuild(); });
        row.append(lab, sel); box.appendChild(row);
      } else {
        const lab = document.createElement('label'), cb = document.createElement('input');
        lab.className = 'check'; cb.type = 'checkbox'; cb.checked = !!S[o.id];
        cb.addEventListener('change', () => { S[o.id] = cb.checked; rebuild(); });
        lab.append(cb, ' ' + o.label); box.appendChild(lab);
      }
    }
  }
  const paperNames = () => { const names = []; for (const p of P.DEFAULT_PACKS) for (const c of p.colors) if (!names.includes(c.name)) names.push(c.name); return names; };

  /* New location: coordinates are parsed by the app (the same parser it uses to fetch), then the
     download runs as a job we poll for progress. */
  function bindNewSite() {
    const form = $('newSite');
    let unit = 'km', parsed = null, seq = 0;
    const show = on => { form.hidden = !on; $('btnNewSite').hidden = on; if (on) $('nsName').focus(); };
    $('btnNewSite').addEventListener('click', () => show(true));
    $('nsCancel').addEventListener('click', () => show(false));
    $$('#nsUnit .btn').forEach(b => b.addEventListener('click', () => {
      const prev = unit; unit = b.dataset.unit;
      $$('#nsUnit .btn').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      const v = Number($('nsDia').value);
      if (v && prev !== unit) $('nsDia').value = +(prev === 'km' ? v / 1.609344 : v * 1.609344).toFixed(2);
      $('nsDia').max = unit === 'km' ? 30 : 18.6; $('nsDia').min = unit === 'km' ? 0.2 : 0.125;
      scaleNote();
    }));
    const scaleNote = () => {
      const v = Number($('nsDia').value), km = unit === 'km' ? v : v * 1.609344, out = $('nsScale');
      if (!(km > 0)) { out.textContent = ''; return; }
      if (km < 0.2 || km > 30) { out.className = 'note bad'; out.textContent = 'Pick between 0.2 and 30 km (0.125 and 18.6 mi).'; return; }
      const sc = km * 1000 / (200 / 1000);
      const detail = km <= 3 ? 'every street' : km <= 12 ? 'main and secondary streets' : 'main roads only';
      out.className = 'note';
      out.textContent = `About 1:${Math.round(sc).toLocaleString('en-US')} on a 200 mm wafer · ${detail} · ${km <= 1.5 ? 'all buildings' : 'named buildings'}`;
    };
    $('nsDia').addEventListener('input', scaleNote); scaleNote();
    const checkCoords = async () => {
      const text = $('nsCoords').value.trim(), out = $('nsCoordsOut'), my = ++seq;
      parsed = null;
      if (!text) { out.className = 'note'; out.textContent = 'In Google Maps, right-click a spot and click the numbers at the top of the menu to copy them.'; return; }
      try {
        const r = await fetch('api/coords', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => r.json());
        if (my !== seq) return;
        if (!r.ok) { out.className = 'note bad'; out.textContent = r.error; return; }
        parsed = r;
        out.className = 'note ok'; out.innerHTML = '';
        out.append(`✓ ${Math.abs(r.lat).toFixed(5)}° ${r.lat >= 0 ? 'N' : 'S'}, ${Math.abs(r.lon).toFixed(5)}° ${r.lon >= 0 ? 'E' : 'W'} · `);
        const a = document.createElement('a'); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'check on Google Maps';
        a.href = `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lon}`;
        out.append(a);
      } catch (e) { out.className = 'note bad'; out.textContent = 'Could not reach the app to read the coordinates.'; }
    };
    let t = 0;
    $('nsCoords').addEventListener('input', () => { clearTimeout(t); t = setTimeout(checkCoords, 250); });
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (!parsed) { await checkCoords(); if (!parsed) { $('nsCoords').focus(); return; } }
      const go = $('nsGo'); go.disabled = true;
      const st = $('nsStatus'); st.hidden = false; $('nsMsg').textContent = 'Starting…'; $('nsBar').style.width = '2%';
      try {
        const { job } = await api('sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('nsName').value.trim(), coords: $('nsCoords').value, diameter: Number($('nsDia').value), unit }) });
        let j;
        for (;;) {
          await new Promise(r => setTimeout(r, 700));
          j = await api('jobs/' + job);
          $('nsMsg').textContent = j.message || ''; $('nsBar').style.width = Math.round((j.progress || 0) * 100) + '%';
          if (j.state !== 'running') break;
        }
        if (j.state === 'error') throw new Error(j.error || 'the download failed');
        await loadSiteList(j.siteId);
        show(false); st.hidden = true; form.reset(); parsed = null; scaleNote();
        toast('Map ready');
        await openSite(j.siteId);
      } catch (e) { $('nsMsg').textContent = 'Could not download the map: ' + e.message; $('nsBar').style.width = '0'; }
      finally { go.disabled = false; }
    });
    $('btnDeleteSite').addEventListener('click', async () => {
      if (!SITE || !confirm(`Delete the downloaded map "${SITE.name}"? You can download it again later.`)) return;
      try { await api('sites/' + encodeURIComponent(SITE.id), { method: 'DELETE' }); const id = await loadSiteList(); await openSite(id); }
      catch (e) { toast(e.message); }
    });
  }

  function bind() {
    $$('input[name="pal"]').forEach(r => r.addEventListener('change', () => { S.palette = r.value; rebuild(); }));
    $$('#viewTabsW .btn').forEach(b => b.addEventListener('click', () => { S.view = b.dataset.view; $$('#viewTabsW .btn').forEach(x => x.classList.toggle('active', x === b)); renderPreview(); }));
    $('levels').addEventListener('input', () => { S.levels = Number($('levels').value); $('levelsOut').textContent = S.levels; rebuild(); });
    $('explode').addEventListener('input', () => { S.explode = Number($('explode').value) / 100; renderPreview(); });
    ['spacing', 'geom', 'grid', 'orient', 'wafer', 'streetDetail'].forEach(id => $(id).addEventListener('change', () => { S[id] = id === 'grid' ? Number($(id).value) : $(id).value; rebuild(); }));
    const names = paperNames();
    ['mainPaper', 'streetPaper', 'waterPaper'].forEach(id => { const sel = $(id); names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; if (n === S[id]) o.selected = true; sel.appendChild(o); }); sel.addEventListener('change', () => { S[id] = sel.value; rebuild(); }); });
    ['mount', 'frame'].forEach(id => $(id).addEventListener('change', () => { S[id] = $(id).value; syncW(); rebuild(); }));
    $('mainShape').addEventListener('change', () => { S.mainShape = $('mainShape').value; rebuild(); });
    ['dense', 'water', 'sea'].forEach(id => $(id).addEventListener('change', () => { S[id] = $(id).checked; rebuild(); }));
    $('mainCount').addEventListener('change', () => { S.mainCount = Number($('mainCount').value); S.bclass = {}; rebuild(); });
    function syncW() { $('paperRows').hidden = S.mount === 'via'; $('denseRow').hidden = S.mount === 'via'; }
    syncW();
    $('waferCanvas').addEventListener('click', ev => {
      if (S.view !== 'stack' || !MODEL || !LAST_STACK) return;
      const cv = $('waferCanvas'), r = cv.getBoundingClientRect();
      const x = (ev.clientX - r.left) * cv.width / r.width, y = (ev.clientY - r.top) * cv.height / r.height;
      toggleAt((x - LAST_STACK.cx) / LAST_STACK.sc, (y - LAST_STACK.cy) / LAST_STACK.sc);
    });
    function toggleAt(u, v) {
      const NF = MODEL.NF, pi = Math.floor(u / GF + NF / 2), pj = Math.floor(v / GF + NF / 2);
      let best = -1, bd = 1e9;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const i = pi + dx, j = pj + dy; if (i < 0 || j < 0 || i >= NF || j >= NF) continue; const id = MODEL.bidAll[j * NF + i]; if (id >= 0 && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = id; } }
      if (best < 0) { toast('No building there. Click a building on the map.'); return; }
      if (SITE.buildings[best].group) { toast(bName(best) + ' is part of a fixed group; use its setting instead.'); return; }
      if (!SITE.mainShapes.some(m => m.i === best)) { toast(bName(best) + ' is too small to cut at this scale.'); return; }
      const next = MODEL.mainOn.has(best) ? 'off' : 'on';
      S.bclass[best] = next;
      toast(`${bName(best)}: ${next === 'on' ? 'added' : 'removed'}`);
      rebuild();
      return { id: best, name: bName(best), state: next };
    }
    window.MaskSet.toggleAt = toggleAt;
    ['roads', 'align', 'fields', 'gauge', 'north', 'lettering'].forEach(id => $(id).addEventListener('change', () => { S[id] = $(id).checked; rebuild(); }));
    $('btnPngW').addEventListener('click', async () => { if (!MODEL) return; PaperStrataIO.download(ExportPanel.slug(projectName()) + '-preview.png', await previewPng(2400)); });
    $$('[data-copy]').forEach(b => b.addEventListener('click', async () => { const t = $(b.dataset.copy); try { await navigator.clipboard.writeText(t.value); toast('Copied'); } catch (e) { t.select(); toast('Select-all and copy'); } }));
    $('sitePick').addEventListener('change', () => openSite($('sitePick').value));
    window.addEventListener('resize', () => renderPreview());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderPreview());
    exportPanel = ExportPanel.mount($('exportPanel'), exportProvider());
    bindNewSite();
  }
  function emptyState(msg) { const e = $('emptyW'); e.hidden = false; e.textContent = msg; $('waferCanvas').hidden = true; }
  window.MaskSet = { matCheck: () => matCheck(MODEL), S, compute, get model() { return MODEL; }, get site() { return SITE; }, rebuild, openSite, layerSet: () => layerSet(), buildSvg: () => buildSvg(MODEL), drawStack, drawExploded, allLayers: () => allLayers(MODEL), setView(v) { S.view = v; renderPreview(); } };
  async function boot() {
    bind();
    if (!(await PaperStrataIO.hasServer())) {
      emptyState('The map tool downloads and reads map data through the app. Start PaperStrata with its launcher (see the README), then open the page it shows.');
      $('btnNewSite').disabled = true;
      return;
    }
    try {
      const id = await loadSiteList(new URLSearchParams(location.search).get('site'));   // map.html?site=rome opens that map
      if (id) { $('waferCanvas').hidden = false; await openSite(id); }
      else emptyState('No maps yet. Click "New location…" to download one.');
    } catch (e) { emptyState('Could not list the maps: ' + e.message); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
