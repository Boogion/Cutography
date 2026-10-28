/* fab.js — what the user is making, and the fabrication rules that follow from it. No DOM.

   A design starts from a mode, chosen before the photo or map:
     paper      stacked cardstock for Cricut or a laser (the original tool)
     grayscale  grayscale electron-beam lithography: 8 or 16 dose levels that become heights
     color      structural color: each palette entry is a nanostructure (grating, pillars, thin film)
     layers     plain layers for your own pipeline (GDS, masks)
   and, for the lithography modes, a recipe: process, materials and limits. Everything downstream (the
   palette, sizes, cleanup, previews, exports and rule checks) reads the recipe, so a design is made
   for the process it is meant for.

   Units: nanometres for feature sizes and heights, micrometres for field sizes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CutFab = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const F = {};
  const O = () => (typeof self !== 'undefined' && self.CutOptics) || (typeof CutOptics !== 'undefined' ? CutOptics : null);

  F.MODES = {
    paper: { name: 'Paper stack', short: 'Paper', lithography: false, note: 'Cardstock layers for Cricut Design Space or a laser cutter.' },
    grayscale: { name: 'Grayscale relief', short: 'Grayscale EBL', lithography: true, note: '8 or 16 dose levels that become heights in resist, or depths after etching. GDS and BMP for BEAMER.' },
    color: { name: 'Structural color', short: 'Structural color', lithography: true, note: 'Every color is a nanostructure: gratings, pillars, nanodisks or film thickness.' },
    layers: { name: 'Layers only', short: 'Layers', lithography: true, note: 'Plain layers at true size for your own pipeline: GDS, masks and label maps.' }
  };

  /* Processes. `families` are the structural-color options the process can make; `grayscale` says
     whether dose can set height. Notes are shown to the user as they choose. */
  F.PROCESSES = {
    resist: {
      name: 'Resist only', grayscale: true, families: ['thinfilm', 'grating', 'blazed'],
      note: 'The pattern stays in resist. Grayscale dose sets the remaining resist height directly.'
    },
    liftoff: {
      name: 'Lift-off (metal)', grayscale: false, families: ['al-disk', 'ag-disk', 'au-disk', 'grating'],
      note: 'Metal stays where you write (positive resist). Lift-off is on/off, so grayscale is not available.'
    },
    etch: {
      name: 'Etch into the substrate', grayscale: true, families: ['grating', 'blazed', 'si-pillar', 'thinfilm'],
      note: 'The resist pattern is etched into the substrate. Etched depth = resist depth × selectivity.'
    },
    tio2: {
      name: 'TiO₂ structures', grayscale: false, families: ['tio2-pillar', 'grating'],
      note: 'High-index TiO₂ pillars or gratings (e.g. ALD into a written resist template). The brightest, lowest-loss structural colors.'
    }
  };
  // `height` is a typical structure height or depth for the family (nm), used when it is chosen.
  F.FAMILIES = {
    grating: { height: 100, name: 'Diffraction gratings', binary: true, note: 'Line period sets the color seen at the viewing angle; colors shift as you tilt it.' },
    blazed: { height: 100, name: 'Blazed gratings (grayscale)', binary: false, note: 'A stepped sawtooth in each period sends more light into one color. Needs grayscale dose.' },
    thinfilm: { height: 100, name: 'Thin-film color (grayscale)', binary: false, note: 'Film thickness sets an interference color, like oxide on silicon. Each color is a dose level.' },
    'tio2-pillar': { height: 300, name: 'TiO₂ pillars', binary: true, note: 'Dielectric resonators; color set mainly by diameter.' },
    'si-pillar': { height: 150, name: 'Etched Si pillars', binary: true, note: 'Silicon nanopillars; color set by diameter.' },
    'al-disk': { height: 40, name: 'Al nanodisks', binary: true, note: 'Plasmonic aluminium disks; the widest color range of the metals.' },
    'ag-disk': { height: 40, name: 'Ag nanodisks', binary: true, note: 'Plasmonic silver disks.' },
    'au-disk': { height: 40, name: 'Au nanodisks', binary: true, note: 'Plasmonic gold disks; warm colors only.' }
  };
  F.RESISTS = {
    PMMA: { tone: 'positive', optics: 'PMMA' },
    ZEP520A: { tone: 'positive', optics: 'ZEP520A' },
    HSQ: { tone: 'negative', optics: 'HSQ' },
    'ma-N 2400': { tone: 'negative', optics: 'ma-N 2400' }
  };
  F.SUBSTRATES = {
    Si: { optics: 'Si', reflective: true },
    'SiO2 on Si': { optics: 'Si', film: 'SiO2', reflective: true },
    'Fused silica': { optics: 'fused silica', reflective: false }
  };
  F.METALS = ['Al', 'Ag', 'Au', 'Cr'];

  F.defaultRecipe = function (mode) {
    return {
      mode: mode || 'paper',
      process: mode === 'color' ? 'tio2' : 'resist',
      resist: 'PMMA', substrate: 'Si', metal: 'Al',
      minFeatureNm: 100, minGapNm: 100, minStepNm: 10,
      depthMinNm: 10, depthMaxNm: 500,        // usable range of heights / depths
      resistThicknessNm: 500, selectivity: 1,
      levels: 8, brightIsTall: true,
      family: mode === 'color' ? 'tio2-pillar' : 'grating',
      structureHeightNm: mode === 'color' ? 300 : 100, duty: 0.5, maxAspect: 5, lattice: 'square',
      viewElevDeg: 30, viewAzimuthDeg: 0,
      gridNm: 5, fieldUm: 500,
      contrast: null,                         // [[relativeDose, remainingFraction], ...] from the expert
      library: null                           // measured structure library (CutOptics.parseLibraryCsv)
    };
  };

  /* Derived rules plus everything that is wrong or questionable with the recipe, in plain words.
     errors block export; warnings are shown. */
  F.check = function (r) {
    const errors = [], warnings = [], d = {};
    const proc = F.PROCESSES[r.process] || F.PROCESSES.resist, resist = F.RESISTS[r.resist] || F.RESISTS.PMMA;
    d.tone = resist.tone;
    d.grayscale = proc.grayscale && (r.mode === 'grayscale' || (r.mode === 'color' && !F.FAMILIES[r.family].binary));
    if (r.mode === 'grayscale' && !proc.grayscale) errors.push(`${proc.name} is on/off only, so grayscale relief isn't possible. Choose Resist only or Etch.`);
    if (r.mode === 'color' && proc.families.indexOf(r.family) < 0) errors.push(`${proc.name} can't make ${F.FAMILIES[r.family].name.toLowerCase()}. Pick one of: ${proc.families.map(f => F.FAMILIES[f].name).join(', ')}.`);
    if (r.depthMinNm < 10) errors.push('Heights below 10 nm are unreliable; the lowest level must be at least 10 nm.');
    if (r.depthMaxNm > 500) errors.push('Heights above 500 nm are outside the process window.');
    if (r.depthMaxNm <= r.depthMinNm) errors.push('The tallest level must be above the lowest one.');
    if (r.minFeatureNm < 100) warnings.push('Features under 100 nm are unreliable on this system.');
    // grayscale: levels must stay at least minStepNm apart
    const span = r.depthMaxNm - r.depthMinNm;
    d.levelStepNm = span / (r.levels - 1);
    d.levelsPossible = [8, 16].filter(n => span / (n - 1) >= r.minStepNm);
    if (d.grayscale && r.mode === 'grayscale' && d.levelStepNm < r.minStepNm) {
      errors.push(`${r.levels} levels over ${r.depthMinNm}–${r.depthMaxNm} nm are only ${d.levelStepNm.toFixed(1)} nm apart; they need at least ${r.minStepNm} nm. ` +
        (d.levelsPossible.length ? `Use ${d.levelsPossible.join(' or ')} levels, or widen the range.` : `Widen the range to at least ${(r.levels - 1) * r.minStepNm} nm.`));
    }
    // resist and etch heights
    d.resistReliefNm = r.process === 'etch' ? r.depthMaxNm / Math.max(r.selectivity, 1e-6) : r.depthMaxNm;
    if (d.grayscale && r.process === 'resist' && r.resistThicknessNm < r.depthMaxNm) errors.push(`The resist (${r.resistThicknessNm} nm) is thinner than the tallest level (${r.depthMaxNm} nm).`);
    if (d.grayscale && r.process === 'etch' && r.resistThicknessNm < d.resistReliefNm) errors.push(`At selectivity ${r.selectivity}, a ${r.depthMaxNm} nm etch needs ${Math.ceil(d.resistReliefNm)} nm of resist relief; the resist is ${r.resistThicknessNm} nm.`);
    // structures
    d.minPeriodNm = r.minFeatureNm + r.minGapNm;
    d.lineWidthFor = p => Math.min(Math.max(r.duty * p, r.minFeatureNm), p - r.minGapNm);
    d.minPitchFor = dia => dia + r.minGapNm;
    d.maxBlazeSteps = p => Math.floor(p / r.minFeatureNm);
    if (r.mode === 'color' && /pillar|disk/.test(r.family)) {
      const ar = r.structureHeightNm / r.minFeatureNm;
      if (ar > r.maxAspect) warnings.push(`At ${r.structureHeightNm} nm tall, the thinnest pillars (${r.minFeatureNm} nm) have aspect ratio ${ar.toFixed(1)}, above your limit of ${r.maxAspect}. Thin pillars will be widened or left out.`);
      if (r.structureHeightNm < r.depthMinNm || r.structureHeightNm > r.depthMaxNm) errors.push(`Structure height must be within ${r.depthMinNm}–${r.depthMaxNm} nm.`);
    }
    if (r.process === 'liftoff') {
      if (resist.tone === 'negative') warnings.push('Lift-off normally uses a positive resist (undercut). With a negative resist, the written areas are where metal does NOT end up.');
      if (r.mode === 'color' && r.structureHeightNm > r.resistThicknessNm / 3) warnings.push(`Lift-off is reliable when the metal (${r.structureHeightNm} nm) is under a third of the resist thickness (${r.resistThicknessNm} nm).`);
    }
    if (r.mode === 'color' && r.family === 'thinfilm' && !(F.SUBSTRATES[r.substrate] || {}).reflective) warnings.push('Thin-film colors are faint on glass; a reflective substrate (Si) gives strong colors.');
    if (r.mode === 'color' && r.family === 'thinfilm' && r.process === 'etch' && r.substrate !== 'SiO2 on Si') warnings.push('Etched thin-film color needs a film to etch into; choose SiO₂ on Si.');
    if (r.fieldUm < 100) warnings.push('Fields under 100 µm leave few pixels per feature.');
    if (r.fieldUm > 100000) errors.push('The field is larger than a 4 in (100 mm) wafer.');
    d.what = F.writtenMeaning(r);
    return { errors, warnings, derived: d, ok: !errors.length };
  };

  // Designs whose regions are dose levels (grayscale relief, thin-film color, blazed gratings).
  F.isGrayDesign = r => r.mode === 'grayscale' || (r.mode === 'color' && !F.FAMILIES[r.family].binary);

  // What the written (exposed) shapes physically become, so nobody has to guess the tone.
  F.writtenMeaning = function (r) {
    const tone = (F.RESISTS[r.resist] || {}).tone;
    if (r.mode === 'grayscale' || (r.mode === 'color' && !F.FAMILIES[r.family].binary)) {
      return tone === 'positive'
        ? 'Positive resist: more dose removes more resist. Tall levels get little dose; areas outside the pattern stay at full resist thickness.'
        : 'Negative resist: more dose leaves more resist. Tall levels get the most dose; areas outside the pattern are removed.';
    }
    if (r.process === 'liftoff') return tone === 'positive' ? 'Written shapes become metal after lift-off.' : 'Written shapes are where metal is removed (negative resist).';
    if (r.process === 'tio2') return 'Written shapes become TiO₂ structures (written as holes in the resist template, then filled).';
    if (r.process === 'etch') return /pillar/.test(r.family)
      ? (tone === 'negative' ? 'Written shapes stay as pillars (resist mask), the rest is etched.' : 'Written shapes become a lift-off hard mask, so they stay as pillars after the etch.')
      : (tone === 'positive' ? 'Written lines are etched into the substrate.' : 'Written lines stay; the gaps are etched.');
    return tone === 'positive' ? 'Written shapes are removed from the resist.' : 'Written shapes stay in the resist.';
  };

  /* Grayscale levels, lowest to tallest. doseClass 0 = least dose; it is also the GDS datatype and
     the raw BMP value. Relative dose comes from the expert's contrast curve when given, else a straight
     line placeholder (flagged). */
  F.levels = function (r, heightsNm) {
    const tone = (F.RESISTS[r.resist] || {}).tone || 'positive';
    const n = heightsNm ? heightsNm.length : r.levels;
    const h = heightsNm ? heightsNm.slice().sort((a, b) => a - b) : Array.from({ length: n }, (_, i) => r.depthMinNm + (r.depthMaxNm - r.depthMinNm) * i / (n - 1));
    const sel = r.process === 'etch' ? Math.max(r.selectivity, 1e-6) : 1;
    const T = r.resistThicknessNm;
    return h.map((heightNm, i) => {
      // the resist relief that produces this height (after etch transfer when etching)
      const resistH = r.process === 'etch' ? heightNm / sel : heightNm;
      const remaining = r.process === 'etch' ? T - (r.depthMaxNm / sel - resistH) : resistH;
      const removed = T - remaining;
      const frac = tone === 'positive' ? removed / T : remaining / T;
      const rel = r.contrast ? doseFromContrast(r.contrast, tone === 'positive' ? remaining / T : remaining / T, tone) : frac;
      return { index: i, heightNm, resistHeightNm: remaining, removedNm: removed, doseClass: tone === 'positive' ? n - 1 - i : i, relDose: rel, placeholder: !r.contrast };
    });
  };
  // contrast: [[relDose, remainingFraction], ...]; find the dose that leaves `remaining`
  function doseFromContrast(curve, remaining, tone) {
    const c = curve.slice().sort((a, b) => a[0] - b[0]);
    for (let i = 0; i + 1 < c.length; i++) {
      const [d0, f0] = c[i], [d1, f1] = c[i + 1];
      if ((remaining - f0) * (remaining - f1) <= 0 && f0 !== f1) return d0 + (d1 - d0) * (remaining - f0) / (f1 - f0);
    }
    return tone === 'positive' ? (remaining >= c[0][1] ? c[0][0] : c[c.length - 1][0]) : (remaining <= c[0][1] ? c[0][0] : c[c.length - 1][0]);
  }
  F.parseContrast = function (text) {
    const rows = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[a-z#]/i.test(l)).map(l => l.split(/[,;\t ]+/).map(Number));
    const bad = rows.filter(r => r.length < 2 || !isFinite(r[0]) || !isFinite(r[1]));
    if (bad.length || rows.length < 2) throw new Error('Paste at least two lines of "relative dose, remaining thickness fraction" (0–1), e.g. "0.5, 0.92".');
    return rows.map(r => [r[0], r[1] > 1 ? r[1] / 100 : r[1]]);
  };

  F.doseTableCsv = function (r, levels) {
    const lines = ['datatype,dose_class,level,height_nm,resist_height_nm,resist_removed_nm,relative_dose,dose_source'];
    levels.slice().sort((a, b) => a.doseClass - b.doseClass).forEach(L => lines.push([L.doseClass, L.doseClass, L.index, L.heightNm.toFixed(1), L.resistHeightNm.toFixed(1), L.removedNm.toFixed(1), L.relDose.toFixed(4), L.placeholder ? 'linear placeholder: replace with your contrast curve' : 'contrast curve'].join(',')));
    return lines.join('\n') + '\n';
  };

  /* The palette a design draws from, in the photo tool's pack format:
     [{id, name, finish, material, colors:[{id, name, hex, on, structure}]}]. */
  F.palette = function (r) {
    const opt = O(), chk = F.check(r), d = chk.derived;
    const gray = v => { const c = Math.round(40 + 200 * v); return '#' + [c, c, c].map(x => x.toString(16).padStart(2, '0')).join(''); };
    const pack = (name, colors, note) => [{ id: 'fab-' + r.mode, name, finish: 'structure', material: note || '', colors }];
    if (r.mode === 'grayscale') {
      const L = F.levels(r);
      return pack(`${r.levels} levels · ${r.depthMinNm}–${r.depthMaxNm} nm`, L.map(l => ({
        id: 'lv' + l.index, name: `L${l.index + 1} · ${Math.round(l.heightNm)} nm`, hex: gray(r.brightIsTall ? l.index / (L.length - 1) : 1 - l.index / (L.length - 1)), on: true,
        structure: { kind: 'level', level: l.index, heightNm: l.heightNm, doseClass: l.doseClass }
      })), 'Dark to light = ' + (r.brightIsTall ? 'low to tall' : 'tall to low'));
    }
    if (r.mode === 'layers') return null;   // keep the user's own colors
    const lib = (r.library || []).filter(e => e.family === r.family || (r.family === 'grating' && e.family === 'grating'));
    if (lib.length) return pack('Measured library · ' + F.FAMILIES[r.family].name, lib.map((e, i) => ({ id: 'm' + i, name: e.name || ('#' + (i + 1)), hex: e.hex, on: true, structure: Object.assign({ kind: r.family, measured: true }, e.params) })), 'Measured');
    const fam = r.family, colors = [];
    if (fam === 'grating' || fam === 'blazed') {
      const entries = opt && opt.gratingPalette ? opt.gratingPalette({ viewElevDeg: r.viewElevDeg, minPeriodNm: Math.max(d.minPeriodNm, fam === 'blazed' ? 3 * r.minFeatureNm : 0), maxPeriodNm: 2000, count: 12 }) : fallbackGratings(r, d);
      entries.forEach((e, i) => {
        const p = Math.round(e.periodNm);
        const steps = fam === 'blazed' ? Math.max(2, Math.min(d.maxBlazeSteps(p), r.levels)) : 0;
        colors.push({ id: 'g' + i, name: `Λ ${p} nm` + (steps ? ` · ${steps} steps` : ''), hex: e.hex, on: true, structure: { kind: fam, periodNm: p, lineWidthNm: Math.round(d.lineWidthFor(p)), angleDeg: e.lineAngleDeg != null ? e.lineAngleDeg : 90, steps, depthNm: r.structureHeightNm } });
      });
      return pack(`${F.FAMILIES[fam].name} · viewed at ${r.viewElevDeg}°`, colors, 'Calculated');
    }
    if (fam === 'thinfilm') {
      const film = r.process === 'etch' ? 'SiO2' : (F.RESISTS[r.resist] || {}).optics || 'PMMA';
      const sub = (F.SUBSTRATES[r.substrate] || {}).optics || 'Si';
      const step = Math.max(r.minStepNm, 10);
      const entries = opt && opt.thinFilmPalette ? opt.thinFilmPalette(film, r.process === 'etch' ? 'Si' : sub, r.depthMinNm, r.depthMaxNm, step) : [];
      entries.forEach((e, i) => colors.push({ id: 't' + i, name: `${Math.round(e.thicknessNm)} nm ${film}`, hex: e.hex, on: true, structure: { kind: 'thinfilm', heightNm: e.thicknessNm, film } }));
      return pack(`Thin-film colors · ${film} on ${r.process === 'etch' ? 'Si' : r.substrate}`, colors, 'Calculated');
    }
    // pillars and nanodisks: estimated until a measured library is loaded
    const entries = opt && opt.pillarPalette ? opt.pillarPalette(fam, { heightNm: r.structureHeightNm, minFeatureNm: Math.max(r.minFeatureNm, r.structureHeightNm / r.maxAspect), minGapNm: r.minGapNm, count: 12 }) : [];
    entries.forEach((e, i) => {
      const dia = Math.round(e.diameterNm), pitch = Math.round(Math.max(e.pitchNm || 0, d.minPitchFor(dia)));
      colors.push({ id: 'p' + i, name: `⌀ ${dia} nm · pitch ${pitch}`, hex: e.hex, on: true, structure: { kind: fam, diameterNm: dia, pitchNm: pitch, heightNm: r.structureHeightNm, lattice: r.lattice, estimate: true } });
    });
    return pack(`${F.FAMILIES[fam].name} · estimated colors`, colors, 'Estimate: load a measured library');
  };
  function fallbackGratings(r, d) {   // used only if optics.js is missing: a rough spectral ramp
    // light from straight above, viewer at elevation e from the surface: first order λ = d·cos(e)
    const s = Math.cos(r.viewElevDeg * Math.PI / 180) || 0.5, out = [];
    for (let i = 0; i < 12; i++) { const lam = 420 + 260 * i / 11; out.push({ periodNm: Math.max(d.minPeriodNm, lam / s), hex: '#888888', wavelengthNm: lam }); }
    return out;
  }

  // The recipe as a file next to every export, so the expert sees what was intended.
  F.recipeJson = function (r, extra) {
    const chk = F.check(r), out = {};
    for (const k of Object.keys(r)) if (k !== 'library' && k !== 'contrast') out[k] = r[k];
    out.processName = (F.PROCESSES[r.process] || {}).name; out.modeName = (F.MODES[r.mode] || {}).name;
    out.resistTone = chk.derived.tone; out.writtenMeaning = chk.derived.what;
    out.contrastCurve = r.contrast; out.measuredLibrary = !!(r.library && r.library.length);
    out.warnings = chk.warnings; out.errors = chk.errors;
    return JSON.stringify(Object.assign({ generator: 'Cutography', created: new Date().toISOString(), recipe: out }, extra || {}), null, 1);
  };

  F.summaryText = function (r) {
    const chk = F.check(r), d = chk.derived, L = [];
    L.push(`${F.MODES[r.mode].name.toUpperCase()} — ${F.PROCESSES[r.process].name}, ${r.resist} (${d.tone}) on ${r.substrate}${r.process === 'liftoff' ? ', ' + r.metal : ''}`);
    L.push(`Field ${fmtUm(r.fieldUm)} · smallest feature ${r.minFeatureNm} nm, gap ${r.minGapNm} nm · grid ${r.gridNm} nm`);
    if (r.mode === 'grayscale') L.push(`${r.levels} levels, ${r.depthMinNm}–${r.depthMaxNm} nm, ${d.levelStepNm.toFixed(1)} nm apart${r.process === 'etch' ? ` · etch selectivity ${r.selectivity}` : ''} · resist ${r.resistThicknessNm} nm`);
    if (r.mode === 'color') L.push(`${F.FAMILIES[r.family].name}${/pillar|disk|grating/.test(r.family) ? `, ${r.structureHeightNm} nm tall/deep` : ''} · viewed at ${r.viewElevDeg}°`);
    L.push('Written shapes: ' + d.what);
    chk.errors.forEach(e => L.push('ERROR: ' + e));
    chk.warnings.forEach(w => L.push('Note: ' + w));
    return L.join('\n');
  };
  const fmtUm = um => um >= 1000 ? (um / 1000).toFixed(um >= 10000 ? 0 : 2).replace(/\.?0+$/, '') + ' mm' : Math.round(um) + ' µm';
  F.fmtUm = fmtUm;

  /* Rule check on what will be written: thin parts, narrow gaps and corner-only touches, found by
     rasterizing each layer at about a quarter of the smallest feature (coarser for big fields; the
     resolution used is reported). Needs CutEngine and CutExport. */
  F.checkLayout = function (set, r, opts) {
    opts = opts || {};
    const E = (typeof CutEngine !== 'undefined') ? CutEngine : self.CutEngine, X = (typeof CutExport !== 'undefined') ? CutExport : self.CutExport;
    const unitNm = set.unitNm || 25.4e6, b = set.bounds;
    const wNm = (b[2] - b[0]) * unitNm, hNm = (b[3] - b[1]) * unitNm, maxPx = opts.maxPixels || 6e6;
    let pixNm = r.minFeatureNm / 4;
    if ((wNm / pixNm) * (hNm / pixNm) > maxPx) pixNm = Math.sqrt(wNm * hNm / maxPx);
    const f = X.frame(set, unitNm / pixNm), findings = [];
    const rFeat = Math.max(0, Math.round(r.minFeatureNm / pixNm / 2) - 0.5), rGap = Math.max(0, Math.round(r.minGapNm / pixNm / 2) - 0.5);
    const coarse = pixNm > r.minFeatureNm / 2;
    set.layers.forEach((L, li) => {
      const rows = X.maskRows(L.loops, f), m = new Uint8Array(f.width * f.height);
      for (let j = 0; j < f.height; j++) { const row = rows.row(j); for (let i = 0; i < f.width; i++) if (row[i >> 3] & (0x80 >> (i & 7))) m[j * f.width + i] = 1; }
      let thin = 0, gap = 0, corner = 0;
      if (!coarse && rFeat > 0) { const o = E.dilate(E.erode(m, f.width, f.height, rFeat), f.width, f.height, rFeat); for (let q = 0; q < m.length; q++) if (m[q] && !o[q]) thin++; }
      if (!coarse && rGap > 0 && L.binary !== false) { const c = E.erode(E.dilate(m, f.width, f.height, rGap), f.width, f.height, rGap); for (let q = 0; q < m.length; q++) if (!m[q] && c[q]) gap++; }
      for (let j = 0; j + 1 < f.height; j++) for (let i = 0; i + 1 < f.width; i++) {
        const a = m[j * f.width + i], bb = m[j * f.width + i + 1], c = m[(j + 1) * f.width + i], dd = m[(j + 1) * f.width + i + 1];
        if ((a && dd && !bb && !c) || (bb && c && !a && !dd)) corner++;
      }
      const px2 = (pixNm / 1000) ** 2;
      if (thin) findings.push({ layer: L.name, kind: 'thin', areaUm2: thin * px2, text: `${L.name}: ${(thin * px2).toFixed(2)} µm² narrower than ${r.minFeatureNm} nm` });
      if (gap) findings.push({ layer: L.name, kind: 'gap', areaUm2: gap * px2, text: `${L.name}: gaps narrower than ${r.minGapNm} nm (${(gap * px2).toFixed(2)} µm²)` });
      if (corner) findings.push({ layer: L.name, kind: 'corner', count: corner, text: `${L.name}: ${corner} spot${corner === 1 ? '' : 's'} where shapes touch only at a corner` });
    });
    return { findings, checkedAtNm: pixNm, coarse, note: coarse ? `Checked at ${Math.round(pixNm)} nm per pixel: too coarse to test ${r.minFeatureNm} nm features over this field; check in BEAMER.` : `Checked at ${pixNm.toFixed(0)} nm per pixel.` };
  };

  return F;
});
