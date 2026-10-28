/* optics.js — structural-colour physics for the lithography modes: what colour a nanostructure shows,
   and which structure gives a wanted colour. No DOM access, no dependencies. Works in the browser
   (window.CutOptics), in a worker (self.CutOptics) or in Node (module.exports).

   Units and conventions
     wavelengths and all lengths in nm; angles in degrees; colours as sRGB [r,g,b] 0..255 or '#rrggbb'.
     Complex refractive index N = n + ik (k >= 0 absorbs), time dependence e^{-iωt}.
     Sample surface = xy plane, z = up. Elevation is measured FROM THE SURFACE (90 = straight above),
     azimuth counter-clockwise from +x. Grating lineAngleDeg is the direction the lines run in;
     the grating vector is perpendicular to it (lineAngleDeg + 90).
     Fab limits (FAB): smallest feature 100 nm, smallest gap 100 nm, heights/depths 10–500 nm.

   Sections: colour science · optical constants · thin films · gratings · pillars/nanodisks (estimates)
             · measured libraries (CSV) · nearest colour                                               */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CutOptics = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const O = {};
  O.FAB = { minFeatureNm: 100, minGapNm: 100, minHeightNm: 10, maxHeightNm: 500 };
  const PI = Math.PI, rad = d => d * PI / 180;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const num = (v, d) => (v == null || v === '' || !isFinite(+v)) ? d : +v;

  /* ============================================================ colour science */
  /* CIE 1931 2° colour-matching functions, multi-lobe piecewise-Gaussian fit of Wyman, Sloan & Shirley,
     "Simple analytic approximations to the CIE XYZ color matching functions", JCGT 2(2), 2013.
     Max error vs the CIE table is a few % of peak; plenty for previews. */
  const lobe = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
  O.cmf = l => [
    1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
    0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
    1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8)];
  // CIE standard illuminant D65 relative spectral power, 380–780 nm every 10 nm (CIE 15:2004 / ISO 11664-2)
  const D65 = [49.9755, 54.6482, 82.7549, 91.486, 93.4318, 86.6823, 104.865, 117.008, 117.812, 114.861, 115.923,
    108.811, 109.354, 107.802, 104.79, 107.689, 104.405, 104.046, 100, 96.3342, 95.788, 88.6856, 90.0062, 89.5991,
    87.6987, 83.2886, 83.6992, 80.0268, 80.2146, 82.2778, 78.2842, 69.7213, 71.6091, 74.349, 61.604, 69.8856,
    75.087, 63.5927, 46.4182, 66.8054, 63.3828];
  O.d65 = l => { const x = (clamp(l, 380, 780) - 380) / 10, i = Math.min(39, Math.floor(x)), f = x - i; return D65[i] * (1 - f) + D65[i + 1] * f; };

  // integration grid: 380–780 nm, 5 nm; weights = CMF × D65, normalised so a perfect white reflector has Y = 1
  const LAM = [], WX = [], WY = [], WZ = [];
  for (let l = 380; l <= 780; l += 5) { const c = O.cmf(l), s = O.d65(l); LAM.push(l); WX.push(c[0] * s); WY.push(c[1] * s); WZ.push(c[2] * s); }
  const YN = WY.reduce((a, v) => a + v, 0);
  for (let i = 0; i < LAM.length; i++) { WX[i] /= YN; WY[i] /= YN; WZ[i] /= YN; }
  O.wavelengths = LAM.slice();

  // XYZ -> linear sRGB (IEC 61966-2-1). The fitted CMFs put the D65 white a hair off sRGB's white, so
  // each channel is rescaled once (WB) so that the white reflector lands exactly on (1,1,1).
  const toLin = (X, Y, Z) => [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
  const WB = toLin(WX.reduce((a, v) => a + v, 0), 1, WZ.reduce((a, v) => a + v, 0)).map(v => 1 / v);
  O.xyzToLinearRgb = (X, Y, Z) => toLin(X, Y, Z).map((v, i) => v * WB[i]);
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  /* Out-of-gamut handling that keeps hue: slide the colour toward the grey of the same luminance until
     every channel is inside [0, hi]. Both limits are linear in the slide factor, so one min() does it.
     A colour brighter than white (Y >= hi) becomes white. */
  function fitGamut(c, hi) {
    hi = hi == null ? 1 : hi;
    const Y = lum(c);
    if (Y <= 0) return [0, 0, 0];
    if (Y >= hi) return [hi, hi, hi];
    const lo = Math.min(c[0], c[1], c[2]), up = Math.max(c[0], c[1], c[2]);
    let t = 1;
    if (lo < 0) t = Math.min(t, Y / (Y - lo));
    if (up > hi) t = Math.min(t, (hi - Y) / (up - Y));
    return t === 1 ? c.slice() : c.map(v => Y + t * (v - Y));
  }
  O.fitGamut = fitGamut;
  const gamma = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  O.linearToRgb = c => fitGamut(c).map(v => Math.round(clamp(gamma(v), 0, 255)));
  O.rgbToHex = function (r, g, b) {
    if (Array.isArray(r)) { b = r[2]; g = r[1]; r = r[0]; }
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  };
  O.hexToRgb = function (hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  // reflectance spectrum (fn(λ) -> 0..1) under D65 -> XYZ (Y = 1 for a perfect white reflector)
  O.spectrumToXyz = function (fn) {
    let X = 0, Y = 0, Z = 0;
    for (let i = 0; i < LAM.length; i++) { const r = fn(LAM[i]); X += r * WX[i]; Y += r * WY[i]; Z += r * WZ[i]; }
    return [X, Y, Z];
  };
  /* -> [r,g,b] 0..255. opts.exposure scales the light (1 = the reflector seen beside a white card that
     shows as 255). Perfect white reflector -> (255,255,255). */
  O.spectrumToRgb = function (fn, opts) {
    const e = num(opts && opts.exposure, 1), xyz = O.spectrumToXyz(fn);
    return O.linearToRgb(O.xyzToLinearRgb(xyz[0] * e, xyz[1] * e, xyz[2] * e));
  };

  /* Monochromatic (narrow-band, e.g. diffracted) light. Equal-energy line spectrum through the CMFs, the
     negative lobe removed hue-preservingly, then ONE global scale so the brightest spectral colour
     (~ 580–600 nm) just reaches full brightness. Colours therefore keep their true relative luminance:
     violet/deep red are dim, as the eye sees them. opts.saturation (0 grey .. 1 spectral) and
     opts.brightness (linear multiplier) adjust the result. */
  const monoLin = l => { const c = O.cmf(l); return fitGamut(O.xyzToLinearRgb(c[0], c[1], c[2]), Infinity); };
  let MONO_MAX = 0;
  for (let l = 380; l <= 780; l++) MONO_MAX = Math.max(MONO_MAX, ...monoLin(l));
  O.wavelengthToRgb = function (l, opts) {
    opts = opts || {};
    const s = clamp(num(opts.saturation, 1), 0, 1), b = Math.max(0, num(opts.brightness, 1));
    let c = monoLin(l).map(v => v / MONO_MAX);
    const Y = lum(c);
    c = c.map(v => (Y + s * (v - Y)) * b);
    return O.linearToRgb(c);
  };
  // XYZ of a sum of spectral lines [{wavelengthNm, weight}] -> rgb on the same scale as wavelengthToRgb
  function linesToRgb(lines) {
    let X = 0, Y = 0, Z = 0;
    lines.forEach(L => { const c = O.cmf(L.wavelengthNm), w = L.weight; X += c[0] * w; Y += c[1] * w; Z += c[2] * w; });
    return O.linearToRgb(fitGamut(O.xyzToLinearRgb(X, Y, Z), Infinity).map(v => v / MONO_MAX));
  }

  /* ============================================================ optical constants */
  /* material(name) -> function(λnm) -> {n, k}. Names are case/space/hyphen-insensitive ('ma-N 2400',
     'man2400', 'Fused silica' ...). Also accepts a number (constant n), an {n,k} object or a function.
     Tables are interpolated linearly in λ and held constant beyond their ends.
     Tabulated values are rounded transcriptions of the cited data sets (3 significant figures); good for
     colour previews, not for ellipsometry. */
  const table = rows => {
    rows = rows.slice().sort((a, b) => a[0] - b[0]);
    return l => {
      if (l <= rows[0][0]) return { n: rows[0][1], k: rows[0][2] };
      const last = rows[rows.length - 1];
      if (l >= last[0]) return { n: last[1], k: last[2] };
      let i = 1; while (rows[i][0] < l) i++;
      const a = rows[i - 1], b = rows[i], f = (l - a[0]) / (b[0] - a[0]);
      return { n: a[1] + f * (b[1] - a[1]), k: a[2] + f * (b[2] - a[2]) };
    };
  };
  const eV = rows => table(rows.map(r => [1239.84 / r[0], r[1], r[2]]));   // Johnson & Christy list photon energy
  // Cauchy n = A + B/λ² + C/λ⁴ (λ in µm), optional Urbach-like absorption tail below an edge
  const cauchy = (A, B, C, k0, edge, width) => l => { const u2 = (l / 1000) * (l / 1000); return { n: A + B / u2 + (C || 0) / (u2 * u2), k: k0 ? k0 * Math.exp((edge - l) / width) : 0 }; };
  // Malitson 1965 (J. Opt. Soc. Am. 55, 1205) Sellmeier for fused silica: n(550) = 1.4599
  const silica = l => { const u2 = (l / 1000) * (l / 1000); return { n: Math.sqrt(1 + 0.6961663 * u2 / (u2 - 0.0684043 ** 2) + 0.4079426 * u2 / (u2 - 0.1162414 ** 2) + 0.8974794 * u2 / (u2 - 9.896161 ** 2)), k: 0 }; };
  const MAT = {
    air: () => ({ n: 1, k: 0 }),
    // crystalline Si, 300 K: M. A. Green, Sol. Energy Mater. Sol. Cells 92, 1305 (2008), k from its α via
    // k = αλ/4π; 380–390 nm after D. E. Aspnes & A. A. Studna, Phys. Rev. B 27, 985 (1983).
    // Check: n(633) = 3.88, R(550) = 0.368.
    si: table([[380, 6.00, 0.55], [390, 5.78, 0.42], [400, 5.57, 0.30], [410, 5.36, 0.23], [420, 5.17, 0.18], [430, 4.99, 0.14],
      [440, 4.83, 0.11], [450, 4.67, 0.091], [475, 4.47, 0.064], [500, 4.30, 0.044], [525, 4.18, 0.035], [550, 4.08, 0.028],
      [575, 4.00, 0.023], [600, 3.94, 0.020], [650, 3.84, 0.0145], [700, 3.77, 0.0106], [750, 3.72, 0.0078], [800, 3.68, 0.0054]]),
    // thermal SiO2: Malitson's fused-silica Sellmeier; dry thermal oxide is within ~0.005 of it in the visible
    sio2: silica,
    'fused silica': silica,
    // PMMA: Cauchy through the Abbe-line indices n_F = 1.4973, n_D = 1.4905, n_C = 1.4880 (e.g. Sultanova et al.,
    // Acta Phys. Pol. A 116, 585 (2009)); spun 950K/495K resist films are within ~0.005.
    pmma: cauchy(1.4767, 0.00487),
    // ZEP520A: Zeon datasheet gives n ≈ 1.54–1.55 at 633 nm; dispersion assumed (aromatic polymer, stronger than PMMA)
    zep520a: cauchy(1.527, 0.0072),
    // HSQ after curing / e-beam exposure: porous SiO2-like network, n ≈ 1.40–1.42 (e.g. Dow Corning FOx data,
    // Olynick et al. JVST B 2010); between as-spun (~1.39) and dense oxide (1.46).
    hsq: cauchy(1.405, 0.0030),
    // ma-N 2400 (novolak): micro resist technology datasheet n ≈ 1.61–1.62 at 633 nm; absorbs in the near UV
    'ma-n 2400': cauchy(1.590, 0.0110, 0, 0.02, 400, 15),
    // TiO2, ALD amorphous (low-temperature ALD as used for metasurfaces): n ≈ 2.63 (400) / 2.39 (600) / 2.32 (800),
    // after R. C. Devlin et al., PNAS 113, 10473 (2016) and Z. Sun et al. / Sun et al. ACS Nano 11, 4445 (2017);
    // band-edge tail below ~420 nm.
    tio2: cauchy(2.24, 0.0445, 0.0028, 0.01, 400, 15),
    // anatase (annealed): ~0.1 higher than ALD amorphous across the visible
    'tio2 anatase': cauchy(2.34, 0.0445, 0.0028, 0.02, 410, 15),
    // Al: A. D. Rakić, Appl. Opt. 34, 4755 (1995) (Lorentz–Drude fit to Shiles/Palik data). Interband dip near 800 nm.
    al: table([[380, 0.44, 4.61], [400, 0.49, 4.86], [450, 0.62, 5.47], [500, 0.77, 6.08], [550, 0.96, 6.69], [600, 1.20, 7.26],
      [650, 1.47, 7.79], [700, 1.83, 8.31], [750, 2.40, 8.62], [800, 2.80, 8.45]]),
    // Ag and Au: P. B. Johnson & R. W. Christy, Phys. Rev. B 6, 4370 (1972), rows [eV, n, k]
    ag: eV([[1.51, 0.04, 5.727], [1.64, 0.03, 5.242], [1.76, 0.04, 4.838], [1.88, 0.05, 4.483], [2.01, 0.06, 4.152], [2.13, 0.05, 3.858],
      [2.26, 0.06, 3.586], [2.38, 0.05, 3.324], [2.50, 0.05, 3.093], [2.63, 0.05, 2.869], [2.75, 0.04, 2.657], [2.88, 0.04, 2.462],
      [3.00, 0.05, 2.275], [3.12, 0.05, 2.070], [3.25, 0.05, 1.864]]),
    au: eV([[1.51, 0.16, 5.083], [1.64, 0.14, 4.542], [1.76, 0.13, 4.103], [1.88, 0.14, 3.697], [2.01, 0.21, 3.272], [2.13, 0.29, 2.863],
      [2.26, 0.43, 2.455], [2.38, 0.62, 2.081], [2.50, 1.04, 1.833], [2.63, 1.31, 1.849], [2.75, 1.38, 1.914], [2.88, 1.45, 1.948],
      [3.00, 1.46, 1.958], [3.12, 1.47, 1.952], [3.25, 1.46, 1.933]]),
    // Cr: approximate, after A. D. Rakić et al., Appl. Opt. 37, 5271 (1998) / Johnson & Christy, PRB 9, 5056 (1974).
    // Treat as a grey absorber, R ≈ 0.55–0.6 (least certain table here).
    cr: table([[380, 1.73, 2.98], [400, 1.98, 3.13], [450, 2.38, 3.23], [500, 2.75, 3.36], [550, 3.00, 3.33], [600, 3.15, 3.31],
      [650, 3.19, 3.40], [700, 3.22, 3.57], [750, 3.25, 3.75], [800, 3.30, 3.95]])
  };
  const ALIAS = {
    vacuum: 'air', silicon: 'si', csi: 'si', crystallinesi: 'si', thermaloxide: 'sio2', oxide: 'sio2', siliconoxide: 'sio2',
    silica: 'fused silica', fusedsilica: 'fused silica', quartz: 'fused silica', glass: 'fused silica',
    pmma950k: 'pmma', pmma495k: 'pmma', zep: 'zep520a', zep520: 'zep520a', curedhsq: 'hsq', fox: 'hsq',
    man2400: 'ma-n 2400', man2403: 'ma-n 2400', man2405: 'ma-n 2400', man2410: 'ma-n 2400', man: 'ma-n 2400',
    titania: 'tio2', tio2ald: 'tio2', aldtio2: 'tio2', anatase: 'tio2 anatase', tio2anatase: 'tio2 anatase',
    aluminium: 'al', aluminum: 'al', silver: 'ag', gold: 'au', chromium: 'cr', chrome: 'cr'
  };
  const key = s => String(s).toLowerCase().replace(/[\s_\-]+/g, '');
  const BYKEY = {}; Object.keys(MAT).forEach(k => { BYKEY[key(k)] = k; });
  O.materials = () => Object.keys(MAT);
  O.material = function (name) {
    if (typeof name === 'function') return name;
    if (typeof name === 'number') return () => ({ n: name, k: 0 });
    if (name && typeof name === 'object' && 'n' in name) return () => ({ n: +name.n, k: +(name.k || 0) });
    const k = key(name || ''), id = BYKEY[k] || ALIAS[k];
    if (!id) throw new Error(`Unknown material "${name}". Known: ${Object.keys(MAT).join(', ')}.`);
    return MAT[id];
  };

  /* ============================================================ thin films */
  // minimal complex arithmetic on [re, im]
  const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]], csub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
  const cexpi = (a) => { const m = Math.exp(-a[1]); return [m * Math.cos(a[0]), m * Math.sin(a[0])]; };   // e^{i a}
  const cabs2 = a => a[0] * a[0] + a[1] * a[1];
  const fresnel = (Na, Nb) => cdiv(csub(Na, Nb), cadd(Na, Nb));          // normal incidence, a -> b
  const N = m => [m.n, m.k];

  /* Air / film (thickness d) / semi-infinite substrate at normal incidence (Airy summation, complex indices,
     so absorbing films and substrates are exact):  r = (r01 + r12 e^{2iβ}) / (1 + r01 r12 e^{2iβ}),
     β = 2π N1 d / λ. Returns |r|². d = 0 gives the bare substrate. */
  function filmR(l, fFilm, d, fSub) {
    const N0 = [1, 0], N1 = N(fFilm(l)), N2 = N(fSub(l));
    const r01 = fresnel(N0, N1), r12 = fresnel(N1, N2);
    const e = cexpi([4 * PI * N1[0] * d / l, 4 * PI * N1[1] * d / l]);
    const t = cmul(r12, e);
    return cabs2(cdiv(cadd(r01, t), cadd([1, 0], cmul(r01, t))));
  }
  O.thinFilmReflectance = (l, film, d, sub) => filmR(l, O.material(film), Math.max(0, +d || 0), O.material(sub == null ? 'si' : sub));
  O.thinFilmColor = function (film, d, sub) {
    const f = O.material(film), s = O.material(sub == null ? 'si' : sub), t = Math.max(0, +d || 0);
    const rgb = O.spectrumToRgb(l => filmR(l, f, t, s));
    return { hex: O.rgbToHex(rgb), rgb };
  };
  O.thinFilmPalette = function (film, sub, minNm, maxNm, stepNm) {
    const a = num(minNm, O.FAB.minHeightNm), b = num(maxNm, O.FAB.maxHeightNm), st = Math.max(1, num(stepNm, 10)), out = [];
    for (let t = a; t <= b + 1e-9; t += st) { const c = O.thinFilmColor(film, t, sub); out.push({ thicknessNm: +t.toFixed(3), hex: c.hex, rgb: c.rgb }); }
    return out;
  };
  /* Comparison with the published SiO2-on-Si chart (Henrie, Kellis, Schultz & Hawkins, Opt. Express 12, 1464
     (2004), which reproduces and recomputes the classic Pliskin & Conrad / Reizman descriptive chart, viewed
     straight on). thinFilmColor('SiO2', t, 'Si') at 10 nm steps (tests/js/optics-test.html prints the table):
       ours                                        chart
       0–30 nm   bluish silver-grey (bare Si)      silver / tan
       40–70     tan -> reddish brown              50 tan, 70 brown
       80–90     grey-mauve -> dark violet         100 dark violet to red-violet   (ours ~10 nm early)
       100–120   indigo -> royal blue              120 royal blue
       130–160   light / steel blue                150 light blue to metallic blue
       170–190   pale metallic, faintly green      170 metallic to very light yellow-green
       200–230   pale yellow -> gold               200 light gold, 220 gold
       240       salmon-orange                     250 orange to melon             (ours ~10 nm early)
       250–260   rose -> red-violet                270 red-violet                  (ours ~10–15 nm early)
       280–300   violet -> blue                    300 blue to violet-blue
       310–360   blue -> blue-green -> green       310 blue, 320–340 blue-green, 350 light green
       370–390   yellow-green -> yellow            370 yellow-green, 390 yellow
       400–420   light orange -> pink              410 light orange, 420 carnation pink
       430–520   violet-red, red-violet (460), violet (470), blue-violet (480), blue (490), blue-green (500),
                 green (510–520)                   identical sequence at the same thicknesses
     So every hue family matches; in the first order a few transitions come ~10 nm thinner than the chart
     names them (the chart's names are visual judgements under fluorescent light, whose line spectrum shifts
     the boundaries). Saturation is moderate (HSV s ≈ 0.1–0.8), like real wafers: oxide on Si only swings
     between R ≈ 0.10 and 0.37. */

  /* ============================================================ gratings */
  /* White light arrives from direction u (illumElevDeg/illumAzimuthDeg; default straight down; a tilted lamp
     at the default azimuth 0 is on the viewer's side), the eye looks from direction v (viewElevDeg = 30,
     viewAzimuthDeg = 0). lineAngleDeg defaults to 90 (lines along y), which faces the default viewer. Grating equation for the in-plane wave-vector components
     (reflection grating, order m):  v∥ + u∥ = m (λ/d) ĝ, ĝ = unit grating vector ⟂ lines.
     Along ĝ:  λ_m = d |w·ĝ| / m with w = v∥ + u∥. With normal illumination w = cos(elev) toward the viewer,
     so λ = d cos(elev) = d sin θ (θ = view angle from the normal).
     Across ĝ the equation demands w·ĝ⊥ = 0 exactly (conical diffraction conserves that component). A real lamp
     and eye are not points: we let them accept a cone of half-width coneDeg (default 5°) and weight the light by
     exp(-½ (w·ĝ⊥ / sin cone)²). Looking along the lines (w ⟂ ĝ) is therefore dark; at 30° elevation the colour
     halves about 7° of azimuth off the grating vector.
     Order strength: thin lamellar (binary) grating in the scalar approximation, η_m ∝ sin²(πmD)/(πm)²,
     normalised to 1 for m = 1, duty D = 0.5 (so even orders vanish at D = 0.5). If depthNm is given the phase
     depth of a reflection grating adds the factor sin²(2πh/λ) (max at h = λ/4); otherwise depth is ignored.
     The substrate's own (zero-order) reflection is not included: the hex is the diffracted light alone,
     scaled like wavelengthToRgb (brightest spectral colour at full brightness), and weighted by D65.      */
  function gratingGeom(view) {
    view = view || {};
    const ve = rad(num(view.viewElevDeg, 30)), va = rad(num(view.viewAzimuthDeg, 0));
    const ie = rad(num(view.illumElevDeg, 90)), ia = rad(num(view.illumAzimuthDeg, 0));
    return { wx: Math.cos(ve) * Math.cos(va) + Math.cos(ie) * Math.cos(ia), wy: Math.cos(ve) * Math.sin(va) + Math.cos(ie) * Math.sin(ia) };
  }
  O.gratingColor = function (g, view) {
    g = g || {}; view = view || {};
    const d = num(g.periodNm, NaN), duty = clamp(num(g.duty, 0.5), 0, 1), depth = num(g.depthNm, null);
    if (!(d > 0)) throw new Error('gratingColor: periodNm must be a positive number');
    const w = gratingGeom(view), ga = rad(num(g.lineAngleDeg, 90) + 90), gx = Math.cos(ga), gy = Math.sin(ga);
    const wg = Math.abs(w.wx * gx + w.wy * gy), wp = Math.abs(w.wy * gx - w.wx * gy);
    const sc = Math.sin(rad(clamp(num(view.coneDeg, 5), 0.1, 89))), fall = Math.exp(-0.5 * (wp / sc) * (wp / sc));
    const orders = [];
    (view.orders || [1, 2]).forEach(m => {
      m = Math.abs(Math.round(m)); if (!m) return;
      const l = d * wg / m;
      if (!(l >= 380 && l <= 780)) return;
      let eta = Math.pow(Math.sin(PI * m * duty), 2) / (m * m);
      if (depth != null) eta *= Math.pow(Math.sin(2 * PI * depth / l), 2);
      const weight = eta * fall;
      orders.push({ order: m, wavelengthNm: l, weight, light: weight * O.d65(l) / 100 });
    });
    const brightness = clamp(orders.reduce((a, o) => a + o.weight, 0), 0, 1);
    const rgb = orders.length ? linesToRgb(orders.map(o => ({ wavelengthNm: o.wavelengthNm, weight: o.light }))) : [0, 0, 0];
    let dom = null, best = 0;
    orders.forEach(o => { const c = O.cmf(o.wavelengthNm), s = o.light * (c[0] + c[1] + c[2]); if (s > best) { best = s; dom = o; } });
    const lineNm = duty * d, gapNm = d - lineNm;
    return {
      hex: O.rgbToHex(rgb), rgb, wavelengthNm: brightness > 0.01 && dom ? dom.wavelengthNm : null, brightness,
      orders: orders.map(o => ({ order: o.order, wavelengthNm: o.wavelengthNm, weight: o.weight })),
      fab: { lineNm, gapNm, ok: lineNm >= O.FAB.minFeatureNm - 1e-9 && gapNm >= O.FAB.minGapNm - 1e-9 }
    };
  };
  // period that sends λ to the viewer in the given order, grating vector aligned with the view (inverse of above)
  O.gratingPeriodFor = function (l, opts) {
    opts = opts || {};
    const w = gratingGeom(opts), m = Math.max(1, Math.abs(Math.round(num(opts.order, 1)))), wl = Math.hypot(w.wx, w.wy);
    return wl < 1e-9 ? null : m * l / wl;
  };
  // the line angle that aligns the grating vector with the view (lines perpendicular to w)
  O.gratingLineAngleFor = function (opts) {
    const w = gratingGeom(opts);
    return ((Math.atan2(w.wy, w.wx) * 180 / PI + 90) % 360 + 360) % 360;
  };
  /* Gratings whose first order spans opts.minNm–maxNm (default 440–670 nm; violet and deep red diffract too
     dimly to be useful) at this view, lines turned to face the viewer (gratingLineAngleFor), periods kept
     inside [minPeriodNm, maxPeriodNm] (default 200 = 100 nm line + 100 nm gap), duty nudged so line and gap
     both stay >= 100 nm. Entries
     {periodNm, lineAngleDeg, duty, wavelengthNm, hex, brightness}. Fewer than count entries come back
     when the range cuts some off (very steep views need long periods). */
  O.gratingPalette = function (opts) {
    opts = opts || {};
    const count = Math.max(1, Math.round(num(opts.count, 12))), pmin = num(opts.minPeriodNm, O.FAB.minFeatureNm + O.FAB.minGapNm);
    const pmax = num(opts.maxPeriodNm, 2000), l0 = num(opts.minNm, 440), l1 = num(opts.maxNm, 670), duty0 = clamp(num(opts.duty, 0.5), 0.05, 0.95);
    const view = Object.assign({}, opts, { orders: opts.orders || [1, 2] }), ang = O.gratingLineAngleFor(opts), out = [];
    for (let i = 0; i < count; i++) {
      const l = count === 1 ? (l0 + l1) / 2 : l0 + (l1 - l0) * i / (count - 1), p = O.gratingPeriodFor(l, opts);
      if (p == null || p < pmin - 1e-9 || p > pmax + 1e-9) continue;
      // keep both the line and the gap printable
      const duty = clamp(duty0, O.FAB.minFeatureNm / p, 1 - O.FAB.minGapNm / p);
      const c = O.gratingColor({ periodNm: p, lineAngleDeg: ang, duty }, view);
      out.push({ periodNm: p, lineAngleDeg: ang, duty, wavelengthNm: l, hex: c.hex, brightness: c.brightness });
    }
    return out;
  };

  /* ============================================================ pillars and nanodisks: ESTIMATES */
  /* These colours depend strongly on the real process (sidewall angle, residual layers, substrate, lattice),
     so every result is labelled note:'estimate'. A measured library (parseLibraryCsv) should replace them.
     Each model gives a reflectance spectrum (normal incidence, specular, D65) that is then rendered like any
     other spectrum, so saturation and brightness come out plausibly rather than as idealised spectral colours.

     Dielectric pillars ('tio2-pillar', 'si-pillar'): the lowest Mie resonance (magnetic dipole) of a high-index
     particle sits near λ ≈ n·D for a sphere of diameter D. A cylinder (diameter D, height H) is replaced by the
     sphere of equal volume, D_eq = (1.5 D² H)^(1/3); n(λ) is solved self-consistently. The electric dipole sits
     ~1.2× (TiO2) / 1.3× (Si) bluer. Tall pillars (H > 1.5 D) behave like vertical nanowires whose HE11 leaky mode
     is set by the diameter alone (Seo et al., Nano Lett. 11, 1851 (2011); L. Cao et al., Nano Lett. 10, 439
     (2010)), so H is capped at 1.5 D. This reproduces the reported trends: Si disks of D ≈ 100–270 nm spanning
     blue → red (V. Flauraud / J. Proust et al., ACS Nano 10, 7761 (2016)), and ALD-TiO2 pillars a few hundred
     nm tall spanning the visible for D ≈ 100–250 nm (S. Sun et al., ACS Nano 11, 4445 (2017)).
       tio2-pillar: on fused silica, seen in reflection. Resonances are Lorentzian sheet reflectors
         r_s = -ρ/(1 - 2i(λ-λ0)/w), Q = λ0/w ≈ 3 n, strength ρ from the fill factor f = πD²/4P²
         (ρ ≈ f/0.4, capped at 0.9; electric dipole at 0.4ρ); the sheet sits H/2 above the substrate and interferes with its
         reflection (Airy sum). Reflection peak -> additive colour on a dark background.
       si-pillar: etched into a Si wafer. Resonant absorption carves a Lorentzian dip into the Si reflectance
         (depth 0.4 + 2 f, capped at 0.95; Q ≈ 3 n) and the pillar layer lowers the broadband reflectance
         by ~f/2 -> subtractive colour (e.g. a dip in the green looks magenta).
     Plasmonic disks ('al-disk', 'ag-disk', 'au-disk'; lift-off on fused silica by default): quasi-static
     polarisability of an oblate spheroid with the disk's diameter and thickness (Bohren & Huffman ch. 5),
     dynamic-depolarisation (modified long-wavelength) shift -k²/a (Kelly et al., J. Phys. Chem. B 107, 668
     (2003)), metal ε from the tables above, surrounding ε = (1 + ε_sub)/2. The array is a dipole sheet whose
     radiative damping is the sheet value 2πk/P² (the radiative part of the lattice sum, valid for λ > P):
     r_s = i(2πk/P²)α_eff, 1/α_eff = 1/α - k²/a - i 2πk/P², then the same Airy sum with the substrate.
     Compared with Al nanodisk colour printing (Tan et al., Nano Lett. 14, 4023 (2014); Knight et al., ACS Nano 8,
     834 (2014)): Al resonances move from violet (~D 100 nm) to red (~D 200+ nm); Ag is bluer-to-greener and
     strongest; Au is limited to orange-red by its interband absorption. Lattice (Rayleigh-anomaly) effects and
     near-field coupling across a 100 nm gap are ignored.                                                     */
  const FAMILY = {
    'tio2-pillar': { kind: 'mie', mat: 'tio2', ratio: 1.2, height: 300, sub: 'fused silica' },
    'si-pillar': { kind: 'dip', mat: 'si', ratio: 1.3, height: 200, sub: 'si' },
    'al-disk': { kind: 'plasmon', mat: 'al', height: 40, sub: 'fused silica' },
    'ag-disk': { kind: 'plasmon', mat: 'ag', height: 40, sub: 'fused silica' },
    'au-disk': { kind: 'plasmon', mat: 'au', height: 40, sub: 'fused silica' }
  };
  O.pillarFamilies = () => Object.keys(FAMILY);
  const famKey = f => { const k = key(f || ''); return Object.keys(FAMILY).find(n => key(n) === k || key(n).replace(/pillar|disk/, '') === k) || null; };
  function fabIssues(D, P, H) {
    const F = O.FAB, issues = [];
    if (D < F.minFeatureNm - 1e-9) issues.push(`diameter ${Math.round(D)} nm is below the ${F.minFeatureNm} nm minimum feature`);
    if (P - D < F.minGapNm - 1e-9) issues.push(`gap ${Math.round(P - D)} nm (pitch − diameter) is below the ${F.minGapNm} nm minimum`);
    if (H < F.minHeightNm || H > F.maxHeightNm) issues.push(`height ${Math.round(H)} nm is outside ${F.minHeightNm}–${F.maxHeightNm} nm`);
    return issues;
  }
  // magnetic-dipole wavelength of the volume-equivalent sphere, n(λ) solved by fixed-point iteration
  function mieLambda(mat, D, H) {
    const f = O.material(mat), Deq = Math.cbrt(1.5 * D * D * Math.min(H, 1.5 * D));
    let l = 2.5 * Deq; for (let i = 0; i < 8; i++) l = f(l).n * Deq;
    return l;
  }
  // in-plane depolarisation factor of a spheroid (in-plane diameter D, height H), Bohren & Huffman eq. 5.33–5.34
  function depol(D, H) {
    const a = D / 2, c = H / 2;
    if (Math.abs(a - c) < 1e-6 * a) return 1 / 3;
    if (c < a) { const e2 = 1 - c * c / (a * a), g = Math.sqrt((1 - e2) / e2); return g / (2 * e2) * (PI / 2 - Math.atan(g)) - g * g / 2; }
    const e2 = 1 - a * a / (c * c), e = Math.sqrt(e2), Lz = (1 - e2) / e2 * (-1 + Math.log((1 + e) / (1 - e)) / (2 * e));
    return (1 - Lz) / 2;
  }
  // Airy sum: a sheet with reflection r_s (transmission 1 + r_s) a height z above a substrate with Fresnel r_b
  function sheetOnSub(rs, rb, l, z) {
    const ph = cexpi([4 * PI * z / l, 0]), ts = cadd([1, 0], rs), rbp = cmul(rb, ph);
    return cabs2(cadd(rs, cdiv(cmul(cmul(ts, ts), rbp), csub([1, 0], cmul(rs, rbp)))));
  }
  function pillarModel(fam, D, P, H, subName) {
    const F = FAMILY[fam], fill = PI * D * D / (4 * P * P), sub = O.material(subName || F.sub);
    const rsub = l => fresnel([1, 0], N(sub(l)));
    if (F.kind === 'mie' || F.kind === 'dip') {
      const lMD = mieLambda(F.mat, D, H), lED = lMD / F.ratio, nr = O.material(F.mat)(lMD).n, wMD = lMD / (3 * nr), wED = lED / (3 * nr);
      const lor = (l, l0, w) => 1 / (1 + Math.pow(2 * (l - l0) / w, 2));
      if (F.kind === 'mie') {
        const rho = Math.min(0.9, fill / 0.4);
        const rs = l => { const a = cdiv([-rho, 0], [1, -2 * (l - lMD) / wMD]), b = cdiv([-0.4 * rho, 0], [1, -2 * (l - lED) / wED]); return cadd(a, b); };
        return { resonanceNm: lMD, mode: 'peak', R: l => clamp(sheetOnSub(rs(l), rsub(l), l, H / 2), 0, 1) };
      }
      const depth = Math.min(0.95, 0.4 + 2 * fill), base = l => cabs2(rsub(l)) * (1 - 0.5 * fill);
      return { resonanceNm: lMD, mode: 'dip', R: l => base(l) * (1 - depth * Math.max(lor(l, lMD, wMD), 0.6 * lor(l, lED, wED))) };
    }
    // plasmonic disk
    const met = O.material(F.mat), L = depol(D, H), a = D / 2, c = H / 2;
    const rs = l => {
      const m = met(l), eps = [m.n * m.n - m.k * m.k, 2 * m.n * m.k], ns = sub(l).n, em = (1 + ns * ns) / 2;
      const k0 = 2 * PI / l, km2 = k0 * k0 * em, g = 2 * PI * k0 / (P * P);
      const de = csub(eps, [em, 0]), alpha = cmul([a * a * c / 3, 0], cdiv(de, cadd([em, 0], cmul([L, 0], de))));   // V/4π · (ε-εm)/(εm + L(ε-εm))
      const inv = csub(cdiv([1, 0], alpha), [km2 / a, g]);
      return cmul([0, g], cdiv([1, 0], inv));
    };
    // resonance: wavelength of the strongest sheet response
    let best = 0, lres = null;
    for (let l = 380; l <= 900; l += 2) { const v = cabs2(rs(l)); if (v > best) { best = v; lres = l; } }
    return { resonanceNm: lres, mode: 'peak', R: l => clamp(sheetOnSub(rs(l), rsub(l), l, H / 2), 0, 1) };
  }
  /* pillarColorEstimate(family, {diameterNm, heightNm, pitchNm}, {substrate}) ->
     {hex, rgb, resonanceNm, mode:'peak'|'dip', family, diameterNm, heightNm, pitchNm, fab:{ok, issues}, note:'estimate',
      caveat?: set when the model is used outside its range (metal thicker than ~0.6 D)}
     pitch defaults to diameter + 100 nm gap; height to the family default. */
  O.pillarColorEstimate = function (family, p, opts) {
    const fam = famKey(family);
    if (!fam) throw new Error(`Unknown pillar family "${family}". Known: ${Object.keys(FAMILY).join(', ')}.`);
    p = p || {}; opts = opts || {};
    const D = num(p.diameterNm, NaN);
    if (!(D > 0)) throw new Error('pillarColorEstimate: diameterNm must be a positive number');
    const H = num(p.heightNm, FAMILY[fam].height), P = Math.max(num(p.pitchNm, D + O.FAB.minGapNm), D * 1.0001);
    const m = pillarModel(fam, D, P, H, opts.substrate), rgb = O.spectrumToRgb(m.R), issues = fabIssues(D, P, H);
    const out = { hex: O.rgbToHex(rgb), rgb, resonanceNm: m.resonanceNm, mode: m.mode, family: fam, diameterNm: D, heightNm: H, pitchNm: P, fab: { ok: !issues.length, issues }, note: 'estimate' };
    // the spheroid model is meant for disks; lift-off metal is normally 20–100 nm thick
    if (FAMILY[fam].kind === 'plasmon' && H > 0.6 * D) out.caveat = `metal ${Math.round(H)} nm thick on a ${Math.round(D)} nm disk is a post, not a disk: the disk model is unreliable above ~${Math.round(0.6 * D)} nm (lift-off metal is usually 20–100 nm)`;
    return out;
  };
  O.pillarSpectrum = function (family, p, opts) {   // the estimated reflectance spectrum, for plots
    const fam = famKey(family); p = p || {}; opts = opts || {};
    const D = +p.diameterNm, H = num(p.heightNm, FAMILY[fam].height), P = Math.max(num(p.pitchNm, D + O.FAB.minGapNm), D * 1.0001);
    const m = pillarModel(fam, D, P, H, opts.substrate);
    return LAM.map(l => [l, m.R(l)]);
  };
  /* count diameters, evenly spaced over the range whose estimated resonance runs from opts.minNm to
     opts.maxNm (default 430–680 nm) at this height, but never below minFeatureNm (override the range with
     minDiameterNm / maxDiameterNm). Pitch = diameter + minGapNm (densest printable array: strongest colour).
     Defaults respect FAB (minFeatureNm = minGapNm = 100); heightNm is clamped to 10–500 nm.
     Entries: pillarColorEstimate's result plus params {diameterNm, pitchNm, heightNm}. */
  O.pillarPalette = function (family, opts) {
    const fam = famKey(family);
    if (!fam) throw new Error(`Unknown pillar family "${family}". Known: ${Object.keys(FAMILY).join(', ')}.`);
    opts = opts || {};
    const F = FAMILY[fam], H = clamp(num(opts.heightNm, F.height), O.FAB.minHeightNm, O.FAB.maxHeightNm);
    const dmin = num(opts.minFeatureNm, O.FAB.minFeatureNm), gap = num(opts.minGapNm, O.FAB.minGapNm), count = Math.max(1, Math.round(num(opts.count, 8))), out = [];
    // diameter range whose resonance spans opts.minNm–maxNm (default 430–680 nm), never below dmin
    const res = D => pillarModel(fam, D, D + gap, H, opts.substrate).resonanceNm || 0, cap = Math.max(dmin + 50, num(opts.maxDiameterNm, 600));
    const solve = target => { let a = dmin, b = cap; if (res(a) >= target) return a; if (res(b) <= target) return b; for (let i = 0; i < 30; i++) { const m = (a + b) / 2; if (res(m) < target) a = m; else b = m; } return (a + b) / 2; };
    const d0 = Math.max(dmin, num(opts.minDiameterNm, solve(num(opts.minNm, 430)))), d1 = Math.min(cap, Math.max(d0 + 50, num(opts.maxDiameterNm, solve(num(opts.maxNm, 680)))));
    for (let i = 0; i < count; i++) {
      const D = count === 1 ? d0 : d0 + (d1 - d0) * i / (count - 1), P = D + gap;
      const e = O.pillarColorEstimate(fam, { diameterNm: D, heightNm: H, pitchNm: P }, opts);
      out.push(Object.assign(e, { params: { diameterNm: D, pitchNm: P, heightNm: H } }));
    }
    return out;
  };

  /* ============================================================ measured libraries */
  /* parseLibraryCsv(text, {lenient}) -> [{name, family, params:{periodNm, diameterNm, pitchNm, heightNm,
     angleDeg, duty}, hex, measured:true, line}]. Header row required; columns in any order, case-insensitive:
     name, family, period_nm, diameter_nm, pitch_nm, height_nm, angle_deg, duty, and either hex or r,g,b.
     ("nm"/"deg" suffixes, spaces and a few synonyms like 'period' or 'colour' are accepted; ',' ';' or tab
     separated; blank lines and lines starting with # are skipped unless the first cell is a #hex colour; "quoted, fields" work.)
     Bad rows: by default throws one Error listing every bad row ("line 4: duty "1.4" must be between 0
     and 1 ..."), with err.errors = [{line, message}]. With {lenient:true} bad rows are skipped and the
     returned array carries .errors. Rows outside the fab limits are kept (they were measured) but noted
     in the array's .warnings. Families are normalised: 'TiO2 pillar' -> 'tio2-pillar', 'thin film' -> 'thinfilm'. */
  const COLS = {
    name: 'name', label: 'name', id: 'name', family: 'family', type: 'family', structure: 'family', kind: 'family',
    period: 'period_nm', periodnm: 'period_nm', diameter: 'diameter_nm', diameternm: 'diameter_nm', d: 'diameter_nm',
    pitch: 'pitch_nm', pitchnm: 'pitch_nm', height: 'height_nm', heightnm: 'height_nm', depth: 'height_nm', depthnm: 'height_nm',
    thickness: 'height_nm', thicknessnm: 'height_nm', angle: 'angle_deg', angledeg: 'angle_deg', lineangle: 'angle_deg', lineangledeg: 'angle_deg',
    duty: 'duty', dutycycle: 'duty', fillfactor: 'duty', hex: 'hex', color: 'hex', colour: 'hex', r: 'r', red: 'r', g: 'g', green: 'g', b: 'b', blue: 'b'
  };
  const PARAM = { period_nm: 'periodNm', diameter_nm: 'diameterNm', pitch_nm: 'pitchNm', height_nm: 'heightNm', angle_deg: 'angleDeg', duty: 'duty' };
  const FAMS = { grating: 'grating', gratings: 'grating', line: 'grating', lines: 'grating', blazed: 'blazed', blazedgrating: 'blazed',
    thinfilm: 'thinfilm', film: 'thinfilm', tio2pillar: 'tio2-pillar', tio2: 'tio2-pillar', tio2pillars: 'tio2-pillar', sipillar: 'si-pillar', si: 'si-pillar',
    sipillars: 'si-pillar', aldisk: 'al-disk', al: 'al-disk', agdisk: 'ag-disk', ag: 'ag-disk', audisk: 'au-disk', au: 'au-disk' };
  function splitCsv(line, sep) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }
  O.parseLibraryCsv = function (text, opts) {
    if (typeof text !== 'string') throw new TypeError('parseLibraryCsv expects the CSV text as a string');
    opts = opts || {};
    const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/), errors = [], warnings = [], entries = [];
    let hi = lines.findIndex(l => l.trim() && !/^\s*#/.test(l));
    const fail = (msg, extra) => { const e = new Error(msg); e.errors = extra || [{ line: hi + 1, message: msg }]; throw e; };
    if (hi < 0) fail('The library CSV is empty: expected a header row such as "name,family,period_nm,hex".');
    const hl = lines[hi], sep = hl.indexOf(',') >= 0 ? ',' : hl.indexOf(';') >= 0 ? ';' : hl.indexOf('\t') >= 0 ? '\t' : ',';
    const cols = splitCsv(hl, sep).map(h => COLS[key(h).replace(/[()\[\]°]/g, '')] || null), raw = splitCsv(hl, sep);
    const ignored = raw.filter((h, i) => !cols[i] && h);
    const has = c => cols.indexOf(c) >= 0;
    if (!has('hex') && !(has('r') && has('g') && has('b'))) fail(`line ${hi + 1}: the header needs a colour column: "hex" (e.g. #3a7bd5) or all of "r", "g", "b". Found: ${raw.join(', ')}`);
    if (ignored.length) warnings.push({ line: hi + 1, message: `ignored unknown column(s): ${ignored.join(', ')}` });
    for (let li = hi + 1; li < lines.length; li++) {
      const line = lines[li];
      if (!line.trim()) continue;
      const cells = splitCsv(line, sep), row = {}, bad = [], ln = li + 1;
      if (/^\s*#/.test(line) && !O.hexToRgb(cells[0])) continue;   // a comment, unless the row starts with a #hex colour
      if (cells.length > cols.length && cells.slice(cols.length).some(c => c)) bad.push(`has ${cells.length} fields but the header has ${cols.length}`);
      cols.forEach((c, i) => { if (c && cells[i] != null && cells[i] !== '') row[c] = cells[i]; });
      const params = {};
      Object.keys(PARAM).forEach(c => {
        if (row[c] == null) return;
        let s = row[c].replace(/\s*(nm|deg|°)$/i, ''), pct = /%$/.test(s);
        if (pct) s = s.slice(0, -1);
        const v = Number(s);
        if (!isFinite(v) || s === '') { bad.push(`${c} "${row[c]}" is not a number`); return; }
        if (c === 'duty') {
          const d = pct ? v / 100 : v;
          if (!(d > 0 && d < 1)) { bad.push(`duty "${row[c]}" must be between 0 and 1 (or a percentage like 50%)`); return; }
          params.duty = d; return;
        }
        if (c !== 'angle_deg' && !(v > 0)) { bad.push(`${c} "${row[c]}" must be greater than 0`); return; }
        params[PARAM[c]] = v;
      });
      let hex = null;
      if (row.hex != null) {
        const rgb = O.hexToRgb(row.hex);
        if (!rgb) bad.push(`hex "${row.hex}" is not a colour like #3a7bd5`); else hex = O.rgbToHex(rgb);
      } else {
        const v = ['r', 'g', 'b'].map(c => row[c]);
        if (v.some(x => x == null)) bad.push('needs a colour: hex, or all of r, g, b');
        else {
          const n = v.map(Number);
          if (n.some(x => !isFinite(x) || x < 0 || x > 255)) bad.push(`r,g,b "${v.join(',')}" must be numbers from 0 to 255`);
          else hex = O.rgbToHex(n);
        }
      }
      let family = row.family != null ? (FAMS[key(row.family)] || key(row.family)) : (params.periodNm ? 'grating' : params.diameterNm ? 'pillar' : '');
      if (bad.length) { errors.push({ line: ln, message: `line ${ln}: ${bad.join('; ')}` }); continue; }
      if (params.diameterNm && params.pitchNm && params.pitchNm < params.diameterNm) { errors.push({ line: ln, message: `line ${ln}: pitch_nm ${params.pitchNm} is smaller than diameter_nm ${params.diameterNm}` }); continue; }
      const F = O.FAB, note = [];
      if (params.diameterNm && params.diameterNm < F.minFeatureNm) note.push(`diameter ${params.diameterNm} nm < ${F.minFeatureNm} nm`);
      if (params.diameterNm && params.pitchNm && params.pitchNm - params.diameterNm < F.minGapNm) note.push(`gap ${params.pitchNm - params.diameterNm} nm < ${F.minGapNm} nm`);
      if (params.periodNm && params.periodNm < F.minFeatureNm + F.minGapNm) note.push(`period ${params.periodNm} nm < ${F.minFeatureNm + F.minGapNm} nm`);
      if (params.heightNm && (params.heightNm < F.minHeightNm || params.heightNm > F.maxHeightNm)) note.push(`height ${params.heightNm} nm outside ${F.minHeightNm}–${F.maxHeightNm} nm`);
      if (note.length) warnings.push({ line: ln, message: `line ${ln}: outside the fab limits (${note.join(', ')}); kept because it was measured` });
      const name = row.name || [family || 'structure', params.periodNm && `P${params.periodNm}`, params.diameterNm && `D${params.diameterNm}`, params.heightNm && `H${params.heightNm}`].filter(Boolean).join(' ');
      entries.push({ name, family, params, hex, measured: true, line: ln });
    }
    if (errors.length && !opts.lenient) {
      fail(`${errors.length} bad row${errors.length > 1 ? 's' : ''} in the library CSV:\n` + errors.map(e => e.message).join('\n'), errors);
    }
    if (!entries.length && !errors.length) fail(`The library CSV has a header (line ${hi + 1}) but no rows.`);
    entries.errors = errors; entries.warnings = warnings;
    return entries;
  };
  O.exampleLibraryCsv = () => [
    '# Cutography structure library: one measured test structure per row.',
    '# Columns may be in any order; leave a cell empty when it does not apply. Colour as hex or as r,g,b.',
    'name,family,period_nm,diameter_nm,pitch_nm,height_nm,angle_deg,duty,hex',
    'G-blue,grating,520,,,120,0,0.5,#3653d8',
    'G-green,grating,620,,,120,0,0.5,#3fb54a',
    'G-red,grating,740,,,120,0,0.5,#d8402e',
    'T-violet,tio2-pillar,,120,220,300,,,#6a4bb0',
    'T-cyan,tio2-pillar,,160,260,300,,,#3c9fb8',
    'T-orange,tio2-pillar,,210,310,300,,,#d98a3a',
    'A-yellow,al-disk,,110,210,40,,,#c9b45a',
    'A-blue,al-disk,,180,280,40,,,#4d63b8',
    'F-100,thinfilm,,,,100,,,#6e3c8e',
    'F-200,thinfilm,,,,200,,,#c9a640',
    ''].join('\n');

  /* ============================================================ nearest colour */
  // sRGB 0..255 -> CIELAB (D65), compact copy of engine.js so this module stands alone
  const sLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const fLab = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  O.rgbToLab = function (r, g, b) {
    if (Array.isArray(r)) { b = r[2]; g = r[1]; r = r[0]; }
    const R = sLin(r), G = sLin(g), B = sLin(b);
    const x = fLab((R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047), y = fLab(R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
    const z = fLab((R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  // CIEDE2000 (Sharma, Wu & Dalal, Color Res. Appl. 30, 21 (2005))
  O.deltaE2000 = function (p, q) {
    const d2r = PI / 180, r2d = 180 / PI, C1 = Math.hypot(p[1], p[2]), C2 = Math.hypot(q[1], q[2]), Cb7 = Math.pow((C1 + C2) / 2, 7);
    const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625))), a1 = (1 + G) * p[1], a2 = (1 + G) * q[1];
    const c1 = Math.hypot(a1, p[2]), c2 = Math.hypot(a2, q[2]);
    const h1 = (a1 === 0 && p[2] === 0) ? 0 : (Math.atan2(p[2], a1) * r2d + 360) % 360, h2 = (a2 === 0 && q[2] === 0) ? 0 : (Math.atan2(q[2], a2) * r2d + 360) % 360;
    let dh = 0; if (c1 * c2) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
    const dL = q[0] - p[0], dC = c2 - c1, dH = 2 * Math.sqrt(c1 * c2) * Math.sin(dh / 2 * d2r), Lb = (p[0] + q[0]) / 2, Cb = (c1 + c2) / 2;
    let hb = h1 + h2; if (c1 * c2) hb = Math.abs(h1 - h2) <= 180 ? hb / 2 : (hb < 360 ? (hb + 360) / 2 : (hb - 360) / 2);
    const T = 1 - 0.17 * Math.cos((hb - 30) * d2r) + 0.24 * Math.cos(2 * hb * d2r) + 0.32 * Math.cos((3 * hb + 6) * d2r) - 0.20 * Math.cos((4 * hb - 63) * d2r);
    const dT = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2)), Cp7 = Math.pow(Cb, 7), RC = 2 * Math.sqrt(Cp7 / (Cp7 + 6103515625));
    const SL = 1 + 0.015 * (Lb - 50) * (Lb - 50) / Math.sqrt(20 + (Lb - 50) * (Lb - 50)), SC = 1 + 0.045 * Cb, SH = 1 + 0.015 * Cb * T;
    const tL = dL / SL, tC = dC / SC, tH = dH / SH;
    return Math.sqrt(tL * tL + tC * tC + tH * tH - Math.sin(2 * dT * d2r) * RC * tC * tH);
  };
  O.deltaE76 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  /* nearestEntry(hex, entries, {metric:'2000'|'76'}) -> {entry, index, deltaE} | null. Entries are anything with
     a .hex (library rows, palette entries); rows without a valid hex are skipped. */
  O.nearestEntry = function (hex, entries, opts) {
    const rgb = O.hexToRgb(hex);
    if (!rgb) throw new Error(`nearestEntry: "${hex}" is not a colour like #3a7bd5`);
    const lab = O.rgbToLab(rgb), de = opts && String(opts.metric) === '76' ? O.deltaE76 : O.deltaE2000;
    let best = null;
    (entries || []).forEach((e, i) => {
      const c = e && O.hexToRgb(e.hex); if (!c) return;
      const d = de(lab, O.rgbToLab(c));
      if (!best || d < best.deltaE) best = { entry: e, index: i, deltaE: d };
    });
    return best;
  };

  return O;
});
