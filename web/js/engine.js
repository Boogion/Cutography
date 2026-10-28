/* engine.js — pure pixel pipeline for layered paper cutting.
   No DOM access. Works in the browser (window.CutEngine) or in a worker.

   Pipeline:  RGBA  ->  preprocess  ->  segment (cluster / nearest / tones)
             ->  labels  ->  cleanup (mode filter, despeckle)  ->  edges
             ->  layer masks (stacked / inlay)  ->  contours  ->  SVG     */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CutEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const E = {};

  /* ------------------------------------------------------------ color */
  E.hexToRgb = function (hex) {
    let h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  E.rgbToHex = function (r, g, b) {
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  };
  const srgbToLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const linToSrgb = v => { v = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return v * 255; };
  const fLab = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fInv = t => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };

  E.rgbToLab = function (r, g, b) {
    const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
    const x = fLab((R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047);
    const y = fLab((R * 0.2126729 + G * 0.7151522 + B * 0.0721750));
    const z = fLab((R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  E.labToRgb = function (L, a, b) {
    const y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
    const X = fInv(x) * 0.95047, Y = fInv(y), Z = fInv(z) * 1.08883;
    const R = X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314;
    const G = X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560;
    const B = X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252;
    return [linToSrgb(R), linToSrgb(G), linToSrgb(B)].map(v => Math.max(0, Math.min(255, v)));
  };
  E.hexToLab = hex => E.rgbToLab.apply(null, E.hexToRgb(hex));
  E.luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  E.deltaE76 = (l1, l2) => Math.hypot(l1[0] - l2[0], l1[1] - l2[1], l1[2] - l2[2]);

  E.deltaE2000 = function (lab1, lab2) {
    const L1 = lab1[0], a1 = lab1[1], b1 = lab1[2], L2 = lab2[0], a2 = lab2[1], b2 = lab2[2];
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
    const Cb7 = Math.pow(Cb, 7), G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const h1p = (a1p === 0 && b1 === 0) ? 0 : (Math.atan2(b1, a1p) * deg + 360) % 360;
    const h2p = (a2p === 0 && b2 === 0) ? 0 : (Math.atan2(b2, a2p) * deg + 360) % 360;
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp;
    if (C1p * C2p === 0) dhp = 0;
    else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
    else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
    else dhp = h2p - h1p + 360;
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 * rad);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp;
    if (C1p * C2p === 0) hbp = h1p + h2p;
    else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
    else hbp = (h1p + h2p - 360) / 2;
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
      + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Cbp7 = Math.pow(Cbp, 7), RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
    const SL = 1 + 0.015 * Math.pow(Lbp - 50, 2) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
    const RT = -Math.sin(2 * dTheta * rad) * RC;
    const tL = dLp / SL, tC = dCp / SC, tH = dHp / SH;
    return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
  };
  E.deltaE = (method) => method === '76' ? E.deltaE76 : E.deltaE2000;

  /* ------------------------------------------------------- preprocess */
  // rgba: Uint8ClampedArray (w*h*4). Returns {rgb: Uint8ClampedArray w*h*3, alpha: Uint8Array w*h}
  E.preprocess = function (rgba, w, h, o) {
    o = o || {};
    const n = w * h;
    const rgb = new Uint8ClampedArray(n * 3);
    const alpha = new Uint8Array(n);
    const br = (o.brightness || 0) * 1.28;
    const ct = Math.max(-100, Math.min(100, o.contrast || 0));
    const cf = (259 * (ct * 1.27 + 255)) / (255 * (259 - ct * 1.27));
    const sat = 1 + (o.saturation || 0) / 100;
    const gamma = o.gamma ? 1 / o.gamma : 1;
    const lut = new Float32Array(256);
    const lv = o.autoLevels ? E.autoLevels(rgba, w, h) : null;
    for (let v = 0; v < 256; v++) {
      const v2 = lv ? (v - lv.lo) * 255 / (lv.hi - lv.lo) : v;
      let t = cf * (v2 - 128) + 128 + br;
      if (gamma !== 1) t = 255 * Math.pow(Math.max(0, Math.min(255, t)) / 255, gamma);
      lut[v] = t;
    }
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      let r = lut[rgba[p]], g = lut[rgba[p + 1]], b = lut[rgba[p + 2]];
      if (sat !== 1) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      }
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      alpha[i] = rgba[p + 3] >= 128 ? 1 : 0;
    }
    if (o.localContrast > 0) E.localContrast(rgb, w, h, o.localContrast / 100);
    const es = Math.round(o.edgeSmooth || 0);
    for (let i = 0; i < es; i++) E.bilateral(rgb, w, h, 2, 22 + 6 * i);
    const blur = Math.round(o.blur || 0);
    if (blur > 0) { E.boxBlur(rgb, w, h, 3, blur); E.boxBlur(rgb, w, h, 3, blur); }
    return { rgb, alpha, w, h };
  };

  // Percentile stretch of the luminance range (1%..99% -> 0..255), applied to all channels alike.
  E.autoLevels = function (rgba, w, h) {
    const hist = new Int32Array(256); let total = 0;
    for (let i = 0; i < w * h; i++) { if (rgba[i * 4 + 3] < 128) continue; hist[Math.round(E.luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]))]++; total++; }
    if (!total) return null;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
    if (hi - lo < 20) return null;
    return { lo, hi };
  };

  // Large-radius unsharp mask: boosts local contrast so neighbouring features separate into different sheets.
  E.localContrast = function (rgb, w, h, amount) {
    const base = new Uint8ClampedArray(rgb);
    E.boxBlur(base, w, h, 3, Math.max(2, Math.round(Math.max(w, h) * 0.03)));
    E.boxBlur(base, w, h, 3, Math.max(2, Math.round(Math.max(w, h) * 0.03)));
    for (let i = 0; i < rgb.length; i++) rgb[i] = rgb[i] + amount * 1.6 * (rgb[i] - base[i]);
  };

  // Edge-preserving (bilateral) smoothing: flattens texture and noise inside regions without blurring edges.
  E.bilateral = function (rgb, w, h, r, sigmaR) {
    const src = new Uint8ClampedArray(rgb);
    const size = 2 * r + 1;
    const spatial = new Float32Array(size * size);
    const sigmaS = r * 0.9;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) spatial[(dy + r) * size + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS));
    const range = new Float32Array(766);
    for (let d = 0; d < 766; d++) range[d] = Math.exp(-(d * d) / (2 * sigmaR * sigmaR * 3));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const r0 = src[i], g0 = src[i + 1], b0 = src[i + 2];
        let sr = 0, sg = 0, sb = 0, sw = 0;
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r), x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const j = (yy * w + xx) * 3;
            const d = Math.abs(src[j] - r0) + Math.abs(src[j + 1] - g0) + Math.abs(src[j + 2] - b0);
            const wgt = spatial[(yy - y + r) * size + xx - x + r] * range[d];
            sr += src[j] * wgt; sg += src[j + 1] * wgt; sb += src[j + 2] * wgt; sw += wgt;
          }
        }
        rgb[i] = sr / sw; rgb[i + 1] = sg / sw; rgb[i + 2] = sb / sw;
      }
    }
  };

  // In-place separable box blur on an interleaved buffer with `ch` channels.
  E.boxBlur = function (buf, w, h, ch, r) {
    const tmp = new Float32Array(buf.length);
    const k = 2 * r + 1;
    // horizontal
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        const row = y * w;
        for (let x = -r; x <= r; x++) sum += buf[(row + Math.max(0, Math.min(w - 1, x))) * ch + c];
        for (let x = 0; x < w; x++) {
          tmp[(row + x) * ch + c] = sum / k;
          const xo = Math.max(0, x - r), xi = Math.min(w - 1, x + r + 1);
          sum += buf[(row + xi) * ch + c] - buf[(row + xo) * ch + c];
        }
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let y = -r; y <= r; y++) sum += tmp[(Math.max(0, Math.min(h - 1, y)) * w + x) * ch + c];
        for (let y = 0; y < h; y++) {
          buf[(y * w + x) * ch + c] = sum / k;
          const yo = Math.max(0, y - r), yi = Math.min(h - 1, y + r + 1);
          sum += tmp[(yi * w + x) * ch + c] - tmp[(yo * w + x) * ch + c];
        }
      }
    }
  };

  /* --------------------------------------------------- segmentation */
  // Builds a lookup from quantised RGB (6 bits per channel) to a class index via `classify(lab)`.
  function makeRgbCache(classify) {
    const cache = new Int16Array(262144).fill(-2);
    return function (r, g, b) {
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      let v = cache[key];
      if (v === -2) { v = classify(E.rgbToLab(r, g, b)); cache[key] = v; }
      return v;
    };
  }

  function nearestIndex(lab, labs, dist) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < labs.length; i++) {
      const d = dist(lab, labs[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // Sample opaque pixels as Lab triples (Float32Array n*3) and return count.
  function sampleLab(pre, maxSamples) {
    const n = pre.w * pre.h;
    let opaque = 0;
    for (let i = 0; i < n; i++) opaque += pre.alpha[i];
    const stride = Math.max(1, Math.floor(opaque / maxSamples));
    const out = new Float32Array(Math.min(opaque, maxSamples + 1) * 3);
    let c = 0, seen = 0;
    for (let i = 0; i < n && c * 3 < out.length; i++) {
      if (!pre.alpha[i]) continue;
      if ((seen++ % stride) !== 0) continue;
      const lab = E.rgbToLab(pre.rgb[i * 3], pre.rgb[i * 3 + 1], pre.rgb[i * 3 + 2]);
      out[c * 3] = lab[0]; out[c * 3 + 1] = lab[1]; out[c * 3 + 2] = lab[2];
      c++;
    }
    return { data: out, count: c };
  }

  // k-means++ in Lab on a sample. Returns array of [L,a,b].
  E.kmeans = function (sample, k, iters, seed) {
    const { data, count } = sample;
    if (count === 0) return [];
    k = Math.max(1, Math.min(k, count));
    let s = seed || 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const cent = [];
    const d2 = new Float32Array(count).fill(Infinity);
    // k-means++ seeding
    let first = Math.floor(rnd() * count);
    cent.push([data[first * 3], data[first * 3 + 1], data[first * 3 + 2]]);
    while (cent.length < k) {
      const c = cent[cent.length - 1];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const dl = data[i * 3] - c[0], da = data[i * 3 + 1] - c[1], db = data[i * 3 + 2] - c[2];
        const d = dl * dl + da * da + db * db;
        if (d < d2[i]) d2[i] = d;
        total += d2[i];
      }
      let target = rnd() * total, idx = count - 1;
      for (let i = 0; i < count; i++) { target -= d2[i]; if (target <= 0) { idx = i; break; } }
      cent.push([data[idx * 3], data[idx * 3 + 1], data[idx * 3 + 2]]);
    }
    const assign = new Int32Array(count);
    for (let it = 0; it < (iters || 10); it++) {
      let changed = 0;
      for (let i = 0; i < count; i++) {
        let best = 0, bd = Infinity;
        for (let j = 0; j < cent.length; j++) {
          const dl = data[i * 3] - cent[j][0], da = data[i * 3 + 1] - cent[j][1], db = data[i * 3 + 2] - cent[j][2];
          const d = dl * dl + da * da + db * db;
          if (d < bd) { bd = d; best = j; }
        }
        if (assign[i] !== best) { assign[i] = best; changed++; }
      }
      const sums = cent.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < count; i++) {
        const s2 = sums[assign[i]];
        s2[0] += data[i * 3]; s2[1] += data[i * 3 + 1]; s2[2] += data[i * 3 + 2]; s2[3]++;
      }
      for (let j = 0; j < cent.length; j++) {
        if (sums[j][3] > 0) cent[j] = [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]];
      }
      if (changed === 0) break;
    }
    return cent;
  };

  /* Segment a preprocessed image into "clusters" (detected colors) and map
     each cluster to a palette color.
     palette: [{hex, lab}]  (lab optional)
     opts.mode: 'cluster' | 'nearest' | 'tones'
     Returns {clusterIdx: Int16Array (-1 = transparent), clusters: [{lab, hex, count, paletteIdx}]} */
  E.segment = function (pre, palette, opts) {
    opts = opts || {};
    const n = pre.w * pre.h;
    const dist = E.deltaE(opts.deltaE);
    const pal = palette.map(p => ({ hex: p.hex, lab: p.lab || E.hexToLab(p.hex) }));
    const palLabs = pal.map(p => p.lab);
    const clusterIdx = new Int16Array(n).fill(-1);
    let clusters = [];

    if (pal.length === 0) return { clusterIdx, clusters };

    if (opts.mode === 'nearest') {
      clusters = pal.map((p, i) => ({ lab: p.lab, hex: p.hex, count: 0, paletteIdx: i, kind: 'paper' }));
      const look = makeRgbCache(lab => nearestIndex(lab, palLabs, dist));
      for (let i = 0; i < n; i++) {
        if (!pre.alpha[i]) continue;
        const c = look(pre.rgb[i * 3], pre.rgb[i * 3 + 1], pre.rgb[i * 3 + 2]);
        clusterIdx[i] = c; clusters[c].count++;
      }
    } else if (opts.mode === 'tones') {
      // Luminance bands, darkest -> lightest, mapped onto opts.toneColors (palette indices)
      const tones = (opts.toneColors && opts.toneColors.length) ? opts.toneColors : pal.map((p, i) => i)
        .sort((a, b) => pal[a].lab[0] - pal[b].lab[0]);
      const bands = tones.length;
      const L = new Float32Array(n);
      const vals = [];
      for (let i = 0; i < n; i++) {
        if (!pre.alpha[i]) continue;
        const v = E.rgbToLab(pre.rgb[i * 3], pre.rgb[i * 3 + 1], pre.rgb[i * 3 + 2])[0];
        L[i] = v;
        if ((i & 7) === 0) vals.push(v);
      }
      vals.sort((a, b) => a - b);
      const thresholds = [];
      if (vals.length) {
        if (opts.toneSpread === 'equal') {
          const lo = vals[Math.floor(vals.length * 0.01)], hi = vals[Math.floor(vals.length * 0.99)];
          for (let b = 1; b < bands; b++) thresholds.push(lo + (hi - lo) * b / bands);
        } else {
          for (let b = 1; b < bands; b++) thresholds.push(vals[Math.floor(vals.length * b / bands)]);
        }
      }
      clusters = tones.map((pi, b) => ({ lab: [0, 0, 0], hex: pal[pi].hex, count: 0, paletteIdx: pi, kind: 'tone', band: b }));
      const sums = tones.map(() => [0, 0, 0]);
      for (let i = 0; i < n; i++) {
        if (!pre.alpha[i]) continue;
        let b = 0;
        while (b < thresholds.length && L[i] > thresholds[b]) b++;
        clusterIdx[i] = b; clusters[b].count++;
        if ((i & 15) === 0) {
          const lab = E.rgbToLab(pre.rgb[i * 3], pre.rgb[i * 3 + 1], pre.rgb[i * 3 + 2]);
          sums[b][0] += lab[0]; sums[b][1] += lab[1]; sums[b][2] += lab[2];
        }
      }
      clusters.forEach((c, b) => {
        const cnt = Math.max(1, Math.round(c.count / 16));
        c.lab = [sums[b][0] / cnt, sums[b][1] / cnt, sums[b][2] / cnt];
      });
    } else {
      // cluster: k-means in Lab, merge near-duplicates, drop tiny clusters, then match to paper
      const k = Math.max(1, Math.min(32, opts.k || 6));
      const sample = sampleLab(pre, 24000);
      let cent = null, bestInertia = Infinity;
      for (let run = 0; run < 3; run++) {
        const cand = E.kmeans(sample, k, 14, (opts.seed || 12345) + run * 7919);
        let inertia = 0;
        for (let i = 0; i < sample.count; i++) {
          const lab = [sample.data[i * 3], sample.data[i * 3 + 1], sample.data[i * 3 + 2]];
          let bd = Infinity; for (const c of cand) { const d = (lab[0] - c[0]) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2; if (d < bd) bd = d; }
          inertia += bd;
        }
        if (inertia < bestInertia) { bestInertia = inertia; cent = cand; }
      }
      const mergeTol = opts.merge == null ? 8 : opts.merge;
      const minShare = opts.minShare == null ? 0.01 : opts.minShare;
      const sampleCounts = () => {
        const cnt = new Float64Array(cent.length);
        for (let i = 0; i < sample.count; i++) {
          const lab = [sample.data[i * 3], sample.data[i * 3 + 1], sample.data[i * 3 + 2]];
          cnt[nearestIndex(lab, cent, E.deltaE76)]++;
        }
        return cnt;
      };
      let cnt = sampleCounts();
      // merge centroids closer than mergeTol (weighted by pixel count)
      let merged = true;
      while (merged && cent.length > 1) {
        merged = false;
        let bi = -1, bj = -1, bd = Infinity;
        for (let i = 0; i < cent.length; i++) for (let j = i + 1; j < cent.length; j++) {
          const d = E.deltaE76(cent[i], cent[j]);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
        if (bd < mergeTol) {
          const wi = cnt[bi] || 1, wj = cnt[bj] || 1;
          cent[bi] = [0, 1, 2].map(c => (cent[bi][c] * wi + cent[bj][c] * wj) / (wi + wj));
          cent.splice(bj, 1); cnt = sampleCounts(); merged = true;
        }
      }
      // drop clusters holding less than minShare of the pixels; their pixels fall to the nearest survivor
      for (let it = 0; it < 6 && cent.length > 1; it++) {
        let smallest = -1, sv = Infinity;
        for (let i = 0; i < cent.length; i++) { const sh = cnt[i] / Math.max(1, sample.count); if (sh < minShare && sh < sv) { sv = sh; smallest = i; } }
        if (smallest < 0) break;
        cent.splice(smallest, 1); cnt = sampleCounts();
      }
      clusters = cent.map(c => {
        const rgb = E.labToRgb(c[0], c[1], c[2]);
        return { lab: c, hex: E.rgbToHex(rgb[0], rgb[1], rgb[2]), count: 0, paletteIdx: -1, kind: 'cluster' };
      });
      const look = makeRgbCache(lab => nearestIndex(lab, cent, E.deltaE76));
      for (let i = 0; i < n; i++) {
        if (!pre.alpha[i]) continue;
        const c = look(pre.rgb[i * 3], pre.rgb[i * 3 + 1], pre.rgb[i * 3 + 2]);
        clusterIdx[i] = c; clusters[c].count++;
      }
      // map clusters to paper, largest first. With opts.unique, prefer an unused sheet only when it is
      // nearly as close as the best one; a far-off substitute is worse than two clusters sharing a sheet.
      if (opts.assign === 'contrast' && clusters.length > 1 && pal.length > 1) {
        // Spread the detected colors across the palette's full lightness range (darkest cluster ->
        // darkest sheet, lightest -> lightest), keeping hue where a sheet of that hue exists nearby.
        const Ls = pal.map(p => p.lab[0]);
        const Lmin = Math.min.apply(null, Ls), Lmax = Math.max.apply(null, Ls);
        const byL = clusters.map((c, i) => i).sort((a, b) => clusters[a].lab[0] - clusters[b].lab[0]);
        const usedC = new Set();
        byL.forEach((ci, rank) => {
          const c = clusters[ci];
          const target = Lmin + (Lmax - Lmin) * rank / (byL.length - 1);
          let best = -1, bc = Infinity;
          pal.forEach((p, pi) => {
            if (usedC.has(pi) && usedC.size < pal.length) return;
            const cost = Math.abs(p.lab[0] - target) * 0.9 + 0.9 * Math.hypot(p.lab[1] - c.lab[1], p.lab[2] - c.lab[2]);
            if (cost < bc) { bc = cost; best = pi; }
          });
          c.paletteIdx = best; c.distance = dist(c.lab, pal[best].lab); c.bestDistance = c.distance; usedC.add(best);
        });
        return { clusterIdx, clusters };
      }
      const order = clusters.map((c, i) => i).sort((a, b) => clusters[b].count - clusters[a].count);
      const used = new Set();
      for (const ci of order) {
        const c = clusters[ci];
        const ranked = pal.map((p, i) => ({ i, d: dist(c.lab, p.lab) })).sort((a, b) => a.d - b.d);
        let pick = ranked[0];
        if (opts.unique) {
          const slack = ranked[0].d * 0.5 + 4;
          const alt = ranked.find(r => !used.has(r.i) && r.d <= ranked[0].d + slack && r.d <= 22);
          if (alt) pick = alt;
        }
        c.paletteIdx = pick.i; c.distance = pick.d; c.bestDistance = ranked[0].d; used.add(pick.i);
      }
    }
    return { clusterIdx, clusters };
  };

  // labels[i] = clusters[clusterIdx[i]].paletteIdx (with per-cluster overrides)
  E.clustersToLabels = function (clusterIdx, clusters, map) {
    const n = clusterIdx.length;
    const labels = new Int16Array(n);
    const lut = clusters.map((c, i) => (map && map[i] != null) ? map[i] : c.paletteIdx);
    for (let i = 0; i < n; i++) {
      const c = clusterIdx[i];
      labels[i] = c < 0 ? -1 : lut[c];
    }
    return labels;
  };

  /* ---------------------------------------------------------- cleanup */
  // Majority filter over a (2r+1)^2 window. Labels in [-1, maxLabel].
  E.modeFilter = function (labels, w, h, r, maxLabel) {
    if (r <= 0) return labels;
    const out = new Int16Array(labels.length);
    const counts = new Int32Array(maxLabel + 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        counts.fill(0);
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        for (let yy = y0; yy <= y1; yy++) {
          let idx = yy * w + x0;
          for (let xx = x0; xx <= x1; xx++, idx++) counts[labels[idx] + 1]++;
        }
        const own = labels[y * w + x];
        let best = own, bc = counts[own + 1];
        for (let l = 0; l < counts.length; l++) if (counts[l] > bc) { bc = counts[l]; best = l - 1; }
        out[y * w + x] = best;
      }
    }
    return out;
  };

  // Connected components (4-connectivity) of equal labels.
  // Returns {comp: Int32Array, count, sizes: Int32Array, order: Int32Array, start: Int32Array, label: Int16Array}
  E.components = function (labels, w, h, eightConnected) {
    const n = w * h;
    const comp = new Int32Array(n).fill(-1);
    const order = new Int32Array(n);
    const starts = [], sizes = [], clabel = [];
    const stack = new Int32Array(n);
    let pos = 0, count = 0;
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1) continue;
      const L = labels[s];
      let sp = 0; stack[sp++] = s; comp[s] = count;
      const start = pos;
      while (sp > 0) {
        const i = stack[--sp];
        order[pos++] = i;
        const x = i % w, y = (i / w) | 0;
        if (x > 0 && comp[i - 1] === -1 && labels[i - 1] === L) { comp[i - 1] = count; stack[sp++] = i - 1; }
        if (x < w - 1 && comp[i + 1] === -1 && labels[i + 1] === L) { comp[i + 1] = count; stack[sp++] = i + 1; }
        if (y > 0 && comp[i - w] === -1 && labels[i - w] === L) { comp[i - w] = count; stack[sp++] = i - w; }
        if (y < h - 1 && comp[i + w] === -1 && labels[i + w] === L) { comp[i + w] = count; stack[sp++] = i + w; }
        if (eightConnected) {
          if (x > 0 && y > 0 && comp[i - w - 1] === -1 && labels[i - w - 1] === L) { comp[i - w - 1] = count; stack[sp++] = i - w - 1; }
          if (x < w - 1 && y > 0 && comp[i - w + 1] === -1 && labels[i - w + 1] === L) { comp[i - w + 1] = count; stack[sp++] = i - w + 1; }
          if (x > 0 && y < h - 1 && comp[i + w - 1] === -1 && labels[i + w - 1] === L) { comp[i + w - 1] = count; stack[sp++] = i + w - 1; }
          if (x < w - 1 && y < h - 1 && comp[i + w + 1] === -1 && labels[i + w + 1] === L) { comp[i + w + 1] = count; stack[sp++] = i + w + 1; }
        }
      }
      starts.push(start); sizes.push(pos - start); clabel.push(L);
      count++;
    }
    starts.push(pos);
    return { comp, count, sizes: Int32Array.from(sizes), start: Int32Array.from(starts), order, label: Int16Array.from(clabel) };
  };

  // Reassign components smaller than minArea px to their dominant neighbour label.
  // keepLabel: a label that is never absorbed (e.g. -1 when transparency must survive) or null.
  E.despeckle = function (labels, w, h, minArea, passes, maxLabel, keepLabel) {
    if (minArea <= 1) return labels;
    labels = Int16Array.from(labels);
    const counts = new Int32Array(maxLabel + 2);
    for (let p = 0; p < (passes || 2); p++) {
      const cc = E.components(labels, w, h, false);
      const small = [];
      for (let c = 0; c < cc.count; c++) if (cc.sizes[c] < minArea && cc.label[c] !== keepLabel) small.push(c);
      if (!small.length) break;
      small.sort((a, b) => cc.sizes[a] - cc.sizes[b]);
      for (const c of small) {
        counts.fill(0);
        const own = cc.label[c];
        for (let k = cc.start[c]; k < cc.start[c + 1]; k++) {
          const i = cc.order[k], x = i % w, y = (i / w) | 0;
          if (x > 0 && cc.comp[i - 1] !== c) counts[labels[i - 1] + 1]++;
          if (x < w - 1 && cc.comp[i + 1] !== c) counts[labels[i + 1] + 1]++;
          if (y > 0 && cc.comp[i - w] !== c) counts[labels[i - w] + 1]++;
          if (y < h - 1 && cc.comp[i + w] !== c) counts[labels[i + w] + 1]++;
        }
        let best = -2, bc = 0;
        for (let l = 0; l < counts.length; l++) if (l - 1 !== own && counts[l] > bc) { bc = counts[l]; best = l - 1; }
        if (best === -2) continue;
        for (let k = cc.start[c]; k < cc.start[c + 1]; k++) labels[cc.order[k]] = best;
      }
    }
    return labels;
  };

  /* ------------------------------------------------------------ edges */
  // Sobel magnitude on luma of pre.rgb; returns Float32Array normalised 0..1
  E.sobel = function (pre) {
    const { w, h, rgb } = pre;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = E.luma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    const out = new Float32Array(w * h);
    let max = 1e-6;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -g[i - w - 1] + g[i - w + 1] - 2 * g[i - 1] + 2 * g[i + 1] - g[i + w - 1] + g[i + w + 1];
        const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
        const m = Math.hypot(gx, gy);
        out[i] = m; if (m > max) max = m;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] /= max;
    return out;
  };

  // Mask of pixels where the label differs from a right/down neighbour.
  E.labelBoundaries = function (labels, w, h) {
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] < 0) continue;
      if ((x < w - 1 && labels[i + 1] !== labels[i] && labels[i + 1] >= 0) ||
          (y < h - 1 && labels[i + w] !== labels[i] && labels[i + w] >= 0)) m[i] = 1;
    }
    return m;
  };

  E.thresholdMask = function (values, t) {
    const m = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) m[i] = values[i] >= t ? 1 : 0;
    return m;
  };

  /* ------------------------------------------------------ morphology */
  // Square-structuring-element dilate/erode by radius r (separable max/min).
  function sepFilter(mask, w, h, r, isMax) {
    if (r <= 0) return mask;
    const tmp = new Uint8Array(mask.length);
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = isMax ? 0 : 1;
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        for (let xx = x0; xx <= x1; xx++) { const m = mask[y * w + xx]; if (isMax ? m : !m) { v = isMax ? 1 : 0; break; } }
        if (!isMax && (x - r < 0 || x + r > w - 1)) v = 0; // image border counts as outside
        tmp[y * w + x] = v;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = isMax ? 0 : 1;
        const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
        for (let yy = y0; yy <= y1; yy++) { const m = tmp[yy * w + x]; if (isMax ? m : !m) { v = isMax ? 1 : 0; break; } }
        if (!isMax && (y - r < 0 || y + r > h - 1)) v = 0;
        out[y * w + x] = v;
      }
    }
    return out;
  }
  /* Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher): for every pixel,
     the squared distance to the nearest pixel where `inside(i)` is true. O(n). */
  E.edt = function (w, h, inside) {
    const INF = 1e12;
    const f = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) f[i] = inside(i) ? 0 : INF;
    const n = Math.max(w, h);
    const d = new Float64Array(n), z = new Float64Array(n + 1), v = new Int32Array(n), col = new Float64Array(n);
    const dt1 = (len, stride, base) => {
      for (let q = 0; q < len; q++) col[q] = f[base + q * stride];
      let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s;
        while (true) {
          const vk = v[k];
          s = ((col[q] + q * q) - (col[vk] + vk * vk)) / (2 * q - 2 * vk);
          if (s <= z[k] && k > 0) k--; else break;
        }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        const vk = v[k];
        d[q] = (q - vk) * (q - vk) + col[vk];
      }
      for (let q = 0; q < len; q++) f[base + q * stride] = d[q];
    };
    for (let y = 0; y < h; y++) dt1(w, 1, y * w);
    for (let x = 0; x < w; x++) dt1(h, w, x);
    return f;
  };
  // Round structuring element: pixels within Euclidean distance r of the set (dilate) or farther than
  // r from the complement and the image border (erode). Diagonal edges stay smooth.
  E.dilate = function (mask, w, h, r) {
    if (r <= 0) return mask;
    const d2 = E.edt(w, h, i => mask[i] === 1), r2 = r * r + 0.25;
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < out.length; i++) out[i] = d2[i] <= r2 ? 1 : 0;
    return out;
  };
  E.erode = function (mask, w, h, r) {
    if (r <= 0) return mask;
    const d2 = E.edt(w, h, i => mask[i] === 0), r2 = r * r + 0.25;
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const border = Math.min(x + 1, y + 1, w - x, h - y); // distance to outside the image
      out[i] = (d2[i] > r2 && border * border > r2) ? 1 : 0;
    }
    return out;
  };
  // Opening (removes necks/strips thinner than ~2r+1 px) followed by closing (fills slits thinner than that).
  // Returns {mask, removed} where removed counts pixels the opening took away.
  E.openClose = function (mask, w, h, r) {
    if (r <= 0) return { mask, removed: 0 };
    const opened = E.dilate(E.erode(mask, w, h, r), w, h, r);
    let removed = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] && !opened[i]) removed++;
    const closed = E.erode(E.dilate(opened, w, h, r), w, h, r);
    return { mask: closed, removed };
  };
  E.maskOr = function (a, b) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] | b[i]; return o; };
  E.maskAndNot = function (a, b) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] & (b[i] ^ 1); return o; };

  /* ----------------------------------------------------------- layers */
  /* order: array of label indices, bottom -> top.
     mode: 'stacked' (each sheet = its color + everything above it) or 'inlay' (flat puzzle).
     opts.underlap: px dilation applied to every layer except the top one (inlay only)
     opts.backing: {label, offset} optional extra full-silhouette sheet at the very bottom
     Returns [{label, mask, coverage}] bottom -> top. */
  E.buildLayers = function (labels, w, h, order, mode, opts) {
    opts = opts || {};
    const n = w * h;
    const layers = [];
    const inOrder = new Uint8Array(order.length ? Math.max.apply(null, order) + 2 : 1);
    order.forEach(l => { inOrder[l + 1] = 1; });
    if (mode === 'stacked') {
      // rank[label] = position in order; mask_i = labels with rank >= i
      const rank = new Int16Array(inOrder.length).fill(-1);
      order.forEach((l, i) => { rank[l + 1] = i; });
      const rk = new Int16Array(n);
      for (let i = 0; i < n; i++) rk[i] = labels[i] < 0 ? -1 : rank[labels[i] + 1];
      for (let i = 0; i < order.length; i++) {
        const mask = new Uint8Array(n);
        let cov = 0;
        for (let p = 0; p < n; p++) if (rk[p] >= i) { mask[p] = 1; cov++; }
        layers.push({ label: order[i], mask, coverage: cov / n });
      }
    } else {
      for (let i = 0; i < order.length; i++) {
        let mask = new Uint8Array(n);
        let cov = 0;
        for (let p = 0; p < n; p++) if (labels[p] === order[i]) { mask[p] = 1; cov++; }
        if (opts.underlap > 0 && i < order.length - 1) mask = E.dilate(mask, w, h, opts.underlap);
        layers.push({ label: order[i], mask, coverage: cov / n });
      }
    }
    if (opts.minFeature > 0) {
      for (const L of layers) { const r = E.openClose(L.mask, w, h, opts.minFeature); L.mask = r.mask; L.thinRemoved = r.removed; }
    }
    // The thin-feature opening can split a sheet into fragments; keep only the largest maxPieces of them.
    if (opts.maxPieces > 0) {
      for (const L of layers) {
        const cc = E.components(L.mask, w, h, true);
        const comps = []; for (let c = 0; c < cc.count; c++) if (cc.label[c] === 1) comps.push(c);
        if (comps.length <= opts.maxPieces) continue;
        comps.sort((a, b) => cc.sizes[b] - cc.sizes[a]);
        let dropped = 0;
        for (const c of comps.slice(opts.maxPieces)) { for (let k = cc.start[c]; k < cc.start[c + 1]; k++) L.mask[cc.order[k]] = 0; dropped += cc.sizes[c]; }
        L.fragmentsDropped = dropped;
      }
    }
    if (opts.backing && opts.backing.label != null) {
      let mask = new Uint8Array(n);
      let cov = 0;
      for (let p = 0; p < n; p++) if (labels[p] >= 0 && inOrder[labels[p] + 1]) { mask[p] = 1; cov++; }
      if (opts.backing.offset > 0) mask = E.dilate(mask, w, h, opts.backing.offset);
      layers.unshift({ label: opts.backing.label, mask, coverage: cov / n, backing: true });
    }
    return layers;
  };

  /* Continuity: keep at most maxPieces connected pieces per sheet. Smaller islands are
     recolored into the sheet beneath them (stacked) or their surrounding color (inlay), so each
     sheet is one easy-to-place shape plus a few big extras. skipLabel (e.g. the outline) is left alone.
     Islands surrounded by transparency are kept: they are separate objects, not noise. */
  E.limitPieces = function (labels, w, h, order, mode, maxPieces, skipLabel) {
    if (!(maxPieces > 0) || !order.length) return labels;
    labels = Int16Array.from(labels);
    const n = w * h;
    let maxLabel = 0; for (const l of order) if (l > maxLabel) maxLabel = l;
    for (let i = 0; i < labels.length; i++) if (labels[i] > maxLabel) maxLabel = labels[i];
    const rankOf = new Int16Array(maxLabel + 2).fill(-1);
    order.forEach((l, i) => { rankOf[l + 1] = i; });
    const counts = new Int32Array(maxLabel + 2);
    const mask = new Uint8Array(n);
    for (let i = 0; i < order.length; i++) {
      if (order[i] === skipLabel) continue;
      for (let p = 0; p < n; p++) {
        const r = labels[p] < 0 ? -1 : rankOf[labels[p] + 1];
        mask[p] = mode === 'stacked' ? (r >= i ? 1 : 0) : (r === i ? 1 : 0);
      }
      const cc = E.components(mask, w, h, true);
      const comps = [];
      for (let c = 0; c < cc.count; c++) if (cc.label[c] === 1) comps.push(c);
      if (comps.length <= maxPieces) continue;
      comps.sort((a, b) => cc.sizes[b] - cc.sizes[a]);
      for (const c of comps.slice(maxPieces)) {
        counts.fill(0);
        for (let k = cc.start[c]; k < cc.start[c + 1]; k++) {
          const p = cc.order[k], x = p % w, y = (p / w) | 0;
          if (x > 0 && cc.comp[p - 1] !== c) counts[labels[p - 1] + 1]++;
          if (x < w - 1 && cc.comp[p + 1] !== c) counts[labels[p + 1] + 1]++;
          if (y > 0 && cc.comp[p - w] !== c) counts[labels[p - w] + 1]++;
          if (y < h - 1 && cc.comp[p + w] !== c) counts[labels[p + w] + 1]++;
        }
        let best = -2, bc = 0;
        for (let l = 0; l < counts.length; l++) if (counts[l] > bc) { bc = counts[l]; best = l - 1; }
        if (best === -2 || best === -1) continue; // nothing around it, or transparency: keep the island
        if (mode === 'stacked' && rankOf[best + 1] >= i) continue;
        for (let k = cc.start[c]; k < cc.start[c + 1]; k++) labels[cc.order[k]] = best;
      }
    }
    return labels;
  };

  /* ---------------------------------------------------------- contours */
  /* Trace the boundary of a binary mask into closed loops (flat [x0,y0,x1,y1,...] in pixel-corner
     coordinates). Outer loops run clockwise on screen (positive shoelace area), holes run
     counter-clockwise, so fill-rule="evenodd" renders them correctly. */
  E.traceMask = function (mask, w, h) {
    const W = w + 1, V = W * (h + 1);
    const out0 = new Int8Array(V).fill(-1), out1 = new Int8Array(V).fill(-1);
    const addEdge = (v, d) => { if (out0[v] < 0) out0[v] = d; else out1[v] = d; };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (y === 0 || !mask[i - w]) addEdge(y * W + x, 0);             // top edge, heading right
        if (x === w - 1 || !mask[i + 1]) addEdge(y * W + x + 1, 1);     // right edge, heading down
        if (y === h - 1 || !mask[i + w]) addEdge((y + 1) * W + x + 1, 2); // bottom edge, heading left
        if (x === 0 || !mask[i - 1]) addEdge((y + 1) * W + x, 3);       // left edge, heading up
      }
    }
    const step = [1, W, -1, -W];
    const loops = [];
    const takeEdge = (v, prevDir) => {
      const a = out0[v], b = out1[v];
      if (a < 0 && b < 0) return -1;
      if (a >= 0 && b >= 0 && prevDir >= 0) {
        // saddle: prefer the right turn so diagonal-only touching pixels stay separate pieces
        const want = (prevDir + 1) & 3;
        if (a === want) { out0[v] = -1; return a; }
        if (b === want) { out1[v] = -1; return b; }
      }
      if (a >= 0) { out0[v] = -1; return a; }
      out1[v] = -1; return b;
    };
    for (let v0 = 0; v0 < V; v0++) {
      while (out0[v0] >= 0 || out1[v0] >= 0) {
        const pts = [];
        let v = v0, d = takeEdge(v, -1), prev = d;
        pts.push(v % W, (v / W) | 0);
        let guard = 0;
        while (true) {
          v += step[d];
          if (v === v0) break;
          const nd = takeEdge(v, d);
          if (nd < 0) break; // should not happen on a closed boundary
          if (nd !== prev) { pts.push(v % W, (v / W) | 0); prev = nd; }
          d = nd;
          if (++guard > V * 4) break;
        }
        // drop the start vertex if it is collinear with its neighbours
        if (pts.length >= 6) {
          const x0 = pts[0], y0 = pts[1], x1 = pts[2], y1 = pts[3], xl = pts[pts.length - 2], yl = pts[pts.length - 1];
          if ((x0 === x1 && x0 === xl) || (y0 === y1 && y0 === yl)) { pts.shift(); pts.shift(); }
        }
        if (pts.length >= 6) loops.push(pts);
      }
    }
    return loops;
  };

  E.loopArea = function (pts) {
    let a = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
    }
    return a / 2;
  };

  // Douglas–Peucker on a closed loop.
  E.simplify = function (pts, tol) {
    const n = pts.length / 2;
    if (tol <= 0 || n <= 4) return pts;
    // split at the vertex farthest from vertex 0
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) {
      const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    const keep = new Uint8Array(n);
    keep[0] = 1; keep[far] = 1;
    const t2 = tol * tol;
    const stack = [[0, far], [far, n]]; // second range wraps to index 0 (n stands for 0)
    const px = i => pts[(i % n) * 2], py = i => pts[(i % n) * 2 + 1];
    while (stack.length) {
      const [s, e] = stack.pop();
      if (e - s < 2) continue;
      const ax = px(s), ay = py(s), bx = px(e), by = py(e);
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let maxd = -1, mi = -1;
      for (let i = s + 1; i < e; i++) {
        const x = px(i), y = py(i);
        let d;
        if (len2 === 0) d = (x - ax) ** 2 + (y - ay) ** 2;
        else {
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
          d = (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2;
        }
        if (d > maxd) { maxd = d; mi = i; }
      }
      if (maxd > t2) { keep[mi % n] = 1; stack.push([s, mi], [mi, e]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
    return out.length >= 6 ? out : pts;
  };

  // Chaikin corner cutting on a closed loop.
  E.chaikin = function (pts, iters) {
    let p = pts;
    for (let k = 0; k < (iters || 0); k++) {
      const n = p.length / 2, out = new Array(n * 4);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = p[i * 2], y0 = p[i * 2 + 1], x1 = p[j * 2], y1 = p[j * 2 + 1];
        out[i * 4] = 0.75 * x0 + 0.25 * x1; out[i * 4 + 1] = 0.75 * y0 + 0.25 * y1;
        out[i * 4 + 2] = 0.25 * x0 + 0.75 * x1; out[i * 4 + 3] = 0.25 * y0 + 0.75 * y1;
      }
      p = out;
    }
    return p;
  };

  // Chaikin with the cut distance capped at `maxCut` px: smooths pixel steps, leaves long edges and
  // their corners untouched.
  E.chaikinLimited = function (pts, maxCut) {
    const n = pts.length / 2, out = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[j * 2], y1 = pts[j * 2 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const t = Math.min(0.25, maxCut / len);
      out.push(x0 + t * (x1 - x0), y0 + t * (y1 - y0), x1 - t * (x1 - x0), y1 - t * (y1 - y0));
    }
    return out;
  };

  /* Mask -> cleaned loops with stats.
     opts: {tolerance px, round (chaikin iterations), minLoopArea px²} */
  E.maskToLoops = function (mask, w, h, opts) {
    opts = opts || {};
    const raw = E.traceMask(mask, w, h);
    const loops = [];
    let pieces = 0, holes = 0;
    for (let pts of raw) {
      const area0 = E.loopArea(pts);
      if (Math.abs(area0) < (opts.minLoopArea || 0)) continue;
      // One corner-cut pass on the raw pixel staircase turns 90-degree steps into 45-degree ones, so
      // the simplifier sees the true shape instead of the pixel grid.
      if (opts.preRound > 0) pts = E.chaikinLimited(pts, 1);
      pts = E.simplify(pts, opts.tolerance || 0);
      if (opts.round > 0) { pts = E.chaikin(pts, opts.round); pts = E.simplify(pts, 0.35); }
      const area = E.loopArea(pts);
      if (area > 0) pieces++; else holes++;
      loops.push({ pts, area });
    }
    return { loops, pieces, holes };
  };

  /* Path data for a set of closed loops. With `curves`, each loop is written as cubic Beziers:
     tangents are shared between neighbouring segments for smoothness, handle lengths are capped
     at 30% of the segment so long edges stay straight, and vertices where the direction turns by
     more than `cornerDeg` keep a sharp corner. Cutters render this smoothly with far fewer nodes. */
  // Walks one closed loop as the segments pathD writes: line(x1, y1) or cubic(c1x, c1y, c2x, c2y, x1, y1),
  // starting at vertex 0. Shared by the SVG writer and flattenLoops so every export follows the same curve.
  function walkLoop(p, curves, cosCorner, line, cubic) {
    const n = p.length / 2;
    if (!curves || n < 3) { for (let i = 1; i <= n; i++) line(p[(i % n) * 2], p[(i % n) * 2 + 1]); return; }
    const X = i => p[((i % n) + n) % n * 2], Y = i => p[((i % n) + n) % n * 2 + 1];
    // unit tangent at vertex i, or null at a corner
    const tangent = i => {
      const ax = X(i) - X(i - 1), ay = Y(i) - Y(i - 1), bx = X(i + 1) - X(i), by = Y(i + 1) - Y(i);
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      const cos = (ax * bx + ay * by) / (la * lb);
      if (cos < cosCorner) return null;
      const tx = ax / la + bx / lb, ty = ay / la + by / lb;
      const lt = Math.hypot(tx, ty) || 1;
      return [tx / lt, ty / lt];
    };
    const T = []; for (let i = 0; i < n; i++) T.push(tangent(i));
    for (let i = 0; i < n; i++) {
      const x0 = X(i), y0 = Y(i), x1 = X(i + 1), y1 = Y(i + 1);
      const sx = x1 - x0, sy = y1 - y0, len = Math.hypot(sx, sy) || 1;
      const t0 = T[i] || [sx / len, sy / len], t1 = T[(i + 1) % n] || [sx / len, sy / len];
      if (!T[i] && !T[(i + 1) % n]) { line(x1, y1); continue; }
      const h = len * 0.3;
      cubic(x0 + t0[0] * h, y0 + t0[1] * h, x1 - t1[0] * h, y1 - t1[1] * h, x1, y1);
    }
  }
  const cosOf = cornerDeg => Math.cos((cornerDeg == null ? 48 : cornerDeg) * Math.PI / 180);

  E.pathD = function (loops, decimals, curves, cornerDeg) {
    const f = v => Number(v.toFixed(decimals == null ? 2 : decimals));
    const cosCorner = cosOf(cornerDeg);
    let d = '';
    for (const L of loops) {
      const p = L.pts || L;
      const n = p.length / 2;
      d += 'M' + f(p[0]) + ' ' + f(p[1]);
      if (!curves || n < 3) {
        for (let i = 2; i < p.length; i += 2) d += 'L' + f(p[i]) + ' ' + f(p[i + 1]);
        d += 'Z';
        continue;
      }
      walkLoop(p, true, cosCorner,
        (x, y) => { d += 'L' + f(x) + ' ' + f(y); },
        (a, b, c, e, x, y) => { d += 'C' + f(a) + ' ' + f(b) + ' ' + f(c) + ' ' + f(e) + ' ' + f(x) + ' ' + f(y); });
      d += 'Z';
    }
    return d;
  };

  /* The same outlines as pathD, as plain polygons: each Bezier is sampled so the chord stays within
     `tol` (same units as the loops) of the curve. Used for GDS and raster exports. */
  E.flattenLoops = function (loops, curves, cornerDeg, tol) {
    const cosCorner = cosOf(cornerDeg), t = tol || 0.1;
    return loops.map(L => {
      const p = L.pts || L, out = [p[0], p[1]];
      let px = p[0], py = p[1];
      walkLoop(p, curves, cosCorner,
        (x, y) => { out.push(x, y); px = x; py = y; },
        (ax, ay, bx, by, x, y) => {
          // control-polygon deviation bounds the curve's distance from its chord
          const dev = Math.max(Math.hypot(ax - (2 * px + x) / 3, ay - (2 * py + y) / 3), Math.hypot(bx - (px + 2 * x) / 3, by - (py + 2 * y) / 3));
          const k = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(dev / t) * 1.5)));
          for (let s = 1; s <= k; s++) {
            const u = s / k, v = 1 - u;
            out.push(v * v * v * px + 3 * v * v * u * ax + 3 * v * u * u * bx + u * u * u * x,
                     v * v * v * py + 3 * v * v * u * ay + 3 * v * u * u * by + u * u * u * y);
          }
          px = x; py = y;
        });
      out.length -= 2;   // the walk ends back on vertex 0
      return out;
    });
  };
  E.nodeCount = loops => loops.reduce((a, L) => a + (L.pts || L).length / 2, 0);

  /* --------------------------------------------------------------- SVG */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  E.slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';

  /* spec: {w, h, widthIn, margin (px), layers: [{id, name, hex, d}], regMarks, title}
     Each layer becomes one <g> with one evenodd <path>, which Design Space imports as one layer. */
  E.buildSvg = function (spec) {
    const m = spec.margin || 0;
    const vbW = spec.w + 2 * m, vbH = spec.h + 2 * m;
    const ppi = spec.w / spec.widthIn;
    const outW = (vbW / ppi).toFixed(4), outH = (vbH / ppi).toFixed(4);
    let s = '<?xml version="1.0" encoding="UTF-8"?>\n';
    s += `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}in" height="${outH}in" viewBox="${-m} ${-m} ${vbW} ${vbH}">\n`;
    if (spec.title) s += `  <title>${esc(spec.title)}</title>\n`;
    let marks = '';
    if (spec.regMarks && m > 0) {
      const sz = Math.min(m * 0.6, ppi * 0.25);
      const corners = [[-m, -m], [spec.w + m - sz, -m], [-m, spec.h + m - sz], [spec.w + m - sz, spec.h + m - sz]];
      marks = corners.map(([x, y]) => `M${x} ${y}h${sz}v${sz}h${-sz}Z`).join('');
    }
    spec.layers.forEach((L, i) => {
      const id = esc(L.id || ('L' + String(i + 1).padStart(2, '0') + '-' + E.slug(L.name)));
      // fill on every path: Design Space reads the path's own fill, not the group's
      s += `  <g id="${id}">\n`;
      s += `    <path id="${id}-cut" fill="${esc(L.hex)}" stroke="none" fill-rule="evenodd" d="${L.d}"/>\n`;
      if (marks) s += `    <path id="${id}-marks" fill="${esc(L.hex)}" stroke="none" d="${marks}"/>\n`;
      s += '  </g>\n';
    });
    s += '</svg>\n';
    return s;
  };

  /* ------------------------------------------------------------ utils */
  E.maskStats = function (mask) {
    let c = 0; for (let i = 0; i < mask.length; i++) c += mask[i];
    return c;
  };
  E.fillRegion = function (labels, w, h, x, y, newLabel, target) {
    const n = w * h, start = y * w + x;
    if (start < 0 || start >= n) return 0;
    const L = target == null ? labels[start] : target;
    if (L === newLabel) return 0;
    const stack = [start];
    const seen = new Uint8Array(n);
    seen[start] = 1;
    let changed = 0;
    const touched = [];
    while (stack.length) {
      const i = stack.pop();
      touched.push(i); changed++;
      const px = i % w, py = (i / w) | 0;
      const nb = [];
      if (px > 0) nb.push(i - 1);
      if (px < w - 1) nb.push(i + 1);
      if (py > 0) nb.push(i - w);
      if (py < h - 1) nb.push(i + w);
      for (const j of nb) if (!seen[j] && labels[j] === L) { seen[j] = 1; stack.push(j); }
    }
    return touched;
  };

  return E;
});
