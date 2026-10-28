/* app.js — UI for PaperStrata. Depends on engine.js, palettes.js, JSZip (optional). */
(function () {
  'use strict';
  const E = CutEngine, P = CutPalettes;
  const $ = id => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ------------------------------------------------------------ state */
  let uidCounter = 1;
  const newUid = () => uidCounter++;

  const state = {
    packs: [],
    image: null,        // {name, canvas, w, h}
    work: null,         // {rgba, w, h, id}
    settings: {
      widthIn: 7, workRes: 1200,
      matW: P.MACHINE.matW, matH: P.MACHINE.matH, ptcW: P.MACHINE.ptcW, ptcH: P.MACHINE.ptcH,
      brightness: 0, contrast: 0, saturation: 0, blur: 1, autoLevels: false, localContrast: 0, edgeSmooth: 0,
      mode: 'cluster', k: 6, deltaE: '2000', assign: 'nearest', unique: true, toneSpread: 'quantile', merge: 8, minShare: 1,
      edgeOn: false, edgeSource: 'photo', edgeSens: 35, edgeWidth: 0.06, edgeColor: null,
      minPiece: 0.02, smoothR: 1, tol: 1.0, round: 0, curves: true, minFeature: 0.08,
      layerMode: 'stacked', underlap: 0.03, backingOn: false, backingColor: null, backingOffset: 0,
      regMarks: false, marginIn: 0.25, autoOrder: 'coverage', maxPieces: 3
    },
    toneUse: null,       // Set of uids used as tone bands (null = all active)
    view: 'mapped', tool: 'pick', brush: 14, paintUid: null,
    order: [],           // uids bottom -> top
    excluded: new Set(), // uids left out of the output
    clusterMap: {},      // cluster index -> uid
    overrides: null,     // Int32Array: 0 none, >0 uid, -1 cut away
    undo: [],
    selectedLayer: null,
    stackN: null,
    editingColor: null,
    result: null
  };
  const cache = {};

  /* ------------------------------------------------------- utilities */
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
  const fmt = (v, d) => Number(v).toFixed(d == null ? 2 : d);
  function textContrast(hex) { const [r, g, b] = E.hexToRgb(hex); return E.luma(r, g, b) > 150 ? '#1a1a1a' : '#f6f6f6'; }

  // Single downloads (palette, project). Exports go through the shared panel in export-ui.js.
  function saveFile(filename, data) { PaperStrataIO.download(filename, data); }

  function readFileAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  function loadImageEl(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('Could not decode image')); im.src = src; });
  }

  /* ------------------------------------------------------------ packs */
  function installPacks(packs) {
    state.packs = packs.map(p => ({
      id: p.id || ('pack-' + newUid()), name: p.name || 'Pack', finish: p.finish || 'smooth', weight: p.weight || '',
      material: p.material || 'Medium Cardstock - 80 lb', sheetW: p.sheetW || 8.5, sheetH: p.sheetH || 11,
      colors: (p.colors || []).map(c => ({ uid: newUid(), id: c.id || ('c' + newUid()), name: c.name || c.hex, hex: c.hex, on: c.on !== false }))
    }));
  }
  function allColors() {
    const out = [];
    for (const p of state.packs) for (const c of p.colors) out.push({ uid: c.uid, hex: c.hex, name: c.name, on: c.on, pack: p, color: c });
    return out;
  }
  function activeColors() {
    return allColors().filter(c => c.on).map(c => ({ uid: c.uid, hex: c.hex, lab: E.hexToLab(c.hex), name: c.name, pack: c.pack.name, finish: c.pack.finish, material: c.pack.material, packObj: c.pack }));
  }
  function colorByUid(uid) { return allColors().find(c => c.uid === uid) || null; }

  function renderPacks() {
    const root = $('packs'); root.innerHTML = '';
    for (const pack of state.packs) {
      const el = document.createElement('div'); el.className = 'pack';
      const head = document.createElement('div'); head.className = 'pack-head';
      const name = document.createElement('input'); name.className = 'name'; name.value = pack.name; name.title = 'Pack name';
      name.addEventListener('change', () => { pack.name = name.value; renderDependents(); });
      head.appendChild(name);
      const onAll = mk('button', 'btn sm', 'All'); onAll.onclick = () => { pack.colors.forEach(c => c.on = true); afterPaletteChange(); };
      const offAll = mk('button', 'btn sm', 'None'); offAll.onclick = () => { pack.colors.forEach(c => c.on = false); afterPaletteChange(); };
      const add = mk('button', 'btn sm', '+ Color'); add.onclick = () => { const c = { uid: newUid(), id: 'c' + newUid(), name: 'New color', hex: '#888888', on: true }; pack.colors.push(c); state.editingColor = c.uid; afterPaletteChange(); };
      const del = mk('button', 'btn sm', '✕'); del.title = 'Remove pack';
      del.onclick = armed(del, () => { state.packs = state.packs.filter(p => p !== pack); afterPaletteChange(); });
      head.append(onAll, offAll, add, del);
      el.appendChild(head);

      const meta = document.createElement('div'); meta.className = 'pack-meta';
      const fin = document.createElement('select');
      P.FINISHES.forEach(f => { const o = document.createElement('option'); o.value = f; o.textContent = f; if (f === pack.finish) o.selected = true; fin.appendChild(o); });
      fin.onchange = () => { pack.finish = fin.value; renderDependents(); };
      const mat = document.createElement('input'); mat.value = pack.material; mat.title = 'Design Space material setting';
      mat.onchange = () => { pack.material = mat.value; renderDependents(); };
      meta.append(mk('label', '', 'Finish'), fin, mk('label', '', 'Cut setting'), mat);
      el.appendChild(meta);

      const sw = document.createElement('div'); sw.className = 'swatches';
      for (const c of pack.colors) {
        const b = document.createElement('button'); b.className = 'swatch' + (c.on ? '' : ' off') + (state.editingColor === c.uid ? ' editing' : '');
        b.style.background = c.hex; b.title = c.name + ' ' + c.hex + (c.on ? '' : ' (excluded)');
        const k = mk('span', 'k', c.name); b.appendChild(k);
        b.onclick = () => { state.editingColor = state.editingColor === c.uid ? null : c.uid; renderPacks(); };
        b.oncontextmenu = ev => { ev.preventDefault(); c.on = !c.on; afterPaletteChange(); };
        sw.appendChild(b);
      }
      el.appendChild(sw);

      const editing = pack.colors.find(c => c.uid === state.editingColor);
      if (editing) {
        const ed = document.createElement('div'); ed.className = 'color-editor';
        const col = document.createElement('input'); col.type = 'color'; col.value = editing.hex;
        const nm = document.createElement('input'); nm.type = 'text'; nm.value = editing.name; nm.placeholder = 'Name';
        const hx = document.createElement('input'); hx.type = 'text'; hx.className = 'hex'; hx.value = editing.hex;
        const on = document.createElement('label'); on.className = 'check';
        const onCb = document.createElement('input'); onCb.type = 'checkbox'; onCb.checked = editing.on; on.append(onCb, document.createTextNode(' use'));
        const rm = mk('button', 'btn sm', 'Delete');
        col.oninput = () => { editing.hex = col.value; hx.value = col.value; schedulePaletteChange(); };
        hx.onchange = () => { const v = E.rgbToHex(...E.hexToRgb(hx.value)); editing.hex = v; col.value = v; hx.value = v; afterPaletteChange(); };
        nm.onchange = () => { editing.name = nm.value; afterPaletteChange(); };
        onCb.onchange = () => { editing.on = onCb.checked; afterPaletteChange(); };
        rm.onclick = () => { pack.colors = pack.colors.filter(c => c !== editing); state.editingColor = null; afterPaletteChange(); };
        ed.append(col, nm, hx, on, mk('span', 'muted small', 'right-click a swatch to toggle'), rm);
        el.appendChild(ed);
      }
      root.appendChild(el);
    }
  }
  function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  // Two-step confirmation for destructive buttons (dialogs are unavailable in some hosts).
  function armed(btn, fn) {
    let armedAt = 0; const label = btn.textContent;
    return () => {
      if (Date.now() - armedAt < 4000) { armedAt = 0; btn.textContent = label; fn(); return; }
      armedAt = Date.now(); btn.textContent = 'Sure?';
      setTimeout(() => { if (armedAt) { btn.textContent = label; armedAt = 0; } }, 4000);
    };
  }
  const schedulePaletteChange = debounce(afterPaletteChange, 150);
  function afterPaletteChange() { renderPacks(); renderDependents(); schedule(); }
  function renderDependents() { renderColorSelects(); renderPaintStrip(); renderToneList(); }

  function colorOptionLabel(c) { return c.name + ' · ' + c.pack; }
  function fillColorSelect(sel, current, allowNone) {
    sel.innerHTML = '';
    if (allowNone) { const o = document.createElement('option'); o.value = ''; o.textContent = '— auto —'; sel.appendChild(o); }
    for (const c of activeColors()) {
      const o = document.createElement('option'); o.value = String(c.uid); o.textContent = colorOptionLabel(c);
      if (c.uid === current) o.selected = true; sel.appendChild(o);
    }
  }
  function renderColorSelects() {
    const act = activeColors();
    if (!act.find(c => c.uid === state.settings.edgeColor)) {
      const dark = act.slice().sort((a, b) => a.lab[0] - b.lab[0])[0];
      state.settings.edgeColor = dark ? dark.uid : null;
    }
    if (!act.find(c => c.uid === state.settings.backingColor)) state.settings.backingColor = act.length ? act[0].uid : null;
    fillColorSelect($('edgeColor'), state.settings.edgeColor, false);
    fillColorSelect($('backingColor'), state.settings.backingColor, false);
    const sp = $('samplePack'); const cur = sp.value; sp.innerHTML = '';
    state.packs.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; if (p.id === cur) o.selected = true; sp.appendChild(o); });
  }
  function renderPaintStrip() {
    const strip = $('paintStrip'); strip.innerHTML = '';
    const act = activeColors();
    if (!act.find(c => c.uid === state.paintUid) && state.paintUid !== -1) state.paintUid = act.length ? act[0].uid : null;
    for (const c of act) {
      const b = document.createElement('button'); b.className = 'sw' + (state.paintUid === c.uid ? ' active' : '');
      b.style.background = c.hex; b.title = colorOptionLabel(c);
      b.onclick = () => { state.paintUid = c.uid; renderPaintStrip(); };
      strip.appendChild(b);
    }
    const cut = document.createElement('button'); cut.className = 'sw' + (state.paintUid === -1 ? ' active' : '');
    cut.title = 'Cut away (no paper)'; cut.style.background = 'repeating-linear-gradient(45deg, transparent 0 4px, var(--bad) 4px 6px)';
    cut.onclick = () => { state.paintUid = -1; renderPaintStrip(); };
    strip.appendChild(cut);
  }
  function renderToneList() {
    const root = $('toneList'); root.innerHTML = '';
    const act = activeColors().slice().sort((a, b) => a.lab[0] - b.lab[0]);
    for (const c of act) {
      const row = document.createElement('label'); row.className = 'cluster-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !state.toneUse || state.toneUse.has(c.uid);
      cb.onchange = () => { if (!state.toneUse) state.toneUse = new Set(act.map(x => x.uid)); if (cb.checked) state.toneUse.add(c.uid); else state.toneUse.delete(c.uid); schedule(); };
      const sw = mk('span', 'sw'); sw.style.background = c.hex;
      row.append(cb, mk('span', '', colorOptionLabel(c)), sw);
      row.style.gridTemplateColumns = 'auto 1fr 26px';
      root.appendChild(row);
    }
  }

  /* ------------------------------------------------------------ image */
  async function setImageFromSrc(src, name) {
    const im = await loadImageEl(src);
    const cap = 4000;
    const sc = Math.min(1, cap / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * sc)); c.height = Math.max(1, Math.round(im.naturalHeight * sc));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    state.image = { name: name || 'image', canvas: c, w: c.width, h: c.height, src };
    state.overrides = null; state.undo = []; state.clusterMap = {}; state.selectedLayer = null; state.stackN = null; state.order = []; state.excluded = new Set();
    rebuildWork();
    $('imageTag').textContent = `${state.image.name} · ${c.width}×${c.height}`;
    schedule();
  }
  function rebuildWork() {
    if (!state.image) return;
    const res = Number(state.settings.workRes);
    const sc = Math.min(1, res / Math.max(state.image.w, state.image.h));
    const w = Math.max(8, Math.round(state.image.w * sc)), h = Math.max(8, Math.round(state.image.h * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.image.canvas, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    state.work = { rgba, w, h, id: newUid() };
    if (!state.overrides || state.overrides.length !== w * h) { state.overrides = new Int32Array(w * h); state.undo = []; }
    cache.preKey = null; cache.segKey = null; cache.edgeKey = null;
    const sc2 = $('stageCanvas'); sc2.width = w; sc2.height = h;
  }

  /* Example photos shipped in examples/photos (public domain / CC0; see CREDITS.md). They load over
     http from the local app; a page opened straight from disk can't read their pixels, so it falls back
     to the drawn sample below. */
  const EXAMPLES = [
    { file: 'sunflower.jpg', title: 'Sunflower' },
    { file: 'blue-ridge-sunset.jpg', title: 'Blue Ridge sunset' },
    { file: 'red-fox.jpg', title: 'Red fox' }
  ];
  function renderExamples() {
    const strip = $('examplePhotos'); strip.innerHTML = '';
    EXAMPLES.forEach(ex => {
      const b = mk('button', 'example'); b.type = 'button'; b.title = 'Use the ' + ex.title.toLowerCase() + ' example';
      const im = document.createElement('img'); im.src = 'examples/photos/' + ex.file; im.alt = ''; im.loading = 'lazy';
      b.append(im, mk('span', '', ex.title));
      b.onclick = () => loadExample(ex);
      strip.appendChild(b);
    });
  }
  async function loadExample(ex) {
    try {
      const im = await loadImageEl('examples/photos/' + ex.file);
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      await setImageFromSrc(c.toDataURL('image/jpeg', 0.95), ex.file.replace(/\.jpg$/, ''));
      if (state.step === 2) { state.lookPick = null; goStep(3); }
    } catch (e) {
      toast(location.protocol === 'file:' ? 'Examples need the app: start it with the launcher, then open the page it shows.' : 'Could not load the example: ' + e.message, 5000);
    }
  }
  function loadSampleImage() {
    // A procedural scene with a handful of flat-ish regions: a usable demo of the pipeline.
    const w = 960, h = 720, c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, h * 0.6); sky.addColorStop(0, '#2a4d8f'); sky.addColorStop(1, '#f2c48a');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f7d35a'; g.beginPath(); g.arc(w * 0.68, h * 0.36, 85, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4b3a6b'; g.beginPath(); g.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 40) g.lineTo(x, h * 0.62 - 110 * Math.abs(Math.sin(x / 150)) - 40 * Math.sin(x / 57));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
    g.fillStyle = '#2f6b45'; g.beginPath(); g.moveTo(0, h * 0.78);
    for (let x = 0; x <= w; x += 30) g.lineTo(x, h * 0.74 + 50 * Math.sin(x / 120));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
    g.fillStyle = '#1d4430'; g.beginPath(); g.moveTo(0, h * 0.9);
    for (let x = 0; x <= w; x += 30) g.lineTo(x, h * 0.86 + 30 * Math.cos(x / 90));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
    // a tree
    g.fillStyle = '#3a2a1c'; g.fillRect(w * 0.22 - 14, h * 0.5, 28, h * 0.35);
    g.fillStyle = '#1d4430';
    for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(w * 0.22 - 120 + i * 18, h * 0.62 - i * 60); g.lineTo(w * 0.22, h * 0.25 - i * 40); g.lineTo(w * 0.22 + 120 - i * 18, h * 0.62 - i * 60); g.fill(); }
    // birds
    g.strokeStyle = '#1c1c1e'; g.lineWidth = 5; g.lineCap = 'round';
    [[0.4, 0.2], [0.46, 0.17], [0.52, 0.22]].forEach(([fx, fy]) => { const x = w * fx, y = h * fy; g.beginPath(); g.moveTo(x - 22, y); g.quadraticCurveTo(x - 11, y - 14, x, y); g.quadraticCurveTo(x + 11, y - 14, x + 22, y); g.stroke(); });
    setImageFromSrc(c.toDataURL('image/png'), 'sample-sunset').then(() => { if (state.step === 2) { state.lookPick = null; goStep(3); } });
  }

  /* --------------------------------------------------------- pipeline */
  const schedule = debounce(() => { $('busy').hidden = false; setTimeout(runPipeline, 10); }, 120);

  function runPipeline() {
    try { runPipelineInner(); } catch (e) { console.error(e); toast('Processing failed: ' + e.message, 5000); }
    $('busy').hidden = true;
  }

  function runPipelineInner() {
    if (!state.work) { renderStatus(); return; }
    const S = state.settings, w = state.work.w, h = state.work.h, n = w * h;
    const cols = activeColors();
    const ppi = w / S.widthIn;

    const preKey = JSON.stringify([S.brightness, S.contrast, S.saturation, S.blur, S.autoLevels, S.localContrast, S.edgeSmooth, state.work.id]);
    if (cache.preKey !== preKey) { cache.pre = E.preprocess(state.work.rgba, w, h, S); cache.preKey = preKey; cache.segKey = null; cache.edgeKey = null; }

    const uidToIdx = new Map(cols.map((c, i) => [c.uid, i]));
    let toneColors = null;
    if (S.mode === 'tones') {
      const use = cols.filter(c => !state.toneUse || state.toneUse.has(c.uid)).sort((a, b) => a.lab[0] - b.lab[0]);
      toneColors = use.map(c => uidToIdx.get(c.uid));
    }
    const segKey = JSON.stringify([preKey, S.mode, S.k, S.deltaE, S.assign, S.unique, S.merge, S.minShare, S.toneSpread, toneColors, cols.map(c => c.uid + c.hex)]);
    if (cache.segKey !== segKey) {
      cache.seg = E.segment(cache.pre, cols, { mode: S.mode, k: S.k, deltaE: S.deltaE, assign: S.assign, unique: S.unique, merge: S.merge, minShare: S.minShare / 100, toneSpread: S.toneSpread, toneColors });
      cache.segKey = segKey;
    }
    const seg = cache.seg;
    const map = seg.clusters.map((c, i) => { const u = state.clusterMap[i]; return (u != null && uidToIdx.has(u)) ? uidToIdx.get(u) : null; });
    let labels = E.clustersToLabels(seg.clusterIdx, seg.clusters, map);

    // manual edits
    const ov = state.overrides;
    if (ov) for (let i = 0; i < n; i++) {
      const u = ov[i];
      if (u > 0) { const idx = uidToIdx.get(u); if (idx != null) labels[i] = idx; }
      else if (u === -1) labels[i] = -1;
    }

    // cleanup
    if (S.smoothR > 0) labels = E.modeFilter(labels, w, h, S.smoothR, cols.length);
    const minPx = Math.round(S.minPiece * ppi * ppi);
    if (minPx > 1) labels = E.despeckle(labels, w, h, minPx, 2, cols.length, null);

    // delineation
    let edgeIdx = -1;
    if (S.edgeOn && uidToIdx.has(S.edgeColor) && cols.length) {
      edgeIdx = uidToIdx.get(S.edgeColor);
      const r = Math.max(0, Math.round((S.edgeWidth * ppi - 1) / 2));
      let em;
      if (S.edgeSource === 'photo') {
        const ek = JSON.stringify([preKey]);
        if (cache.edgeKey !== ek) { cache.edge = E.sobel(cache.pre); cache.edgeKey = ek; }
        em = E.thresholdMask(cache.edge, Math.pow(1 - S.edgeSens / 100, 2) * 0.9 + 0.02);
      } else em = E.labelBoundaries(labels, w, h);
      em = E.dilate(em, w, h, r);
      for (let i = 0; i < n; i++) if (em[i] && labels[i] >= 0) labels[i] = edgeIdx;
    }

    // coverage per color
    const counts = new Int32Array(cols.length + 1);
    for (let i = 0; i < n; i++) counts[labels[i] + 1]++;
    const present = cols.filter((c, i) => counts[i + 1] > 0).map(c => c.uid);
    let order = state.order.filter(u => present.includes(u));
    const missing = present.filter(u => !order.includes(u)).sort((a, b) => counts[uidToIdx.get(b) + 1] - counts[uidToIdx.get(a) + 1]);
    if (order.length === 0) order = autoOrderList(missing, cols, counts, uidToIdx, S.autoOrder);
    else order = order.concat(missing);
    if (edgeIdx >= 0) { const eu = cols[edgeIdx].uid; order = order.filter(u => u !== eu); order.push(eu); } // outline always on top
    state.order = order;

    const outUids = order.filter(u => !state.excluded.has(u));
    const outIdx = outUids.map(u => uidToIdx.get(u));
    if (S.maxPieces > 0) {
      labels = E.limitPieces(labels, w, h, outIdx, S.layerMode, S.maxPieces, edgeIdx);
      counts.fill(0); for (let i = 0; i < n; i++) counts[labels[i] + 1]++;
    }
    const backing = (S.backingOn && uidToIdx.has(S.backingColor)) ? { label: uidToIdx.get(S.backingColor), offset: Math.round(S.backingOffset * ppi) } : null;
    const minFeaturePx = Math.round(S.minFeature * ppi / 2);
    let layers = E.buildLayers(labels, w, h, outIdx, S.layerMode, { underlap: Math.round(S.underlap * ppi), backing, minFeature: minFeaturePx, maxPieces: S.maxPieces });
    const traceOpts = { tolerance: S.tol, round: S.round, preRound: 1, minLoopArea: Math.max(2, minPx * 0.5) };
    layers.forEach(L => {
      const t = E.maskToLoops(L.mask, w, h, traceOpts);
      L.loops = t.loops; L.pieces = t.pieces; L.holes = t.holes; L.color = cols[L.label]; L.uid = cols[L.label].uid;
      L.areaIn2 = E.maskStats(L.mask) / (ppi * ppi);
      L.nodes = E.nodeCount(t.loops);
      L.path2d = null; // built lazily from the exported path data
      L.thinIn2 = ((L.thinRemoved || 0) + (L.fragmentsDropped || 0)) / (ppi * ppi);
      L.smallest = t.loops.reduce((m, l) => l.area > 0 ? Math.min(m, l.area) : m, Infinity) / (ppi * ppi);
    });
    const empties = layers.filter(L => L.pieces === 0);
    layers = layers.filter(L => L.pieces > 0);

    state.result = { labels, cols, counts, layers, empties, ppi, w, h, uidToIdx, clusters: seg.clusters, clusterIdx: seg.clusterIdx, edgeIdx, backing: (backing && layers.length && layers[0].backing) ? backing : null, minPx, minFeaturePx };
    if (state.stackN == null || state.stackN > layers.length) state.stackN = layers.length;
    renderAll();
  }

  function autoOrderList(uids, cols, counts, uidToIdx, how) {
    const byUid = u => cols[uidToIdx.get(u)];
    const list = uids.slice();
    if (how === 'dark') list.sort((a, b) => byUid(a).lab[0] - byUid(b).lab[0]);
    else if (how === 'light') list.sort((a, b) => byUid(b).lab[0] - byUid(a).lab[0]);
    else list.sort((a, b) => counts[uidToIdx.get(b) + 1] - counts[uidToIdx.get(a) + 1]);
    return list;
  }

  /* ----------------------------------------------------------- render */
  function renderAll() {
    renderStage(); renderStatus(); renderClusterTable(); renderLayerList(); renderSuggestions(); renderFit(); renderCutSheet(); renderTags(); if (exportPanel) exportPanel.refresh();
  }
  function renderTags() {
    const S = state.settings;
    $('matchTag').textContent = S.mode === 'cluster' ? `${S.k} colors` : S.mode === 'nearest' ? 'nearest' : 'tones';
    $('edgeTag').textContent = S.edgeOn ? `${S.edgeWidth.toFixed(2)} in` : 'off';
    $('cleanTag').textContent = `≥ ${S.minPiece} in² · ≥ ${S.minFeature} in wide`;
    $('layerTag').textContent = S.layerMode;
    $('layerChip').textContent = state.result ? `${state.result.layers.length} sheets` : '0 layers';
  }

  function renderStage() {
    const cv = $('stageCanvas');
    const R = state.result;
    if (!state.work) return;
    const { w, h } = state.work;
    const cutsMode = state.view === 'cuts' && R;
    $('cutsGrid').hidden = !cutsMode; cv.hidden = !!cutsMode;
    if (cutsMode) { renderCuts(); $('stackCtl').hidden = true; return; }
    if (state.view === 'vector' && R) {
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
      drawVector(g, R.layers, w, h, null);
      if (state.selectedLayer != null) { const L = R.layers.find(x => x.uid === state.selectedLayer && !x.backing); if (L) { g.strokeStyle = '#c7461f'; g.lineWidth = 2; g.stroke(layerPath(L)); } }
      $('stackCtl').hidden = true; cv.className = 'tool-pick'; return;
    }
    if (state.view === 'sheet' && R) {
      const landscape = false; cv.width = 850; cv.height = 1100;
      drawSheet(cv, null); $('stackCtl').hidden = true; cv.className = 'tool-pick'; return;
    }
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    if (state.view === 'original' || !R) {
      d.set(state.work.rgba);
    } else if (state.view === 'mapped') {
      const lut = R.cols.map(c => E.hexToRgb(c.hex));
      for (let i = 0; i < w * h; i++) {
        const L = R.labels[i];
        if (L < 0) continue;
        const c = lut[L]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
      }
      if (state.selectedLayer != null) { // dim everything that is not the selected color
        const idx = R.uidToIdx.get(state.selectedLayer);
        for (let i = 0; i < w * h; i++) if (R.labels[i] !== idx && R.labels[i] >= 0) d[i * 4 + 3] = 70;
      }
    } else {
      const upto = Math.min(state.stackN == null ? R.layers.length : state.stackN, R.layers.length);
      for (let li = 0; li < upto; li++) {
        const L = R.layers[li]; const c = E.hexToRgb(L.color.hex);
        const dim = state.selectedLayer != null && !(L.uid === state.selectedLayer && !L.backing) ? 0.3 : 1;
        for (let i = 0; i < w * h; i++) {
          if (!L.mask[i]) continue;
          const p = i * 4;
          if (dim === 1 || d[p + 3] === 0) { d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255; }
          else { d[p] = d[p] * (1 - dim) + c[0] * dim; d[p + 1] = d[p + 1] * (1 - dim) + c[1] * dim; d[p + 2] = d[p + 2] * (1 - dim) + c[2] * dim; d[p + 3] = 255; }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    const sc = $('stackCtl'); sc.hidden = state.view !== 'layers' || !R;
    if (R) {
      const sl = $('stackSlider'); sl.max = R.layers.length; sl.value = state.stackN;
      $('stackLabel').textContent = `${state.stackN} / ${R.layers.length} sheets placed`;
    }
    cv.className = 'tool-' + state.tool;
  }

  function layerPath(L) { if (!L.path2d) L.path2d = new Path2D(layerPathD(L)); return L.path2d; }

  // The vector preview: every sheet's actual cut path, filled, in stacking order.
  function drawVector(ctx, layers, w, h, only) {
    ctx.save();
    for (const L of layers) {
      if (only != null && L !== only) continue;
      ctx.fillStyle = L.color.hex;
      ctx.fill(layerPath(L), 'evenodd');
    }
    ctx.restore();
  }

  /* Draw an 8.5 x 11 sheet to scale with the artwork (or one layer) placed on it. */
  function drawSheet(cv, layerIndex, opts) {
    opts = opts || {};
    const R = state.result, S = state.settings; if (!R) return;
    const o = outputSize();
    const pack = layerIndex != null ? R.layers[layerIndex].color.packObj : null;
    const sheetW = (pack && pack.sheetW) || 8.5, sheetH = (pack && pack.sheetH) || 11;
    const cw = cv.width, ch = cv.height;
    const g = cv.getContext('2d');
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
    g.fillStyle = dark ? '#2d2b27' : '#e7e2d8'; g.fillRect(0, 0, cw, ch);
    const pad = Math.round(Math.min(cw, ch) * 0.06);
    const sc = Math.min((cw - 2 * pad) / sheetW, (ch - 2 * pad) / sheetH);
    const px = Math.round((cw - sheetW * sc) / 2), py = Math.round((ch - sheetH * sc) / 2);
    // paper
    g.shadowColor = 'rgba(0,0,0,0.25)'; g.shadowBlur = sc * 0.15; g.shadowOffsetY = sc * 0.05;
    g.fillStyle = layerIndex != null ? R.layers[layerIndex].color.hex : (dark ? '#f3f1ec' : '#fbfaf6');
    if (layerIndex != null) g.fillStyle = dark ? '#f3f1ec' : '#fbfaf6';
    g.fillRect(px, py, sheetW * sc, sheetH * sc);
    g.shadowColor = 'transparent';
    // mat cut area
    const mx = px + (sheetW - S.matW) / 2 * sc, my = py + (sheetH - S.matH) / 2 * sc;
    g.setLineDash([sc * 0.12, sc * 0.08]); g.strokeStyle = dark ? '#8a8378' : '#b9b1a1'; g.lineWidth = 1;
    g.strokeRect(mx, my, S.matW * sc, S.matH * sc); g.setLineDash([]);
    // artwork placement (rotate if it only fits that way)
    let aw = o.wIn, ah = o.hIn, rot = false;
    const fits = (w, h) => w <= S.matW && h <= S.matH;
    if (!fits(aw, ah) && fits(ah, aw)) rot = true;
    const tooBig = !fits(rot ? ah : aw, rot ? aw : ah);
    const dw = (rot ? ah : aw) * sc, dh = (rot ? aw : ah) * sc;
    const ax = mx + (S.matW * sc - dw) / 2, ay = my + (S.matH * sc - dh) / 2;
    // offscreen artwork at work resolution (with margin)
    const m = o.marginPx, W = R.w + 2 * m, H = R.h + 2 * m;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const og = off.getContext('2d');
    og.translate(m, m);
    drawVector(og, R.layers, R.w, R.h, layerIndex == null ? null : R.layers[layerIndex]);
    og.translate(-m, -m);
    if (S.regMarks && m > 0) {
      const sz = Math.min(m * 0.6, R.ppi * 0.25); og.fillStyle = layerIndex != null ? R.layers[layerIndex].color.hex : '#333';
      [[0, 0], [W - sz, 0], [0, H - sz], [W - sz, H - sz]].forEach(([x, y]) => og.fillRect(x, y, sz, sz));
    }
    g.save();
    g.translate(ax + dw / 2, ay + dh / 2); if (rot) g.rotate(Math.PI / 2);
    g.imageSmoothingQuality = 'high';
    g.drawImage(off, -aw * sc / 2, -ah * sc / 2, aw * sc, ah * sc);
    if (layerIndex != null) { g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.strokeRect(-aw * sc / 2, -ah * sc / 2, aw * sc, ah * sc); }
    g.restore();
    // labels
    if (!opts.noLabels) {
      g.fillStyle = dark ? '#ece7dc' : '#221f1b'; g.font = `${Math.max(10, sc * 0.28)}px "IBM Plex Mono", monospace`; g.textBaseline = 'top';
      g.fillText(`${sheetW} × ${sheetH} in sheet`, px + sc * 0.2, py + sc * 0.15);
      g.textBaseline = 'bottom';
      const sizeTxt = `art ${fmt(aw)} × ${fmt(ah)} in${rot ? ' (rotated)' : ''}${tooBig ? ' — TOO BIG for the mat' : ''}`;
      g.fillStyle = tooBig ? '#b3261e' : (dark ? '#ece7dc' : '#221f1b');
      g.fillText(sizeTxt, px + sc * 0.2, py + sheetH * sc - sc * 0.15);
      // dimension ticks
      g.strokeStyle = dark ? '#a59d8e' : '#6f685c'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(ax, ay - sc * 0.25); g.lineTo(ax + dw, ay - sc * 0.25); g.stroke();
      g.beginPath(); g.moveTo(ax - sc * 0.25, ay); g.lineTo(ax - sc * 0.25, ay + dh); g.stroke();
    }
    return { rot, tooBig, sheetW, sheetH };
  }

  function renderCuts() {
    const grid = $('cutsGrid'); grid.innerHTML = '';
    const R = state.result; if (!R) return;
    R.layers.forEach((L, i) => {
      const card = document.createElement('div'); card.className = 'cut-card' + (state.selectedLayer === L.uid && !L.backing ? ' selected' : '');
      const cv = document.createElement('canvas'); cv.width = 340; cv.height = 440;
      drawSheet(cv, i, { noLabels: true });
      card.appendChild(cv);
      const t = document.createElement('div'); t.className = 't';
      t.appendChild(mk('b', '', `${i + 1}. ${L.color.name}${L.backing ? ' (backing)' : ''}`));
      t.appendChild(mk('span', '', `${L.color.pack} · ${L.color.finish}`));
      t.appendChild(mk('span', '', `${L.pieces} piece${L.pieces === 1 ? '' : 's'} · ${L.holes} hole${L.holes === 1 ? '' : 's'} · ${fmt(L.areaIn2, 1)} in²`));
      t.appendChild(mk('span', 'muted', `Design Space: ${L.color.material}`));
      card.appendChild(t);
      card.onclick = () => { state.selectedLayer = state.selectedLayer === L.uid ? null : L.uid; renderLayerList(); renderCuts(); };
      grid.appendChild(card);
    });
  }

  function renderStatus() {
    const el = $('status');
    if (!state.work) { el.innerHTML = '<span>Upload a photo or load the sample to begin.</span>'; return; }
    const R = state.result;
    const S = state.settings;
    const hIn = state.work.h / state.work.w * S.widthIn;
    $('heightOut').textContent = fmt(hIn) + ' in';
    let s = `<span>Working <b class="num">${state.work.w}×${state.work.h}</b> px at <b class="num">${fmt(state.work.w / S.widthIn, 0)}</b> px/in</span>`;
    if (R) {
      const act = R.cols.length;
      s += `<span><b>${act}</b> papers active, <b>${R.layers.length}</b> sheets to cut</span>`;
      const totalPieces = R.layers.reduce((a, L) => a + L.pieces, 0);
      s += `<span><b class="num">${totalPieces}</b> pieces total</span>`;
      if (state.undo.length) s += `<span><b>${state.undo.length}</b> manual edits</span>`;
    }
    if (state.view === 'mapped') s += '<span class="muted">Pick: click a region to highlight its sheet · Fill/Brush recolor with the paint swatch · right-click a swatch in Paper to toggle it</span>';
    if (state.view === 'sheet') s += '<span class="muted">The artwork at true scale on an 8.5 × 11 sheet. Dashed line: the mat cut area.</span>';
    if (state.view === 'vector' && R) s += `<span class="muted">The cut file itself: ${R.layers.reduce((a, L) => a + L.nodes, 0)} nodes across ${R.layers.length} sheets, ${state.settings.curves ? 'smooth curves' : 'straight segments'}.</span>`;
    if (state.view === 'cuts') s += '<span class="muted">One card per sheet, bottom first: exactly what each piece of cardstock will be cut into.</span>';
    el.innerHTML = s;
  }

  function renderClusterTable() {
    const root = $('clusterTable'); root.innerHTML = '';
    const R = state.result; if (!R) return;
    const total = R.clusters.reduce((a, c) => a + c.count, 0) || 1;
    const act = activeColors();
    R.clusters.forEach((c, i) => {
      const row = document.createElement('div'); row.className = 'cluster-row';
      const sw = mk('span', 'sw'); sw.style.background = c.hex; sw.title = 'Detected ' + c.hex;
      const sel = document.createElement('select');
      const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'auto → ' + (c.paletteIdx >= 0 ? act[c.paletteIdx].name : '—');
      sel.appendChild(auto);
      for (const a of act) { const o = document.createElement('option'); o.value = String(a.uid); o.textContent = colorOptionLabel(a); if (state.clusterMap[i] === a.uid) o.selected = true; sel.appendChild(o); }
      sel.onchange = () => { if (sel.value) state.clusterMap[i] = Number(sel.value); else delete state.clusterMap[i]; schedule(); };
      const pct = mk('span', 'pct num', fmt(100 * c.count / total, 1) + '%');
      row.append(sw, sel, pct);
      if (c.distance != null) {
        const far = c.distance > 15;
        const de = mk('span', 'note' + (far ? ' warn' : ''), 'ΔE ' + fmt(c.distance, 0) + (far ? ' — no close sheet; override or add a paper' : ''));
        de.style.gridColumn = '1 / -1'; de.style.fontSize = '11px'; de.style.marginTop = '-2px';
        row.appendChild(de);
      }
      root.appendChild(row);
    });
  }

  function renderLayerList() {
    const root = $('layerList'); root.innerHTML = '';
    const R = state.result; if (!R) return;
    const S = state.settings;
    // rows follow state.order (bottom -> top) and include excluded colors
    const rows = state.order.map(u => ({ uid: u, col: R.cols[R.uidToIdx.get(u)], layer: R.layers.find(L => L.uid === u && !L.backing) }));
    if (R.backing) rows.unshift({ uid: null, col: R.cols[R.backing.label], layer: R.layers[0], backing: true });
    rows.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'layer-row' + (r.uid != null && state.excluded.has(r.uid) ? ' off' : '') + (r.uid != null && state.selectedLayer === r.uid ? ' selected' : '');
      el.draggable = r.uid != null; el.dataset.uid = r.uid == null ? '' : String(r.uid);
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = r.backing ? true : !state.excluded.has(r.uid); cb.title = 'Include in output';
      cb.disabled = !!r.backing;
      cb.onchange = () => { if (cb.checked) state.excluded.delete(r.uid); else state.excluded.add(r.uid); schedule(); };
      const sw = mk('span', 'sw'); sw.style.background = r.col.hex;
      const name = document.createElement('div'); name.className = 'name';
      name.appendChild(mk('b', '', (r.backing ? 'Backing · ' : '') + r.col.name + (R.edgeIdx >= 0 && R.cols[R.edgeIdx].uid === r.uid ? ' · outline' : '')));
      name.appendChild(mk('span', '', r.col.pack + ' · ' + r.col.finish));
      const st = document.createElement('div'); st.className = 'stats';
      if (r.layer) {
        const sheet = r.col.packObj; const fits = S.widthIn <= Math.max(sheet.sheetW, sheet.sheetH) ? '' : ' <span class="alert">wider than sheet</span>';
        const tiny = r.layer.smallest < S.minPiece * 1.5 && isFinite(r.layer.smallest) ? ` <span class="alert" title="smallest piece ${fmt(r.layer.smallest, 3)} in²">tiny</span>` : '';
        const thin = r.layer.thinIn2 > 0.02 ? ` <span class="alert" title="${fmt(r.layer.thinIn2, 2)} in² thinner than ${S.minFeature} in was removed">thin</span>` : '';
        st.innerHTML = `<b>${r.layer.pieces}</b> pc · ${r.layer.holes} holes<br>${fmt(100 * r.layer.coverage, 0)}% area${fits}${tiny}${thin}`;
      } else if (R.empties.find(L => L.uid === r.uid)) st.innerHTML = '<span class="alert">empty after cleanup</span>';
      else st.innerHTML = '<span class="muted">left out</span>';
      const ctl = document.createElement('div'); ctl.className = 'ctl';
      const up = mk('button', 'btn', '▼'); up.title = 'Move down (toward bottom)';
      const dn = mk('button', 'btn', '▲'); dn.title = 'Move up (toward top)';
      up.onclick = ev => { ev.stopPropagation(); moveOrder(r.uid, -1); };
      dn.onclick = ev => { ev.stopPropagation(); moveOrder(r.uid, +1); };
      if (!r.backing) ctl.append(up, dn);
      el.append(cb, sw, name, st, ctl);
      el.onclick = ev => { if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return; if (r.uid == null) return; state.selectedLayer = state.selectedLayer === r.uid ? null : r.uid; state.paintUid = r.uid; renderPaintStrip(); renderLayerList(); renderStage(); };
      el.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/plain', el.dataset.uid); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', ev => { ev.preventDefault(); });
      el.addEventListener('drop', ev => {
        ev.preventDefault(); const from = Number(ev.dataTransfer.getData('text/plain')); const to = r.uid;
        if (!from || to == null || from === to) return;
        const o = state.order.filter(u => u !== from); o.splice(o.indexOf(to), 0, from); state.order = o; schedule();
      });
      root.appendChild(el);
    });
  }
  /* Short, rule-based layering advice from the current stats. */
  function suggestions() {
    const R = state.result, S = state.settings; if (!R) return [];
    const out = [];
    const far = R.clusters.filter(c => c.distance > 15);
    if (far.length) {
      const grayish = far.some(c => Math.abs(c.lab[1]) < 8 && Math.abs(c.lab[2]) < 8);
      out.push({ kind: 'warn', text: far.length + ' detected color' + (far.length > 1 ? 's have' : ' has') + ' no close sheet (ΔE over 15). Pick a sheet by hand in the table above or add a closer paper' + (grayish ? ' (a gray would help)' : '') + '.' });
    }
    const n = R.layers.length;
    if (n > 7) out.push({ kind: 'warn', text: n + ' sheets is a lot to cut and align. Lower "Colors to detect" or raise "Merge similar colors".' });
    if (n <= 1 && R.cols.length > 1) out.push({ kind: 'warn', text: 'Only one sheet came out. Raise "Colors to detect" or lower "Ignore colors under".' });
    const art = R.layers.filter(L => !L.backing);
    const biggest = art.slice().sort((a, b) => b.areaIn2 - a.areaIn2)[0];
    if (S.layerMode === 'stacked' && biggest && art[0] !== biggest) out.push({ kind: 'tip', text: 'Put ' + biggest.color.name + ' (largest area) at the bottom so fewer pieces sit on top. Use "Largest at bottom" then Apply.' });
    if (S.layerMode === 'stacked') out.push({ kind: 'tip', text: 'Stacked build: glue each sheet whole onto the one below, bottom first. Small misalignment never shows a gap.' });
    else if (n > 4) out.push({ kind: 'tip', text: 'Inlay with more than 4 colors gets fiddly; stacked is easier to assemble.' });
    for (const L of R.layers) {
      if (L.thinIn2 > 0.1 && L.thinIn2 > 0.25 * L.areaIn2) out.push({ kind: 'warn', text: L.color.name + ': ' + fmt(L.thinIn2, 1) + ' in² was thinner than ' + S.minFeature + ' in and was dropped. Thicken it (outline width, smoothing) or lower "Thinnest feature".' });
      if (L.pieces > 40) out.push({ kind: 'warn', text: L.color.name + ': ' + L.pieces + ' separate pieces to place. Raise "Smallest piece" or "Smooth regions", or recolor small bits with Fill.' });
      if (L.holes > 60) out.push({ kind: 'tip', text: L.color.name + ': ' + L.holes + ' holes to weed. Raise "Smallest piece" if that is too many.' });
    }
    if (!(S.maxPieces > 0) && R.layers.some(L => L.pieces > 8)) out.push({ kind: 'tip', text: 'Set "Max pieces per sheet" to fold small islands into the sheet beneath; sheets then place as one shape.' });
    if (R.empties.length) out.push({ kind: 'tip', text: R.empties.map(L => L.color.name).join(', ') + ' had nothing left after cleanup and ' + (R.empties.length > 1 ? 'are' : 'is') + ' skipped.' });
    let transparent = 0; for (let i = 0; i < R.labels.length; i += 7) if (R.labels[i] < 0) transparent++;
    if (transparent * 7 > 0.05 * R.labels.length && !S.backingOn) out.push({ kind: 'tip', text: 'The image has a transparent background. Nothing is cut there; add a backing sheet for a solid card.' });
    if (S.edgeOn && S.edgeWidth < 0.05) out.push({ kind: 'warn', text: 'Outline lines under 0.05 in tear on cardstock; use 0.06 in or more.' });
    return out.slice(0, 7);
  }
  function renderSuggestions() {
    const root = $('suggestions'); root.innerHTML = '';
    const list = suggestions();
    if (!list.length) { root.appendChild(mk('div', 'sug tip', 'Looks cuttable: no tolerance problems found.')); return; }
    for (const sg of list) root.appendChild(mk('div', 'sug ' + sg.kind, sg.text));
  }
  function moveOrder(uid, dir) {
    const i = state.order.indexOf(uid); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= state.order.length) return;
    const o = state.order.slice(); [o[i], o[j]] = [o[j], o[i]]; state.order = o; schedule();
  }

  function outputSize() {
    const S = state.settings; const R = state.result;
    if (!state.work) return null;
    const ppi = state.work.w / S.widthIn;
    let marginPx = 0;
    if (S.regMarks) marginPx = Math.round(S.marginIn * ppi);
    if (R && R.backing && R.backing.offset) marginPx = Math.max(marginPx, R.backing.offset + 2);
    if (S.layerMode === 'inlay' && S.underlap > 0) marginPx = Math.max(marginPx, Math.round(S.underlap * ppi) + 1);
    const wIn = (state.work.w + 2 * marginPx) / ppi, hIn = (state.work.h + 2 * marginPx) / ppi;
    return { marginPx, wIn, hIn, ppi };
  }
  function renderFit() {
    const chip = $('fitChip'), note = $('fitNote'); const S = state.settings;
    const o = outputSize();
    if (!o) { chip.className = 'chip'; chip.textContent = 'No image'; note.textContent = ''; return; }
    const fits = (W, H) => (o.wIn <= W && o.hIn <= H) || (o.hIn <= W && o.wIn <= H);
    const mat = fits(S.matW, S.matH), ptc = fits(S.ptcW, S.ptcH);
    const size = `${fmt(o.wIn)} × ${fmt(o.hIn)} in`;
    if (mat) { chip.className = 'chip ok'; chip.textContent = `${size} · fits mat`; }
    else { chip.className = 'chip bad'; chip.textContent = `${size} · exceeds mat`; }
    note.className = 'note' + (mat ? '' : ' bad');
    note.textContent = mat
      ? `Sheet size ${size} including margins. Mat cut area ${S.matW} × ${S.matH} in (Joy Xtra, 8.5 × 11 cardstock). Print Then Cut ${ptc ? 'also fits' : 'would not fit'} (${S.ptcW} × ${S.ptcH} in).`
      : `Sheet size ${size} is larger than the mat cut area ${S.matW} × ${S.matH} in. Reduce the finished width or the margin.`;
  }

  /* --------------------------------------------------------- cut sheet */
  function cutSheetText() {
    const R = state.result, S = state.settings; if (!R) return '';
    const o = outputSize();
    const lines = [];
    lines.push(`CUT SHEET — ${state.image.name}`);
    lines.push(`Finished art ${fmt(S.widthIn)} × ${fmt(state.work.h / state.work.w * S.widthIn)} in; sheet ${fmt(o.wIn)} × ${fmt(o.hIn)} in incl. margin`);
    lines.push(`Build: ${S.layerMode === 'stacked' ? 'STACKED — every sheet carries its color plus everything above it; glue each sheet fully onto the one below' : 'INLAY — flat puzzle; pieces sit side by side' + (S.underlap ? `, lower pieces extended ${S.underlap} in under their neighbours` : '')}`);
    lines.push('Tolerances: pieces under ' + S.minPiece + ' in² dropped; features thinner than ' + S.minFeature + ' in removed; holes under ' + fmt(S.minPiece / 2, 3) + ' in² filled.');
    if (S.regMarks) lines.push(`Registration: ${fmt(S.marginIn)} in margin with a square in each corner of every sheet — line them up, glue, trim.`);
    lines.push('');
    lines.push('Sheets, bottom → top:');
    R.layers.forEach((L, i) => {
      const c = L.color;
      lines.push(` ${String(i + 1).padStart(2, ' ')}. ${c.name} — ${c.pack} (${c.finish})${L.backing ? ' [backing]' : ''}${R.edgeIdx >= 0 && R.cols[R.edgeIdx].uid === L.uid ? ' [outline]' : ''}`);
      lines.push(`     ${L.pieces} piece${L.pieces === 1 ? '' : 's'}, ${L.holes} hole${L.holes === 1 ? '' : 's'}, ${fmt(L.areaIn2, 1)} in² paper, ${L.nodes} nodes · Design Space: ${c.material}`);
    });
    lines.push('');
    lines.push('Design Space: Upload → Browse → the SVG → Cut image → Upload. Select it, set W = ' + fmt(o.wIn) + ' in (lock on), Ungroup. Make It → one mat per color; load the matching sheet.');
    lines.push('Per-layer SVGs share the same canvas size, so importing them at the same width keeps them aligned.');
    return lines.join('\n');
  }
  function renderCutSheet() { $('cutSheet').value = cutSheetText(); }

  /* ----------------------------------------------------------- export */
  function baseName() { return E.slug((state.image && state.image.name || 'layers').replace(/\.[a-z0-9]+$/i, '')); }
  function layerPathD(L) { return E.pathD(L.loops, 2, state.settings.curves); }
  function svgSpecLayers(layers) {
    return layers.map((L, i) => ({ id: 'L' + String(i + 1).padStart(2, '0') + '-' + E.slug(L.color.name), name: L.color.name, hex: L.color.hex, d: layerPathD(L) }));
  }
  function buildCombinedSvg() {
    const R = state.result, S = state.settings, o = outputSize();
    return E.buildSvg({ w: R.w, h: R.h, widthIn: S.widthIn, margin: o.marginPx, regMarks: S.regMarks, title: baseName(), layers: svgSpecLayers(R.layers) });
  }
  function buildLayerSvg(i) {
    const R = state.result, S = state.settings, o = outputSize();
    return E.buildSvg({ w: R.w, h: R.h, widthIn: S.widthIn, margin: o.marginPx, regMarks: S.regMarks, title: baseName() + ' layer ' + (i + 1), layers: svgSpecLayers([R.layers[i]]) });
  }
  // Hand-off to the shared export panel: every sheet's cut outline as plain polygons in inches.
  function regMarkLoops() {
    const R = state.result, S = state.settings, m = outputSize().marginPx;
    if (!S.regMarks || m <= 0) return [];
    const sz = Math.min(m * 0.6, R.ppi * 0.25);
    return [[-m, -m], [R.w + m - sz, -m], [-m, R.h + m - sz], [R.w + m - sz, R.h + m - sz]].map(([x, y]) => [x, y, x + sz, y, x + sz, y + sz, x, y + sz]);
  }
  function buildLayerSet() {
    const R = state.result, S = state.settings, m = outputSize().marginPx, ppi = R.ppi;
    const toIn = l => l.map(v => v / ppi), marks = regMarkLoops();
    const specs = svgSpecLayers(R.layers);
    return {
      name: baseName(), bounds: [-m / ppi, -m / ppi, (R.w + m) / ppi, (R.h + m) / ppi], origin: 'lowerLeft',
      layers: R.layers.map((L, i) => ({
        id: specs[i].id, name: L.color.name + (L.backing ? ' (backing)' : ''), hex: L.color.hex, paper: `${L.color.name} · ${L.color.pack}`,
        loops: E.flattenLoops(L.loops, S.curves, null, 0.25).concat(marks).map(toIn)
      }))
    };
  }
  let exportPanel = null;
  function exportProvider() {
    return {
      project: baseName,
      size: () => { const R = state.result, o = outputSize(); return R && R.layers.length && o ? { wIn: o.wIn, hIn: o.hIn, layers: R.layers.length } : null; },
      layerSet: buildLayerSet,
      cricutSvg: buildCombinedSvg,
      cricutSvgLayers: () => state.result.layers.map((L, i) => ({ name: L.color.name, svg: buildLayerSvg(i) })),
      notes: () => [{ path: 'cricut/cut-sheet.txt', text: cutSheetText() }, { path: baseName() + '-project.json', text: projectJson() }],
      cricutNote: 'Use the .svg unless you have a reason not to: Design Space traces PNGs, which softens fine detail. The per-layer PNGs share one canvas size, so set each to the same width (see the cut sheet) and they line up.',
      toast
    };
  }

  function projectJson() {
    const S = state.settings;
    return JSON.stringify({
      app: 'paperstrata', version: 1, savedAt: new Date().toISOString(),
      settings: S, packs: state.packs.map(p => ({ ...p, colors: p.colors.map(c => ({ id: c.id, name: c.name, hex: c.hex, on: c.on, uid: c.uid })) })),
      order: state.order, excluded: Array.from(state.excluded), clusterMap: state.clusterMap, toneUse: state.toneUse ? Array.from(state.toneUse) : null,
      overrides: state.overrides ? rleEncode(state.overrides) : null, workSize: state.work ? [state.work.w, state.work.h] : null,
      image: state.image ? { name: state.image.name, src: state.image.src } : null
    });
  }
  function rleEncode(arr) { const out = []; let i = 0; while (i < arr.length) { const v = arr[i]; let j = i; while (j < arr.length && arr[j] === v) j++; out.push(v, j - i); i = j; } return out; }
  function rleDecode(list, n) { const a = new Int32Array(n); let p = 0; for (let i = 0; i < list.length; i += 2) { a.fill(list[i], p, p + list[i + 1]); p += list[i + 1]; } return a; }

  async function loadProject(text) {
    const j = JSON.parse(text);
    if (j.app !== 'paperstrata' && j.app !== 'cardstock-layer-studio') throw new Error('Not a PaperStrata project');   // older saves used the original name
    // packs keep their uids so order / overrides stay meaningful
    state.packs = j.packs.map(p => ({ ...p, colors: p.colors.map(c => ({ ...c })) }));
    uidCounter = Math.max(uidCounter, ...state.packs.flatMap(p => p.colors.map(c => c.uid || 0))) + 1;
    Object.assign(state.settings, j.settings || {});
    settingsToControls();
    state.order = j.order || []; state.excluded = new Set(j.excluded || []); state.clusterMap = j.clusterMap || {};
    state.toneUse = j.toneUse ? new Set(j.toneUse) : null;
    renderPacks(); renderDependents();
    if (j.image && j.image.src) {
      await setImageFromSrc(j.image.src, j.image.name);
      if (j.overrides && j.workSize && state.work.w === j.workSize[0] && state.work.h === j.workSize[1]) state.overrides = rleDecode(j.overrides, state.work.w * state.work.h);
      state.order = j.order || []; state.clusterMap = j.clusterMap || {};
    }
    schedule();
    toast('Project loaded');
  }

  /* ---------------------------------------------------------- explorer */
  // 5 styles x 5 sheet counts. Each cell is a complete setup; clicking one seeds the sliders.
  const BASE = { brightness: 0, contrast: 0, saturation: 0, blur: 1, autoLevels: false, localContrast: 0, edgeSmooth: 0, smoothR: 1, minShare: 1, mode: 'cluster', assign: 'nearest' };
  const STYLES = [
    { name: 'Faithful', desc: 'colors as shot', set: {} },
    { name: 'Clean edges', desc: 'edge-preserving smoothing', set: { edgeSmooth: 2, blur: 0 } },
    { name: 'Auto levels', desc: 'full tonal range', set: { autoLevels: true, edgeSmooth: 1 } },
    { name: 'Local contrast', desc: 'features pulled apart', set: { localContrast: 60, edgeSmooth: 1, autoLevels: true } },
    { name: 'High contrast', desc: 'spread over light and dark sheets', set: { localContrast: 40, edgeSmooth: 1, autoLevels: true, contrast: 15, saturation: 10, assign: 'contrast' } },
    { name: 'Punchy', desc: 'more contrast and color', set: { contrast: 30, saturation: 30, edgeSmooth: 1 } },
    { name: 'Smooth', desc: 'softened, bigger regions', set: { contrast: 10, saturation: 10, blur: 4, smoothR: 2, minShare: 2 } },
    { name: 'Tones', desc: 'light-to-dark bands', set: { contrast: 15, blur: 2, autoLevels: true, edgeSmooth: 1, mode: 'tones' } }
  ].map(st => ({ name: st.name, desc: st.desc, set: Object.assign({}, BASE, st.set) }));
  const SHEET_COUNTS = [2, 3, 4, 5, 6, 7, 8, 10];

  // Pick `count` sheets spread evenly from darkest to lightest, preferring low-chroma (neutral)
  // sheets so tone bands read as shading rather than a rainbow.
  function toneSpread(cols, count) {
    if (cols.length <= count) return cols.slice().sort((a, b) => a.lab[0] - b.lab[0]).map(c => c.uid);
    const Ls = cols.map(c => c.lab[0]);
    const Lmin = Math.min.apply(null, Ls), Lmax = Math.max.apply(null, Ls);
    const used = new Set(), out = [];
    for (let i = 0; i < count; i++) {
      const target = Lmin + (Lmax - Lmin) * i / (count - 1);
      let best = null, bc = Infinity;
      for (const c of cols) {
        if (used.has(c.uid)) continue;
        const chroma = Math.hypot(c.lab[1], c.lab[2]);
        const cost = Math.abs(c.lab[0] - target) + 0.45 * chroma;
        if (cost < bc) { bc = cost; best = c; }
      }
      if (best) { used.add(best.uid); out.push(best.uid); }
    }
    return out;
  }

  // Runs the core pipeline on a small copy of the image for every cell. Synchronous; ~1 s.
  const LOOKS = {
    true: { name: 'True to color', set: { edgeSmooth: 2, blur: 0, autoLevels: false, localContrast: 0, contrast: 0, saturation: 0, mode: 'cluster', assign: 'nearest' } },
    contrast: { name: 'High contrast', set: { edgeSmooth: 1, blur: 0, autoLevels: true, localContrast: 40, contrast: 15, saturation: 10, mode: 'cluster', assign: 'contrast' } },
    poster: { name: 'Poster bands', set: { edgeSmooth: 1, blur: 2, autoLevels: true, localContrast: 0, contrast: 15, saturation: 0, mode: 'tones', assign: 'nearest' } }
  };
  Object.keys(LOOKS).forEach(k => { LOOKS[k].set = Object.assign({}, BASE, LOOKS[k].set); });

  function exploreCells(onlySheets, styles) {
    if (!state.image) return [];
    const cols = activeColors(); if (cols.length < 2) return [];
    const S0 = state.settings;
    const res = 220, sc = Math.min(1, res / Math.max(state.image.w, state.image.h));
    const w = Math.max(8, Math.round(state.image.w * sc)), h = Math.max(8, Math.round(state.image.h * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.drawImage(state.image.canvas, 0, 0, w, h);
    const rgba = g.getImageData(0, 0, w, h).data;
    const n = w * h, ppi = w / S0.widthIn;
    const base = E.preprocess(rgba, w, h, { blur: 1 });
    const baseLab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const l = E.rgbToLab(base.rgb[i * 3], base.rgb[i * 3 + 1], base.rgb[i * 3 + 2]); baseLab[i * 3] = l[0]; baseLab[i * 3 + 1] = l[1]; baseLab[i * 3 + 2] = l[2]; }
    const edges = E.thresholdMask(E.sobel(base), 0.3);
    const edgeCount = Math.max(1, E.maskStats(edges));
    const uidToIdx = new Map(cols.map((cc, i) => [cc.uid, i]));
    const minPx = Math.round(S0.minPiece * ppi * ppi);
    const cells = [];
    const preCache = new Map();
    for (const sheets of (onlySheets || SHEET_COUNTS)) {
      for (const style of (styles || STYLES)) {
        const S = Object.assign({}, S0, style.set, { k: sheets });
        if (!preCache.has(style)) preCache.set(style, E.preprocess(rgba, w, h, S));
        const pre = preCache.get(style);
        let toneUids = null, toneColors = null;
        if (S.mode === 'tones') { toneUids = toneSpread(cols, sheets); toneColors = toneUids.map(u => uidToIdx.get(u)).sort((a, b) => cols[a].lab[0] - cols[b].lab[0]); }
        const seg = E.segment(pre, cols, { mode: S.mode, k: S.k, deltaE: S.deltaE, assign: S.assign, unique: S.unique, merge: S.merge, minShare: S.minShare / 100, toneSpread: S.toneSpread, toneColors });
        let labels = E.clustersToLabels(seg.clusterIdx, seg.clusters);
        if (S.smoothR > 0) labels = E.modeFilter(labels, w, h, S.smoothR, cols.length);
        if (minPx > 1) labels = E.despeckle(labels, w, h, minPx, 2, cols.length, null);
        const counts = new Int32Array(cols.length + 1);
        for (let i = 0; i < n; i++) counts[labels[i] + 1]++;
        const order = cols.map((cc, i) => i).filter(i => counts[i + 1] > 0).sort((a, b) => counts[b + 1] - counts[a + 1]);
        if (S0.maxPieces > 0) labels = E.limitPieces(labels, w, h, order, S0.layerMode, S0.maxPieces, -1);
        // metrics
        let err = 0, cnt = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        for (let i = 0; i < n; i++) {
          const L = labels[i]; if (L < 0) continue;
          const pl = cols[L].lab;
          err += Math.hypot(baseLab[i * 3] - pl[0], baseLab[i * 3 + 1] - pl[1], baseLab[i * 3 + 2] - pl[2]); cnt++;
          const x = baseLab[i * 3], y = pl[0]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        }
        const fidelity = cnt ? err / cnt : 0;
        // structure: how well the sheets' lightness tracks the photo's lightness (Pearson r)
        const den = Math.sqrt((cnt * sxx - sx * sx) * (cnt * syy - sy * sy));
        const structure = den > 0 ? Math.max(0, (cnt * sxy - sx * sy) / den) : 0;
        const bnd = E.dilate(E.labelBoundaries(labels, w, h), w, h, 1);
        let hit = 0; for (let i = 0; i < n; i++) if (edges[i] && bnd[i]) hit++;
        const detail = hit / edgeCount;
        let pieces = 0;
        const used = cols.map((cc, i) => i).filter(i => counts[i + 1] > 0);
        const layers = E.buildLayers(labels, w, h, order, S0.layerMode, {});
        for (const L of layers) { const cc = E.components(L.mask, w, h, true); for (let k = 0; k < cc.count; k++) if (cc.label[k] === 1 && cc.sizes[k] >= 4) pieces++; }
        const tc = document.createElement('canvas'); tc.width = w; tc.height = h;
        const id = tc.getContext('2d').createImageData(w, h); const d = id.data;
        for (let i = 0; i < n; i++) { const L = labels[i]; if (L < 0) continue; const q = E.hexToRgb(cols[L].hex); d[i * 4] = q[0]; d[i * 4 + 1] = q[1]; d[i * 4 + 2] = q[2]; d[i * 4 + 3] = 255; }
        tc.getContext('2d').putImageData(id, 0, 0);
        cells.push({ sheets, style, settings: Object.assign({}, style.set, { k: sheets }), toneUids, fidelity, detail, structure, pieces, sheetsUsed: used.length, thumb: tc.toDataURL('image/png') });
      }
    }
    return cells;
  }
  // Quality first: detail kept and color truth dominate; piece count only breaks ties.
  function scoreCells(cells) {
    cells.forEach(cl => { cl.score = cl.structure * 100 + cl.detail * 50 - cl.fidelity * 1.0 - cl.pieces * 0.3; });
    const ranked = cells.slice().sort((a, b) => b.score - a.score);
    ranked.forEach((cl, i) => { cl.rank = i + 1; });
    return cells;
  }

  function applyCell(cell) {
    Object.assign(state.settings, cell.settings);
    state.toneUse = cell.toneUids ? new Set(cell.toneUids) : null;
    state.order = []; state.clusterMap = {};
    settingsToControls(); renderToneList(); schedule();
    $('exploreModal').hidden = true;
    state.lookPick = { style: cell.style.name, sheets: cell.sheets };
    toast(`${cell.style.name}, ${cell.sheets} sheets.`);
    renderLookRowMarks();
  }

  /* ---- step 3: one look, eight sheet counts */
  let lookRun = 0;
  function currentLook() { const r = document.querySelector('input[name="look"]:checked'); return LOOKS[r ? r.value : 'true']; }
  function renderLookRow() {
    const row = $('lookRow'); row.innerHTML = '';
    if (!state.image) { row.appendChild(mk('div', 'note', 'Load a photo first.')); return; }
    if (activeColors().length < 2) { row.appendChild(mk('div', 'note', 'Turn on at least two papers in step 1.')); return; }
    const look = currentLook();
    const run = ++lookRun;
    const els = new Map();
    SHEET_COUNTS.forEach(sh => { const el = mk('button', 'look-cell'); el.appendChild(mk('div', 'm', sh + ' sheets')); row.appendChild(el); els.set(sh, el); });
    $('lookNote').textContent = 'working…';
    const all = []; let i = 0;
    const step = () => {
      if (run !== lookRun) return;
      if (i >= SHEET_COUNTS.length) {
        scoreCells(all);
        const best = all.slice().sort((a, b) => b.score - a.score)[0];
        all.forEach(c => { if (c === best) els.get(c.sheets).classList.add('best'); });
        $('lookNote').textContent = `recommended: ${best.sheets} sheets`;
        if (!state.lookPick || state.lookPick.style !== look.name) applyCell(best);
        renderLookRowMarks();
        return;
      }
      const sh = SHEET_COUNTS[i++];
      const cell = exploreCells([sh], [{ name: look.name, set: look.set }])[0];
      all.push(cell);
      const el = els.get(sh); el.innerHTML = '';
      const im = document.createElement('img'); im.src = cell.thumb; im.alt = ''; el.appendChild(im);
      el.appendChild(mk('div', 'm', `${sh} sheets · ${cell.pieces} pc`));
      el.dataset.sheets = sh;
      el.onclick = () => applyCell(cell);
      setTimeout(step, 10);
    };
    setTimeout(step, 20);
  }
  function renderLookRowMarks() {
    $$('#lookRow .look-cell').forEach(el => el.classList.toggle('selected', !!state.lookPick && Number(el.dataset.sheets) === state.lookPick.sheets));
  }

  /* ---- step navigation */
  function goStep(n) {
    state.step = n;
    $$('.step').forEach(el => { el.hidden = Number(el.dataset.step) !== n; });
    $$('#stepBar .stepbtn').forEach(b => { const k = Number(b.dataset.step); b.classList.toggle('active', k === n); b.classList.toggle('done', k < n); });
    const view = n <= 2 ? 'original' : n === 5 ? 'cuts' : 'mapped';
    if (!(n === 2 && state.result && state.view !== 'original')) setView(view);
    if (n === 3) renderLookRow();
    if (n === 5) renderCutSheet();
    try { localStorage.setItem('cls-step', String(n)); } catch (e) { }
    document.querySelector('.steps-panel').scrollIntoView({ block: 'nearest' });
  }
  function setView(v) { state.view = v; $$('#viewTabs .btn').forEach(x => x.classList.toggle('active', x.dataset.view === v)); renderStage(); renderStatus(); }

  let exploreRun = 0;
  function openExplorer() {
    if (!state.image) { toast('Load an image first'); return; }
    const modal = $('exploreModal'), grid = $('exploreGrid'), prog = $('exploreProgress');
    modal.hidden = false; grid.innerHTML = '';
    if (activeColors().length < 2) { grid.appendChild(mk('div', 'note', 'Turn on at least two papers first.')); return; }
    const run = ++exploreRun;
    grid.appendChild(mk('div', 'ex-head', ''));
    STYLES.forEach(st => { const hd = mk('div', 'ex-head', st.name); hd.appendChild(mk('span', '', st.desc)); grid.appendChild(hd); });
    const cellEls = new Map();
    SHEET_COUNTS.forEach(sheets => {
      grid.appendChild(mk('div', 'ex-row', sheets + ' sh'));
      STYLES.forEach(st => { const el = mk('button', 'ex-cell'); el.appendChild(mk('div', 'm', '…')); grid.appendChild(el); cellEls.set(sheets + '/' + st.name, el); });
    });
    const all = [];
    let i = 0;
    prog.textContent = 'Working through 64 setups…';
    const step = () => {
      if (run !== exploreRun) return;
      if (i >= SHEET_COUNTS.length) {
        scoreCells(all);
        all.forEach(cell => {
          const el = cellEls.get(cell.sheets + '/' + cell.style.name);
          if (cell.rank <= 3) { el.classList.add('best'); el.appendChild(mk('div', 'rk', '#' + cell.rank)); }
        });
        prog.textContent = '64 setups scored. Outlined tiles are the top three overall.';
        return;
      }
      const sheets = SHEET_COUNTS[i++];
      const cells = exploreCells([sheets]);
      for (const cell of cells) {
        all.push(cell);
        const el = cellEls.get(cell.sheets + '/' + cell.style.name);
        el.innerHTML = '';
        const im = document.createElement('img'); im.src = cell.thumb; im.alt = ''; el.appendChild(im);
        el.appendChild(mk('div', 'm', `ΔE ${cell.fidelity.toFixed(0)} · ${Math.round(cell.structure * 100)}% · ${cell.pieces} pc`));
        el.title = `${cell.style.name}, ${cell.sheets} sheets (${cell.sheetsUsed} used). Color error ${cell.fidelity.toFixed(1)}, structure ${Math.round(cell.structure * 100)}%, detail ${Math.round(cell.detail * 100)}%, ${cell.pieces} pieces.`;
        el.onclick = () => applyCell(cell);
      }
      prog.textContent = `Working through 64 setups… ${all.length} done`;
      setTimeout(step, 10);
    };
    setTimeout(step, 20);
  }

  /* ------------------------------------------------------ interaction */
  function canvasPoint(ev) {
    const cv = $('stageCanvas'); const r = cv.getBoundingClientRect();
    return { x: Math.floor((ev.clientX - r.left) * cv.width / r.width), y: Math.floor((ev.clientY - r.top) * cv.height / r.height) };
  }
  function pushUndo() { state.undo.push(Int32Array.from(state.overrides)); if (state.undo.length > 12) state.undo.shift(); }
  function stamp(x, y) {
    const { w, h } = state.work; const r = state.brush / 2; const val = state.tool === 'erase' ? 0 : (state.paintUid == null ? 0 : state.paintUid);
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(w - 1, Math.ceil(x + r)), y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(h - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) state.overrides[yy * w + xx] = val;
    // immediate feedback
    const ctx = $('stageCanvas').getContext('2d');
    const col = state.tool === 'erase' ? 'rgba(255,255,255,0.6)' : (state.paintUid === -1 ? 'rgba(0,0,0,0.4)' : (colorByUid(state.paintUid) || { hex: '#888' }).hex);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  function bindCanvas() {
    const cv = $('stageCanvas'); let painting = false;
    cv.addEventListener('pointerdown', ev => {
      if (!state.result || state.view === 'sheet' || state.view === 'cuts' || state.view === 'vector') return;
      const { x, y } = canvasPoint(ev); const { w, h } = state.work; if (x < 0 || y < 0 || x >= w || y >= h) return;
      const R = state.result;
      if (state.tool === 'pick') {
        const L = R.labels[y * w + x];
        if (L >= 0) { const uid = R.cols[L].uid; state.selectedLayer = state.selectedLayer === uid ? null : uid; state.paintUid = uid; renderPaintStrip(); renderLayerList(); renderStage(); toast(R.cols[L].name + ' · ' + R.cols[L].pack); }
        else { state.selectedLayer = null; renderLayerList(); renderStage(); }
        return;
      }
      if (state.tool === 'fill') {
        if (state.paintUid == null) return;
        const region = E.fillRegion(R.labels, w, h, x, y, -99);
        if (!region || !region.length) return;
        pushUndo(); const val = state.paintUid;
        for (const i of region) state.overrides[i] = val;
        schedule(); return;
      }
      painting = true; cv.setPointerCapture(ev.pointerId); pushUndo(); stamp(x, y);
    });
    cv.addEventListener('pointermove', ev => { if (!painting) return; const { x, y } = canvasPoint(ev); stamp(x, y); });
    const stop = () => { if (!painting) return; painting = false; schedule(); };
    cv.addEventListener('pointerup', stop); cv.addEventListener('pointercancel', stop);

    // drag & drop / paste
    const wrap = $('canvasWrap');
    ['dragenter', 'dragover'].forEach(t => wrap.addEventListener(t, ev => { ev.preventDefault(); $('dropHint').hidden = false; }));
    ['dragleave', 'drop'].forEach(t => wrap.addEventListener(t, ev => { ev.preventDefault(); $('dropHint').hidden = true; }));
    wrap.addEventListener('drop', ev => { const f = ev.dataTransfer.files && ev.dataTransfer.files[0]; if (f) loadImageFile(f); });
    document.addEventListener('paste', ev => { const it = Array.from(ev.clipboardData.items || []).find(i => i.type.startsWith('image/')); if (it) loadImageFile(it.getAsFile()); });
  }
  async function loadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) { toast('That is not an image file'); return; }
    try { const src = await readFileAsDataURL(file); await setImageFromSrc(src, file.name); state.lookPick = null; goStep(3); } catch (e) { toast(e.message); }
  }

  /* --------------------------------------------------------- controls */
  const rangeIds = ['brightness', 'contrast', 'saturation', 'blur', 'localContrast', 'edgeSmooth', 'k', 'merge', 'minShare', 'edgeSens', 'edgeWidth', 'minPiece', 'smoothR', 'tol', 'round', 'minFeature', 'maxPieces', 'underlap', 'backingOffset', 'marginIn'];
  const selectIds = ['mode', 'deltaE', 'assign', 'toneSpread', 'edgeSource', 'layerMode', 'autoOrder', 'workRes'];
  const checkIds = ['unique', 'edgeOn', 'backingOn', 'regMarks', 'autoLevels', 'curves'];
  const numberIds = ['widthIn', 'matW', 'matH', 'ptcW', 'ptcH'];

  function settingsToControls() {
    const S = state.settings;
    rangeIds.concat(numberIds).forEach(id => { $(id).value = S[id]; });
    selectIds.forEach(id => { $(id).value = String(S[id]); });
    checkIds.forEach(id => { $(id).checked = !!S[id]; });
    if (S.edgeColor) $('edgeColor').value = String(S.edgeColor);
    if (S.backingColor) $('backingColor').value = String(S.backingColor);
    $$('[data-val]').forEach(sp => { sp.textContent = $(sp.dataset.val).value; });
    syncVisibility();
  }
  function syncVisibility() {
    const S = state.settings;
    $('kRow').hidden = S.mode !== 'cluster'; $('uniqueRow').hidden = S.mode !== 'cluster'; $('toneRow').hidden = S.mode !== 'tones';
    $('underlapRow').hidden = S.layerMode !== 'inlay'; $('backingRow').hidden = !S.backingOn; $('marginRow').hidden = !S.regMarks; $('edgeRow').hidden = !S.edgeOn;
  }
  function bindControls() {
    const S = state.settings;
    rangeIds.forEach(id => $(id).addEventListener('input', () => { S[id] = Number($(id).value); const sp = document.querySelector(`[data-val="${id}"]`); if (sp) sp.textContent = $(id).value; schedule(); renderTags(); }));
    numberIds.forEach(id => $(id).addEventListener('change', () => { S[id] = Number($(id).value) || S[id]; renderFit(); schedule(); }));
    selectIds.forEach(id => $(id).addEventListener('change', () => {
      S[id] = id === 'k' || id === 'workRes' ? Number($(id).value) : $(id).value;
      if (id === 'workRes') { const keep = state.overrides && state.undo.length; rebuildWork(); if (keep) toast('Working resolution changed: manual edits were reset'); }
      syncVisibility(); schedule();
    }));
    checkIds.forEach(id => $(id).addEventListener('change', () => { S[id] = $(id).checked; syncVisibility(); schedule(); }));
    $('edgeColor').addEventListener('change', () => { S.edgeColor = Number($('edgeColor').value); schedule(); });
    $('backingColor').addEventListener('change', () => { S.backingColor = Number($('backingColor').value); schedule(); });
    $('btnAutoOrder').addEventListener('click', () => { state.order = []; schedule(); });

    $('fileImage').addEventListener('change', ev => { const f = ev.target.files[0]; if (f) loadImageFile(f); ev.target.value = ''; });
    $('btnExplore').addEventListener('click', openExplorer);
    $('btnExploreClose').addEventListener('click', () => { $('exploreModal').hidden = true; });
    $('btnExploreRerun').addEventListener('click', openExplorer);

    $$('#viewTabs .btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    $$('[data-go]').forEach(b => b.addEventListener('click', () => goStep(Number(b.dataset.go))));
    $$('#stepBar .stepbtn').forEach(b => b.addEventListener('click', () => goStep(Number(b.dataset.step))));
    $$('input[name="look"]').forEach(r => r.addEventListener('change', () => { state.lookPick = null; renderLookRow(); }));
    $$('#toolGroup .btn').forEach(b => b.addEventListener('click', () => { state.tool = b.dataset.tool; $$('#toolGroup .btn').forEach(x => x.classList.toggle('active', x === b)); renderStage(); }));
    $('brushSize').addEventListener('input', () => { state.brush = Number($('brushSize').value); $('brushSizeVal').textContent = state.brush; });
    $('btnUndo').addEventListener('click', () => { const u = state.undo.pop(); if (!u) { toast('Nothing to undo'); return; } state.overrides = u; schedule(); });
    $('btnClearEdits').addEventListener('click', () => { if (!state.overrides) return; pushUndo(); state.overrides.fill(0); state.clusterMap = {}; schedule(); });
    $('stackSlider').addEventListener('input', () => { state.stackN = Number($('stackSlider').value); renderStage(); });

    // palette panel
    $('btnAddPack').addEventListener('click', () => { state.packs.push({ id: 'pack-' + newUid(), name: 'New pack', finish: 'smooth', weight: '', material: 'Medium Cardstock - 80 lb', sheetW: 8.5, sheetH: 11, colors: [] }); afterPaletteChange(); });
    $('btnResetPal').addEventListener('click', armed($('btnResetPal'), () => { installPacks(P.DEFAULT_PACKS); state.order = []; state.excluded.clear(); state.clusterMap = {}; state.toneUse = null; afterPaletteChange(); }));
    $('btnExportPal').addEventListener('click', () => {
      const data = JSON.stringify({ packs: state.packs.map(p => ({ id: p.id, name: p.name, finish: p.finish, weight: p.weight, material: p.material, sheetW: p.sheetW, sheetH: p.sheetH, colors: p.colors.map(c => ({ id: c.id, name: c.name, hex: c.hex, on: c.on })) })) }, null, 2);
      saveFile('paper-palette.json', data);
    });
    $('btnImportPal').addEventListener('click', () => $('fileImportPal').click());
    $('fileImportPal').addEventListener('change', async ev => {
      const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
      try { const j = JSON.parse(await f.text()); const packs = j.packs || j; if (!Array.isArray(packs)) throw new Error('Expected {packs:[…]}'); installPacks(packs); state.order = []; state.clusterMap = {}; afterPaletteChange(); toast('Palette imported'); }
      catch (e) { toast('Import failed: ' + e.message, 5000); }
    });

    // sampling modal
    $('btnSample').addEventListener('click', () => { $('sampleModal').hidden = false; $('sampledList').innerHTML = ''; });
    $('btnSampleDone').addEventListener('click', () => { $('sampleModal').hidden = true; afterPaletteChange(); });
    $('sampleFile').addEventListener('change', async ev => {
      const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
      const im = await loadImageEl(await readFileAsDataURL(f));
      const cv = $('sampleCanvas'); const sc = Math.min(1, 860 / im.naturalWidth); cv.width = Math.round(im.naturalWidth * sc); cv.height = Math.round(im.naturalHeight * sc);
      cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    });
    $('sampleCanvas').addEventListener('click', ev => {
      const cv = $('sampleCanvas'); if (cv.width < 20) return;
      const r = cv.getBoundingClientRect(); const x = Math.floor((ev.clientX - r.left) * cv.width / r.width), y = Math.floor((ev.clientY - r.top) * cv.height / r.height);
      const p = Number($('samplePatch').value), half = (p - 1) / 2;
      const x0 = Math.max(0, x - half), y0 = Math.max(0, y - half);
      const d = cv.getContext('2d').getImageData(x0, y0, Math.min(p, cv.width - x0), Math.min(p, cv.height - y0)).data;
      let rs = 0, gs = 0, bs = 0, c = 0;
      for (let i = 0; i < d.length; i += 4) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; c++; }
      const hex = E.rgbToHex(rs / c, gs / c, bs / c);
      const pack = state.packs.find(pk => pk.id === $('samplePack').value) || state.packs[0];
      if (!pack) { toast('Add a pack first'); return; }
      const col = { uid: newUid(), id: 'c' + newUid(), name: 'Sample ' + (pack.colors.length + 1), hex, on: true };
      pack.colors.push(col);
      const sw = mk('span', 'sw'); sw.style.background = hex; sw.title = hex; $('sampledList').appendChild(sw);
      renderPacks();
    });

    // export
    $('btnProject').addEventListener('click', () => saveFile(baseName() + '-project.json', projectJson()));
    exportPanel = ExportPanel.mount($('exportPanel'), exportProvider());
    $('btnCopySheet').addEventListener('click', async () => {
      const t = $('cutSheet').value;
      try { await navigator.clipboard.writeText(t); toast('Cut sheet copied'); }
      catch (e) { $('cutSheet').select(); toast('Select-all and copy from the box'); }
    });
  }

  /* ------------------------------------------------------------- boot */
  function setTopbarVar() { document.documentElement.style.setProperty('--topbar-h', document.querySelector('.topbar').offsetHeight + 'px'); }
  function boot() {
    setTopbarVar(); window.addEventListener('resize', setTopbarVar);
    installPacks(P.DEFAULT_PACKS);
    renderPacks(); renderDependents(); settingsToControls(); bindControls(); bindCanvas();
    renderStatus(); renderFit();
    goStep(1);
    renderExamples();
    if (location.protocol === 'file:') loadSampleImage(); else loadExample(EXAMPLES[0]);
  }
  // Scripting hook (used by the test harness; harmless otherwise).
  window.CutStudio = {
    state, loadImage: setImageFromSrc, loadExample, EXAMPLES, run: runPipeline, suggestions, cutSheetText, buildCombinedSvg, buildLayerSet, settingsToControls,
    setView(v) { state.view = v; if (v === 'layers' && state.result) state.stackN = state.result.layers.length; renderStage(); },
    canvas: () => $('stageCanvas'), exploreCells: () => scoreCells(exploreCells()), STYLES, SHEET_COUNTS, LOOKS, drawSheet, goStep, applyCell, setView,
    lookCells: (look) => scoreCells(exploreCells(null, [{ name: LOOKS[look].name, set: LOOKS[look].set }]))
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
