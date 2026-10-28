/* export.js — file writers shared by the photo and map tools. No DOM access.

   Both tools hand over a LayerSet:
     { name, bounds: [x0, y0, x1, y1],           inches, y down (screen orientation)
       origin: 'center' | 'lowerLeft',           where (0, 0) lands in a GDS file
       layers: [{ id, name, hex, paper, loops }] } bottom -> top
   loops are closed polygons [x0, y0, x1, y1, ...] in inches, filled with the even-odd rule:
   a loop inside another loop is a hole, a loop inside a hole is an island, and so on.

   Writers:  GDSII (+ KLayout .lyp), PNG (1-bit, indexed, with DPI), TIFF (bilevel, 8-bit, RGB;
   PackBits), and a scale.json manifest. Rasters are drawn row by row with a scanline fill, so
   size is limited only by memory for the compressed output, not by the browser's canvas cap. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CutExport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const X = {};
  const NM_PER_IN = 25.4e6;

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
      text: (layer, x, y, s) => { rec(0x0C, 0x00); rec(0x0D, 0x02, int2([layer])); rec(0x16, 0x02, int2([0])); rec(0x10, 0x03, int4([x, y])); rec(0x19, 0x06, ascii(s)); rec(0x11, 0x00); },
      endstr: () => rec(0x07, 0x00),
      endlib: () => rec(0x04, 0x00),
      bytes: () => { const out = new Uint8Array(size); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
    };
  }

  /* LayerSet -> GDSII bytes. One top cell; sheet i (bottom = 1) goes on layer i, datatype 0.
     Units: 1 database unit = 1 nm, 1 user unit = 1 µm, true physical size. Y is flipped to GDS's y-up.
     opts: {cellName, layerOf(i) -> number, labels (bool: a text label per layer outside the art)} */
  X.gds = function (set, opts) {
    opts = opts || {};
    const MAX_PTS = 8000;   // XY record limit is 8191 points including the closing one
    const b = set.bounds, ox = set.origin === 'center' ? (b[0] + b[2]) / 2 : b[0], oy = set.origin === 'center' ? (b[1] + b[3]) / 2 : b[3];
    const T = (x, y) => [Math.round((x - ox) * NM_PER_IN), Math.round((oy - y) * NM_PER_IN)];
    const now = new Date(), d = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()];
    const w = GdsWriter();
    w.header(); w.bgnlib(d); w.libname(gdsName(set.name || 'LAYERS') + '.DB'); w.units(1e-3, 1e-9);
    w.bgnstr(d); w.strname(gdsName(opts.cellName || set.name || 'TOP'));
    const stats = [];
    set.layers.forEach((L, i) => {
      const layerNo = opts.layerOf ? opts.layerOf(i) : i + 1;
      let polys = 0, pts = 0;
      for (const pc of X.loopsToPieces(L.loops)) {
        for (const part of X.splitLarge(X.keyhole(pc), MAX_PTS)) {
          const xy = [];
          let px = null, py = null;
          for (let k = 0; k < part.length; k += 2) {
            const [x, y] = T(part[k], part[k + 1]);
            if (x === px && y === py) continue;      // rounding can merge neighbours
            xy.push(x, y); px = x; py = y;
          }
          if (xy.length >= 2 && xy[0] === xy[xy.length - 2] && xy[1] === xy[xy.length - 1]) xy.length -= 2;
          if (xy.length < 6) continue;
          if (xy.length / 2 > 8190) throw new Error(`Layer ${L.name}: a polygon kept ${xy.length / 2} points after splitting`);
          xy.push(xy[0], xy[1]);
          w.boundary(layerNo, 0, xy); polys++; pts += xy.length / 2;
        }
      }
      if (opts.labels) { const [x, y] = T(b[0], b[3] + 0.15 + i * 0.12); w.text(layerNo, x, y, `L${layerNo} ${L.name}`); }
      stats.push({ layer: layerNo, name: L.name, polygons: polys, points: pts });
    });
    w.endstr(); w.endlib();
    const bytes = w.bytes();
    bytes.stats = stats;
    return bytes;
  };
  const gdsName = s => (String(s).toUpperCase().replace(/[^A-Z0-9_$?]+/g, '_').replace(/^_+|_+$/g, '') || 'TOP').slice(0, 32);
  X.gdsName = gdsName;

  /* KLayout layer properties: names and paper colors for each GDS layer.
     In KLayout: File > Load Layer Properties, or put it next to the .gds with the same name. */
  X.lyp = function (set, opts) {
    opts = opts || {};
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let s = '<?xml version="1.0" encoding="utf-8"?>\n<layer-properties>\n';
    set.layers.forEach((L, i) => {
      const n = opts.layerOf ? opts.layerOf(i) : i + 1;
      s += ' <properties>\n' +
        `  <frame-color>${L.hex}</frame-color>\n  <fill-color>${L.hex}</fill-color>\n` +
        '  <frame-brightness>-40</frame-brightness>\n  <fill-brightness>0</fill-brightness>\n' +
        '  <dither-pattern>I0</dither-pattern>\n  <line-style/>\n  <valid>true</valid>\n  <visible>true</visible>\n' +
        '  <transparent>false</transparent>\n  <width>1</width>\n  <marked>false</marked>\n  <xfill>false</xfill>\n  <animation>0</animation>\n' +
        `  <name>${esc(String(n).padStart(2, '0') + ' ' + L.name)}</name>\n  <source>${n}/0@1</source>\n </properties>\n`;
    });
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

  // Pixel frame for a LayerSet at a given dpi.
  X.frame = function (set, dpi, mirror) {
    const b = set.bounds;
    return { x0: b[0], y0: b[1], dpi, width: Math.max(1, Math.round((b[2] - b[0]) * dpi)), height: Math.max(1, Math.round((b[3] - b[1]) * dpi)), mirror: !!mirror };
  };

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
    if (opts.dpi) { const ppm = Math.round(opts.dpi / 0.0254), p = new Uint8Array(9); new DataView(p.buffer).setUint32(0, ppm); new DataView(p.buffer).setUint32(4, ppm); p[8] = 1; out.push(...chunk('pHYs', p)); }
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
    const desc = enc(opts.description || ''), soft = enc('PaperStrata');
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
    tags.push([282, 5, 1, { rational: opts.dpi || 72 }]);
    tags.push([283, 5, 1, { rational: opts.dpi || 72 }]);
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
      else if (v.rational) { bytes = new Uint8Array(8); const d2 = new DataView(bytes.buffer); d2.setUint32(0, Math.round(v.rational * 1000), true); d2.setUint32(4, 1000, true); }
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

  /* ------------------------------------------------------------ manifest */
  X.manifest = function (set, info) {
    const f = info.frame;
    return JSON.stringify({
      generator: 'PaperStrata', created: new Date().toISOString(), project: set.name,
      dpi: f.dpi, inchesPerPixel: 1 / f.dpi, micrometresPerPixel: 25400 / f.dpi, widthPx: f.width, heightPx: f.height,
      widthIn: f.width / f.dpi, heightIn: f.height / f.dpi, mirrored: f.mirror, inverted: !!info.invert,
      boundsIn: set.bounds, note: 'Pixel (0,0) is the top-left of boundsIn. Layers are listed bottom to top; in label images pixel value = layer number of the top-most layer, 0 = no paper.',
      layers: set.layers.map((L, i) => ({ number: i + 1, id: L.id, name: L.name, paper: L.paper || L.name, hex: L.hex, gdsLayer: i + 1, files: (info.files && info.files[i]) || [] }))
    }, null, 1);
  };

  // Rough output sizes so the UI can warn before a long export.
  X.estimate = function (set, dpi) {
    const f = X.frame(set, dpi);
    return { width: f.width, height: f.height, megapixels: f.width * f.height / 1e6, rgbMB: f.width * f.height * 3 / 1e6, maskMB: f.width * f.height / 8 / 1e6 };
  };

  return X;
});
