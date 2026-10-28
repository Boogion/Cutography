/* fab-ui.js — the fabrication setup panel shared by the photo and map tools.

   FabSetup.mount(container, recipe, {onChange, fieldLabel, noImage}) draws the controls for the recipe's mode
   (process, materials, limits, levels or structures), shows what the written shapes become and any
   problems, and calls onChange(recipe) after each edit. The recipe object is edited in place. */
(function (root) {
  'use strict';
  const F = root.CutFab;
  const STYLE = `
.fab { display: grid; gap: 10px; }
.fab-procs { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px; }
.fab-proc { position: relative; display: grid; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel-2); font-size: 12px; cursor: pointer; }
.fab-proc b { font-size: 13px; }
.fab-proc.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.fab-proc.off { opacity: .45; }
.fab-proc input { position: absolute; opacity: 0; pointer-events: none; }
.fab-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 140px); gap: 6px 10px; align-items: center; font-size: 12.5px; }
.fab-grid label { color: var(--muted); }
.fab-grid input, .fab-grid select { background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 4px; padding: 3px 6px; width: 100%; font: inherit; color: var(--ink); }
.fab-pair { display: flex; gap: 4px; align-items: center; }
.fab-pair input { min-width: 0; }
.fab-meaning { font-size: 12.5px; padding: 8px 10px; border-left: 3px solid var(--accent); background: var(--panel-2); border-radius: 0 4px 4px 0; }
.fab-msgs { display: grid; gap: 4px; font-size: 12.5px; }
.fab-msgs .err { color: var(--bad); } .fab-msgs .warn { color: var(--warn); }
.fab details { font-size: 12.5px; }
.fab textarea { width: 100%; min-height: 70px; font-family: var(--font-mono); font-size: 11px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 6px; }
.fab-mode { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 13px; }
.fab-mode b { font-family: var(--font-display); font-size: 15px; }`;

  function el(tag, attrs, text) { const e = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; }

  function mount(container, r, opts) {
    opts = opts || {};
    if (!document.getElementById('fab-style')) { const s = el('style', { id: 'fab-style' }); s.textContent = STYLE; document.head.appendChild(s); }
    let timer = 0;
    const changed = (now) => { draw(); clearTimeout(timer); timer = setTimeout(() => opts.onChange && opts.onChange(r), now ? 0 : 250); };

    function num(label, key, min, max, step, unit, help) {
      const lab = el('label', null, label), inp = el('input', { type: 'number', min, max, step, value: r[key] });
      if (help) lab.title = help;
      inp.addEventListener('change', () => { const v = Number(inp.value); if (isFinite(v)) { r[key] = v; changed(); } });
      const pair = el('div', { class: 'fab-pair' }); pair.append(inp, el('span', { class: 'muted small' }, unit || ''));
      return [lab, pair];
    }
    function sel(label, key, options, toValue) {
      const lab = el('label', null, label), s = el('select');
      for (const [v, t] of options) { const o = el('option', { value: v }, t); if (String(r[key]) === String(v)) o.selected = true; s.appendChild(o); }
      s.addEventListener('change', () => { r[key] = toValue ? toValue(s.value) : s.value; changed(true); });
      return [lab, s];
    }

    function draw() {
      container.innerHTML = '';
      const wrap = el('div', { class: 'fab' }), chk = F.check(r), d = chk.derived, M = F.MODES[r.mode];
      const head = el('div', { class: 'fab-mode' });
      head.append(el('b', null, M.name), el('span', { class: 'muted' }, M.note));
      const change = el('a', { href: 'index.html', class: 'small' }, 'change'); head.append(change);
      wrap.appendChild(head);
      if (!M.lithography) { container.appendChild(wrap); return; }
      if (r.mode === 'layers') {   // plain layers: just true size and the limits used for cleanup
        const g0 = el('div', { class: 'fab-grid' });
        [num('Smallest feature', 'minFeatureNm', 10, 100000, 10, 'nm'), num('Smallest gap', 'minGapNm', 10, 100000, 10, 'nm'), num('Writing grid', 'gridNm', 1, 1000, 1, 'nm'), fieldInput()].forEach(p => g0.append(p[0], p[1]));
        wrap.appendChild(g0);
        container.appendChild(wrap);
        return;
      }

      // process cards: the processes that can't do this mode are shown but greyed out, with the reason
      const procs = el('div', { class: 'fab-procs', role: 'radiogroup', 'aria-label': 'Process' });
      for (const [id, p] of Object.entries(F.PROCESSES)) {
        const usable = r.mode !== 'grayscale' || p.grayscale;
        const card = el('label', { class: 'fab-proc' + (r.process === id ? ' on' : '') + (usable ? '' : ' off'), title: usable ? p.note : 'Not possible for grayscale relief: ' + p.note });
        const radio = el('input', { type: 'radio', name: 'fabproc', value: id }); radio.checked = r.process === id; radio.disabled = !usable;
        radio.addEventListener('change', () => {
          r.process = id;
          if (r.mode === 'color' && p.families.indexOf(r.family) < 0) { r.family = p.families[0]; r.structureHeightNm = F.FAMILIES[r.family].height || r.structureHeightNm; }
          changed(true);
        });
        card.append(radio, el('b', null, p.name), el('span', { class: 'muted' }, p.note));
        procs.appendChild(card);
      }
      wrap.appendChild(procs);

      const g = el('div', { class: 'fab-grid' });
      const add = pair => g.append(pair[0], pair[1]);
      // switching structure family also sets that family's typical height (metal disks are thin, pillars tall)
      if (r.mode === 'color') add(sel('Structure', 'family', F.PROCESSES[r.process].families.map(f => [f, F.FAMILIES[f].name]), f => { r.structureHeightNm = F.FAMILIES[f].height || r.structureHeightNm; return f; }));
      add(sel('Resist', 'resist', Object.entries(F.RESISTS).map(([k, v]) => [k, `${k} (${v.tone})`])));
      add(sel('Substrate', 'substrate', Object.keys(F.SUBSTRATES).map(k => [k, k.replace('SiO2', 'SiO₂')])));
      if (r.process === 'liftoff') add(sel('Metal', 'metal', F.METALS.map(m => [m, m])));
      add(num('Smallest feature', 'minFeatureNm', 10, 10000, 10, 'nm'));
      add(num('Smallest gap', 'minGapNm', 10, 10000, 10, 'nm'));
      const isGray = r.mode === 'grayscale' || (r.mode === 'color' && !F.FAMILIES[r.family].binary);
      if (isGray) {
        add(num('Lowest level', 'depthMinNm', 10, 500, 5, 'nm', 'Heights or depths below 10 nm are unreliable'));
        add(num('Tallest level', 'depthMaxNm', 10, 500, 5, 'nm', 'Up to 500 nm'));
        add(sel('Levels', 'levels', [[8, '8'], [16, '16']], Number));
        add(num('Smallest step between levels', 'minStepNm', 1, 100, 1, 'nm'));
        add(num('Resist thickness', 'resistThicknessNm', 10, 5000, 10, 'nm'));
        if (r.process === 'etch') add(num('Etch selectivity (substrate : resist)', 'selectivity', 0.1, 50, 0.1, '×'));
        if (r.mode === 'grayscale' && !opts.noImage) add(sel('Bright parts of the image', 'brightIsTall', [['true', 'are tall'], ['false', 'are low']], v => v === 'true'));
      }
      if (r.mode === 'color' && F.FAMILIES[r.family].binary) {
        add(num(/disk/.test(r.family) ? 'Metal thickness' : /grating/.test(r.family) ? 'Grating depth' : 'Pillar height', 'structureHeightNm', 10, 500, 5, 'nm', '10–500 nm'));
        if (/pillar|disk/.test(r.family)) { add(sel('Lattice', 'lattice', [['square', 'square'], ['hex', 'hexagonal']])); add(num('Largest aspect ratio (height ÷ width)', 'maxAspect', 1, 20, 0.5, '')); }
        if (r.family === 'grating') add(num('Line fraction (duty)', 'duty', 0.2, 0.8, 0.05, ''));
        if (r.process === 'liftoff' || r.process === 'tio2') add(num('Resist thickness', 'resistThicknessNm', 10, 5000, 10, 'nm'));
      }
      if (r.mode === 'color' && /grating|blazed/.test(r.family)) add(num('Viewing angle (from the surface)', 'viewElevDeg', 5, 85, 1, '°', 'Colors are calculated for white light from straight above, seen at this angle'));
      add(num('Writing grid', 'gridNm', 1, 1000, 1, 'nm'));
      if (opts.fieldLabel !== false) add(fieldInput());
      wrap.appendChild(g);

      // what the written shapes become
      wrap.appendChild(el('div', { class: 'fab-meaning' }, d.what));
      if (r.mode === 'color' && F.FAMILIES[r.family]) wrap.appendChild(el('div', { class: 'note' }, F.FAMILIES[r.family].note + (/pillar|disk/.test(r.family) && !(r.library && r.library.length) ? ' Colors shown are estimates until you load a measured library.' : '')));

      // problems
      if (chk.errors.length || chk.warnings.length) {
        const msgs = el('div', { class: 'fab-msgs', role: 'status' });
        chk.errors.forEach(e => msgs.appendChild(el('div', { class: 'err' }, '✕ ' + e)));
        chk.warnings.forEach(w => msgs.appendChild(el('div', { class: 'warn' }, '! ' + w)));
        wrap.appendChild(msgs);
      }

      // expert inputs: contrast curve and measured library
      if (isGray) wrap.appendChild(contrastBox());
      if (r.mode === 'color') wrap.appendChild(libraryBox());
      container.appendChild(wrap);
    }

    function fieldInput() {
      const lab = el('label', null, opts.fieldLabel || 'Field width');
      const pair = el('div', { class: 'fab-pair' });
      const big = r.fieldUm >= 1000;
      const inp = el('input', { type: 'number', min: big ? 0.1 : 100, max: big ? 100 : 100000, step: big ? 0.1 : 10, value: big ? +(r.fieldUm / 1000).toFixed(3) : Math.round(r.fieldUm) });
      const unit = el('select'); [['um', 'µm'], ['mm', 'mm']].forEach(([v, t]) => { const o = el('option', { value: v }, t); if ((v === 'mm') === big) o.selected = true; unit.appendChild(o); });
      const apply = () => { const v = Number(inp.value); if (v > 0) { r.fieldUm = unit.value === 'mm' ? v * 1000 : v; changed(); } };
      inp.addEventListener('change', apply);
      unit.addEventListener('change', () => { inp.value = unit.value === 'mm' ? +(r.fieldUm / 1000).toFixed(3) : Math.round(r.fieldUm); });
      pair.append(inp, unit);
      return [lab, pair];
    }
    function contrastBox() {
      const det = el('details'), sum = el('summary', null, r.contrast ? `Contrast curve loaded (${r.contrast.length} points)` : 'Contrast curve (optional: replaces the straight-line dose placeholder)');
      const ta = el('textarea', { placeholder: 'relative dose, remaining thickness fraction\n0.2, 1.00\n0.5, 0.80\n0.8, 0.35\n1.0, 0.00' });
      if (r.contrast) ta.value = r.contrast.map(p => p.join(', ')).join('\n');
      const btns = el('div', { class: 'btns' }), use = el('button', { class: 'btn sm', type: 'button' }, 'Use this curve'), clr = el('button', { class: 'btn sm', type: 'button' }, 'Clear');
      const msg = el('span', { class: 'note' });
      use.onclick = () => { try { r.contrast = F.parseContrast(ta.value); changed(true); } catch (e) { msg.textContent = e.message; msg.className = 'note bad'; } };
      clr.onclick = () => { r.contrast = null; changed(true); };
      btns.append(use, clr, msg);
      det.append(sum, ta, btns);
      return det;
    }
    function libraryBox() {
      const det = el('details'), has = r.library && r.library.length;
      det.appendChild(el('summary', null, has ? `Measured library loaded (${r.library.length} structures)` : 'Measured structure library (optional: replaces estimated colors)'));
      det.appendChild(el('p', { class: 'note' }, 'A CSV from your own test patterns, one structure per row: name, family, period_nm, diameter_nm, pitch_nm, height_nm, angle_deg, duty, hex. Rows whose family matches the chosen structure become the palette.'));
      const btns = el('div', { class: 'btns' }), file = el('input', { type: 'file', accept: '.csv,text/csv' }), clr = el('button', { class: 'btn sm', type: 'button' }, 'Clear'), sample = el('button', { class: 'btn sm', type: 'button' }, 'Example CSV');
      const msg = el('span', { class: 'note' });
      file.onchange = async () => {
        const f = file.files[0]; if (!f) return;
        try { r.library = root.CutOptics.parseLibraryCsv(await f.text()); changed(true); }
        catch (e) { msg.textContent = e.message; msg.className = 'note bad'; }
      };
      clr.onclick = () => { r.library = null; changed(true); };
      sample.onclick = () => { const t = root.CutOptics.exampleLibraryCsv(), a = el('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'structure-library-example.csv'; a.click(); };
      btns.append(file, clr, sample, msg);
      det.appendChild(btns);
      return det;
    }

    draw();
    return { redraw: draw, recipe: r };
  }

  /* The mode a page starts in: ?mode= in the URL, else the last one used, else paper. */
  function startMode() {
    const q = new URLSearchParams(location.search).get('mode');
    if (q && F.MODES[q]) { try { localStorage.setItem('cutography.mode', q); } catch (e) { /* private mode */ } return q; }
    try { const s = localStorage.getItem('cutography.mode'); if (s && F.MODES[s]) return s; } catch (e) { /* private mode */ }
    return 'paper';
  }
  // The recipe is remembered per mode, so switching tools keeps the process you set up.
  function loadRecipe(mode) {
    const r = F.defaultRecipe(mode);
    try { const s = JSON.parse(localStorage.getItem('cutography.recipe.' + mode) || 'null'); if (s) Object.assign(r, s, { mode }); } catch (e) { /* ignore */ }
    return r;
  }
  function saveRecipe(r) { try { const c = Object.assign({}, r); localStorage.setItem('cutography.recipe.' + r.mode, JSON.stringify(c)); } catch (e) { /* private mode */ } }

  root.FabSetup = { mount, startMode, loadRecipe, saveRecipe };
})(typeof self !== 'undefined' ? self : this);
