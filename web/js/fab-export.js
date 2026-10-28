/* fab-export.js — files for the lithography modes. Uses CutExport (geometry, GDS, bitmaps) and CutFab.

   Input is a region set: a CutExport LayerSet in micrometres (unitNm = 1000) whose layers are the
   design's regions, each carrying the palette entry it was drawn with in `structure`:
     {kind:'level', level, heightNm}           grayscale relief
     {kind:'thinfilm', heightNm}               thin-film color: a level at that thickness
     {kind:'grating'|'blazed', periodNm, lineWidthNm, angleDeg, steps}
     {kind:'tio2-pillar'|'si-pillar'|'al-disk'|…, diameterNm, pitchNm, lattice}
   Regions never overlap. Every producer returns [{path, data}] plus a short report. */
(function (root) {
  'use strict';
  const X = root.CutExport, F = root.CutFab;
  const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
  const NM = 1000;   // nm per unit (the sets are in µm)

  /* ------------------------------------------------------------ levels */
  // Every grayscale-type design ends up as layers that each sit at one level of a single ladder.
  function levelLayers(set, r) {
    const fam = r.mode === 'color' ? r.family : 'level';
    if (fam === 'level') {
      const ladder = F.levels(r);
      return { ladder, layers: set.layers.map(L => ({ L, level: ladder[L.structure.level] })) };
    }
    if (fam === 'thinfilm') {
      const hs = [...new Set(set.layers.map(L => +L.structure.heightNm.toFixed(1)))].sort((a, b) => a - b);
      const ladder = F.levels(r, hs);
      return { ladder, layers: set.layers.map(L => ({ L, level: ladder[hs.indexOf(+L.structure.heightNm.toFixed(1))] })) };
    }
    if (fam === 'blazed') {
      // each region becomes `steps` strips; strip j sits on the global ladder at round(j*(n-1)/(steps-1))
      const ladder = F.levels(r), n = ladder.length, out = [];
      for (const L of set.layers) {
        const s = L.structure, steps = Math.max(2, s.steps || 2), inset = r.minGapNm / 2 / NM;
        const strips = X.blazedGrating(L.loops, { period: s.periodNm / NM, steps, angleDeg: s.angleDeg || 0, edgeInset: inset, minLength: r.minFeatureNm / NM });
        strips.forEach((loops, j) => out.push({ L: Object.assign({}, L, { name: `${L.name} step ${j + 1}`, loops }), level: ladder[Math.round(j * (n - 1) / (steps - 1))] }));
      }
      return { ladder, layers: out };
    }
    throw new Error('Not a grayscale design');
  }

  /* Grayscale GDS (+ .lyp), dose table and recipe.
     opts: {encoding:'datatype'|'layer', holes:'keyhole'|'split'|'both', layerNo} */
  function grayscaleGds(set, r, opts) {
    opts = opts || {};
    const { ladder, layers } = levelLayers(set, r), base = slug(set.name), files = [];
    // merge regions that share a level: one GDS layer/datatype per dose class
    const byClass = new Map();
    for (const { L, level } of layers) {
      if (!byClass.has(level.doseClass)) byClass.set(level.doseClass, { level, loops: [], names: [] });
      const e = byClass.get(level.doseClass); e.loops.push(...L.loops); e.names.push(L.name);
    }
    const layerNo = opts.layerNo || 1;
    const gl = [...byClass.values()].sort((a, b) => a.level.doseClass - b.level.doseClass).map(e => ({
      id: 'D' + e.level.doseClass, name: `dose ${e.level.doseClass} · ${Math.round(e.level.heightNm)} nm`, hex: grayHex(e.level, ladder.length), loops: e.loops,
      gdsLayer: opts.encoding === 'layer' ? layerNo + e.level.doseClass : layerNo, gdsDatatype: opts.encoding === 'layer' ? 0 : e.level.doseClass
    }));
    const gset = Object.assign({}, set, { layers: gl, unitNm: NM });
    const holes = opts.holes || 'keyhole';
    for (const h of holes === 'both' ? ['keyhole', 'split'] : [holes]) {
      const suffix = holes === 'both' ? '-' + h : '';
      files.push({ path: `ebl/${base}${suffix}.gds`, data: X.gds(gset, { grid: r.gridNm, holes: h, labels: false }) });
    }
    files.push({ path: `ebl/${base}.lyp`, data: X.lyp(gset) });
    files.push({ path: `ebl/${base}-dose-table.csv`, data: F.doseTableCsv(r, ladder) });
    files.push({ path: `ebl/${base}-recipe.json`, data: F.recipeJson(r, { file: base, encoding: opts.encoding === 'layer' ? `one layer per dose class, starting at layer ${layerNo}, datatype 0` : `layer ${layerNo}, datatype = dose class`, holes, gridNm: r.gridNm, levels: ladder }) });
    return files;
  }
  const grayHex = (lv, n) => { const c = Math.round(40 + 200 * lv.index / Math.max(1, n - 1)); return '#' + [c, c, c].map(x => x.toString(16).padStart(2, '0')).join(''); };

  /* Grayscale BMP: 8-bit, 0 = outside the pattern, dose class k = k+1 (raw) or spread over 1–255.
     opts: {pixelNm, values:'raw'|'spread', mirror} */
  async function grayscaleBmp(set, r, opts, onProgress) {
    const { ladder, layers } = levelLayers(set, r), base = slug(set.name), n = ladder.length;
    const f = X.frameForPixel(set, opts.pixelNm, opts.mirror);
    if (f.width * f.height > 4e9) throw new Error(`At ${opts.pixelNm} nm per pixel this would be ${f.width.toLocaleString()} × ${f.height.toLocaleString()} pixels, too large for a bitmap. Use a coarser pixel or the GDS.`);
    // labelRows gives 1 + layer index; order layers so that index = dose class
    const ordered = Array.from({ length: n }, (_, k) => ({ name: 'dose ' + k, hex: '#000000', loops: [] }));
    for (const { L, level } of layers) ordered[level.doseClass].loops.push(...L.loops);
    const lab = X.labelRows(Object.assign({}, set, { layers: ordered }), f);
    const map = new Uint8Array(256); for (let k = 0; k <= n; k++) map[k] = opts.values === 'spread' ? Math.round(k * 255 / n) : k;
    const rows = { width: lab.width, height: lab.height, rowBytes: lab.rowBytes, row(j) { const src = lab.row(j), out = new Uint8Array(src.length); for (let i = 0; i < src.length; i++) out[i] = map[src[i]]; return out; } };
    const ppm = Math.round(1e9 / opts.pixelNm);
    const bmp = await X.bmp(rows, { kind: 'index8', palette: Array.from({ length: 256 }, (_, i) => [i, i, i]), ppm, dpi: 25.4e6 / opts.pixelNm, onProgress });
    const valueTable = Array.from({ length: n + 1 }, (_, k) => ({ value: map[k], doseClass: k ? k - 1 : null, meaning: k ? `dose class ${k - 1} · ${Math.round(ladder.find(l => l.doseClass === k - 1).heightNm)} nm` : 'outside the pattern (not written)' }));
    return [
      { path: `ebl/${base}-${opts.pixelNm}nm.bmp`, data: bmp },
      { path: `ebl/${base}-${opts.pixelNm}nm-bmp.json`, data: JSON.stringify({ file: `${base}-${opts.pixelNm}nm.bmp`, pixelNm: opts.pixelNm, widthPx: f.width, heightPx: f.height, widthUm: f.width * opts.pixelNm / 1000, heightUm: f.height * opts.pixelNm / 1000, mirrored: !!opts.mirror, values: opts.values, valueTable, note: 'Pixel (0,0) is the top-left corner of the field. Assign doses in BEAMER from the value table and the dose table CSV.' }, null, 1) }
    ];
  }

  /* ------------------------------------------------------------ structures */
  // Shape counts before generating anything, so huge fills can be refused or warned about.
  function estimateFill(set, r) {
    let shapes = 0;
    for (const L of set.layers) {
      const s = L.structure || {}, area = Math.abs(L.loops.reduce((a, l) => a + X.loopArea(l), 0)) * 1e6;   // nm²
      if (/grating/.test(s.kind)) { const len = Math.sqrt(area); shapes += Math.ceil(len / s.periodNm) * 2; }
      else if (s.pitchNm) shapes += area / (s.pitchNm * s.pitchNm * (s.lattice === 'hex' ? Math.sqrt(3) / 2 : 1));
    }
    return Math.round(shapes);
  }

  /* Structural color GDS. Region masks always go on layers 100 + i (one per palette entry, for
     BEAMER/KLayout to refill or combine); with fill, the structures go on layer 1 with datatype = i.
     opts: {fill:boolean, holes} */
  function structureGds(set, r, opts, report) {
    opts = opts || {};
    const base = slug(set.name), layers = [], cells = {}, rows = [];
    const inset = r.minGapNm / 2 / NM, minLen = r.minFeatureNm / NM;
    set.layers.forEach((L, i) => {
      const s = L.structure || {};
      layers.push({ id: 'R' + i, name: 'region ' + L.name, hex: L.hex, loops: L.loops, gdsLayer: 100 + i, gdsDatatype: 0 });
      let count = 0;
      if (opts.fill) {
        if (/grating/.test(s.kind)) {
          const lines = X.fillGrating(L.loops, { period: s.periodNm / NM, width: s.lineWidthNm / NM, angleDeg: s.angleDeg || 0, edgeInset: inset, minLength: minLen });
          layers.push({ id: 'S' + i, name: L.name, hex: L.hex, loops: lines, gdsLayer: 1, gdsDatatype: i });
          count = lines.length;
        } else if (s.diameterNm) {
          const cell = X.gdsName(`E${i}_${s.kind}_D${s.diameterNm}`);   // one cell per palette entry: its datatype is the entry's
          cells[cell] = { polygons: [X.circleLoop(0, 0, s.diameterNm / 2 / NM, 32)], layer: 1, datatype: i };
          const runs = X.fillLattice(L.loops, { pitch: s.pitchNm / NM, lattice: s.lattice || 'square', angleDeg: 0, keepOut: (s.diameterNm / 2 + r.minGapNm / 2) / NM });
          layers.push({ id: 'S' + i, name: L.name, hex: L.hex, loops: [], refs: runs.map(u => ({ cell, x: u.x, y: u.y, dx: u.dx, dy: u.dy, cols: u.n, rows: 1, rx: 0, ry: 0 })), gdsLayer: 1, gdsDatatype: i });
          count = runs.reduce((a, u) => a + u.n, 0);
        }
      }
      const areaUm2 = Math.abs(L.loops.reduce((a, l) => a + X.loopArea(l), 0));
      rows.push([i, 100 + i, L.name, s.kind || '', s.periodNm || '', s.lineWidthNm || '', s.diameterNm || '', s.pitchNm || '', s.lattice || '', s.heightNm || s.depthNm || r.structureHeightNm, L.hex, areaUm2.toFixed(2), count, s.estimate ? 'estimate' : s.measured ? 'measured' : 'calculated']);
    });
    const gset = Object.assign({}, set, { layers, cells, unitNm: NM });
    if (report) report.shapes = rows.reduce((a, r2) => a + r2[12], 0);
    return [
      { path: `structures/${base}${opts.fill ? '-filled' : '-regions'}.gds`, data: X.gds(gset, { grid: r.gridNm, holes: opts.holes || 'keyhole', labels: false }) },
      { path: `structures/${base}.lyp`, data: X.lyp(gset) },
      { path: `structures/${base}-structures.csv`, data: 'datatype,region_layer,name,family,period_nm,line_width_nm,diameter_nm,pitch_nm,lattice,height_nm,preview_color,area_um2,shapes,color_source\n' + rows.map(x => x.join(',')).join('\n') + '\n' },
      { path: `structures/${base}-recipe.json`, data: F.recipeJson(r, { file: base, regions: 'layers 100+i, datatype 0', structures: opts.fill ? 'layer 1, datatype = palette index i' : 'not filled: fill the region layers in BEAMER or KLayout', gridNm: r.gridNm }) }
    ];
  }

  // Rule check as a text report for the export folder.
  function checkReport(set, r) {
    const c = F.checkLayout(set, r);
    const lines = [`Rule check for ${set.name}`, c.note, ''];
    if (!c.findings.length) lines.push(c.coarse ? 'No problems found at this resolution.' : `No features under ${r.minFeatureNm} nm, no gaps under ${r.minGapNm} nm, no corner-only touches.`);
    c.findings.forEach(f => lines.push('- ' + f.text));
    return { text: lines.join('\n') + '\n', result: c };
  }

  root.FabExport = { levelLayers, grayscaleGds, grayscaleBmp, structureGds, estimateFill, checkReport, slug };
})(typeof self !== 'undefined' ? self : this);
