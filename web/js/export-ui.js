/* export-ui.js — the "Export" panel shared by the photo and map pages, plus file saving.

   ExportPanel.mount(container, provider) draws three cards (Cricut, KLayout, high-res images) and a
   "Save everything" button. The provider supplies the content:
     project()          short name used for file and folder names
     size()             {wIn, hIn, layers} or null when nothing is ready (cheap; drives the estimates)
     layerSet()         CutExport LayerSet (may be slow: it flattens every outline)
     cricutSvg()        the combined Design Space SVG
     cricutSvgLayers()  [{name, svg}] one SVG per layer (optional)
     notes()            [{path, text | data}] cut sheet, assembly notes... (optional; may be async)
     cricutNote         HTML string shown under the Cricut buttons (optional)
     toast(msg, ms)     the page's toast
   Call panel.refresh() whenever the layers change.

   Saving: when the page is served by the local app (python -m cutography), files are written to
   Documents/Cutography/output/<project>/ and the folder can be opened from the page.
   Opened straight from disk, single files download and sets of files download as a ZIP. */
(function (root) {
  'use strict';
  const X = root.CutExport;

  /* ------------------------------------------------------------ saving */
  const IO = {
    _server: null,
    hasServer() {
      if (!this._server) {
        this._server = /^https?:$/.test(location.protocol)
          ? fetch('api/health', { cache: 'no-store' }).then(r => r.ok).catch(() => false)
          : Promise.resolve(false);
      }
      return this._server;
    },
    download(filename, data) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    },
    async saveToFolder(project, path, data) {
      const r = await fetch(`api/save?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`, { method: 'POST', body: data instanceof Blob ? data : new Blob([data]) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `Could not save ${path} (HTTP ${r.status})`);
      return j.path;
    },
    async openFolder(project) {
      const r = await fetch(`api/open?project=${encodeURIComponent(project)}`, { method: 'POST' });
      if (!r.ok) throw new Error('Could not open the folder');
    }
  };
  root.CutographyIO = IO;

  const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layers';
  const pad2 = i => String(i + 1).padStart(2, '0');
  const fmt = (v, d) => Number(v).toFixed(d == null ? 2 : d);
  const mb = bytes => bytes >= 1e9 ? fmt(bytes / 1e9, 1) + ' GB' : bytes >= 1e6 ? fmt(bytes / 1e6, 1) + ' MB' : Math.max(1, Math.round(bytes / 1e3)) + ' KB';
  const el = (tag, attrs, html) => { const e = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html != null) e.innerHTML = html; return e; };

  const STYLE = `
.xp { display: grid; gap: 10px; }
.xp-card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px; display: grid; gap: 8px; }
.xp-card h3 { font-family: var(--font-display); font-size: 15px; display: flex; align-items: baseline; gap: 8px; }
.xp-card h3 span { font-family: var(--font-body); font-size: 12px; font-weight: 400; color: var(--muted); }
.xp-card .btn small { color: var(--muted); font-weight: 400; margin-left: auto; }
.xp-card .btn.primary small { color: var(--accent-ink); opacity: .85; }
.xp-grid { display: grid; gap: 6px; }
.xp-grid .btn { justify-content: flex-start; text-align: left; }
.xp-opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px 12px; font-size: 13px; }
.xp-opts label { display: flex; align-items: center; gap: 6px; }
.xp-opts select { background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 4px; padding: 3px 6px; }
.xp-opts input { accent-color: var(--accent); }
.xp-est { font-family: var(--font-mono); font-size: 12px; }
.xp-status { display: grid; gap: 6px; font-size: 13px; }
.xp-bar { height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; border: 1px solid var(--line); }
.xp-bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .15s; }
.xp-saved { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12.5px; }
.xp-saved code { font-family: var(--font-mono); font-size: 11.5px; overflow-wrap: anywhere; }
.xp-all { justify-content: center; }`;

  /* ------------------------------------------------------------ panel */
  function mount(container, P) {
    if (!document.getElementById('xp-style')) { const s = el('style', { id: 'xp-style' }); s.textContent = STYLE; document.head.appendChild(s); }
    container.innerHTML = '';
    const wrap = el('div', { class: 'xp' });
    wrap.innerHTML = `
      <section class="xp-card" data-card="cricut">
        <h3>Cricut <span>Design Space</span></h3>
        <div class="xp-grid">
          <button class="btn primary big" data-act="svg">Cricut file (.svg) <small>all layers · recommended</small></button>
          <button class="btn" data-act="svgLayers">One .svg per layer <small>same size, they line up</small></button>
          <button class="btn" data-act="pngLayers">One .png per layer <small>300 dpi, transparent</small></button>
          <button class="btn" data-act="ptc">Print Then Cut image (.png) <small>all colors flattened</small></button>
        </div>
        <div class="note" data-slot="cricutNote"></div>
      </section>
      <section class="xp-card" data-card="gds">
        <h3>KLayout <span>GDSII layout</span></h3>
        <div class="xp-grid">
          <button class="btn primary" data-act="gds">Layout file (.gds + layer colors .lyp)</button>
        </div>
        <div class="note" data-slot="gdsNote">True size, 1 nm grid. Layer 1 is the bottom sheet. In KLayout: <b>File → Open</b> the .gds, then <b>File → Load Layer Properties</b> and pick the .lyp to see paper names and colors.</div>
      </section>
      <section class="xp-card" data-card="images">
        <h3>High-res images <span>for print, film or analysis</span></h3>
        <div class="xp-opts">
          <label>Resolution <select data-opt="dpi"><option>300</option><option selected>600</option><option>1200</option><option>2400</option><option>4800</option></select> dpi</label>
          <label>Format <select data-opt="fmt"><option value="png">PNG</option><option value="tiff">TIFF</option><option value="bmp">BMP</option></select></label>
          <label><input type="checkbox" data-opt="masks" checked> Layer masks (1-bit)</label>
          <label><input type="checkbox" data-opt="color" checked> Color composite</label>
          <label><input type="checkbox" data-opt="label"> Label map (8-bit)</label>
          <label><input type="checkbox" data-opt="mirror"> Mirror</label>
          <label><input type="checkbox" data-opt="invert"> Invert masks</label>
          <label><input type="checkbox" data-opt="transparent"> Transparent background (PNG)</label>
        </div>
        <div class="xp-est" data-slot="est"></div>
        <div class="note">Masks are white where the layer has paper (black with <i>Invert</i>). In the label map each pixel holds the number of the top-most layer, 0 for none. A <code>scale.json</code> file records the pixel size and layer order. Mirror flips left-right, for printing film emulsion side down.</div>
        <div class="xp-grid"><button class="btn primary" data-act="images">Make images</button></div>
      </section>
      <button class="btn primary big xp-all" data-act="all">Save everything</button>
      <div class="xp-status" data-slot="status" hidden><div data-slot="msg"></div><div class="xp-bar"><i></i></div></div>
      <div class="xp-saved" data-slot="saved" hidden></div>`;
    container.appendChild(wrap);
    const $ = sel => wrap.querySelector(sel);
    const opt = name => { const e = $(`[data-opt="${name}"]`); return e.type === 'checkbox' ? e.checked : e.value; };
    if (P.cricutNote) $('[data-slot="cricutNote"]').innerHTML = P.cricutNote;
    if (!P.cricutSvgLayers) $('[data-act="svgLayers"]').hidden = true;

    let busy = false, server = false;
    IO.hasServer().then(s => {
      server = s;
      $('[data-act="all"]').textContent = s ? 'Save everything to the project folder' : 'Download everything (.zip)';
      $('[data-act="images"]').textContent = s ? 'Make images' : 'Make images (.zip)';
    });

    const status = (msg, frac) => {
      const box = $('[data-slot="status"]'); box.hidden = msg == null;
      if (msg != null) { $('[data-slot="msg"]').textContent = msg; $('.xp-bar i').style.width = Math.round((frac || 0) * 100) + '%'; }
    };
    const toast = (m, ms) => (P.toast ? P.toast(m, ms) : console.log(m));

    function estimate() {
      const s = P.size && P.size(), out = $('[data-slot="est"]');
      if (!s) { out.textContent = ''; return; }
      const dpi = Number(opt('dpi')), w = Math.round(s.wIn * dpi), h = Math.round(s.hIn * dpi), px = w * h;
      const n = (opt('masks') ? s.layers : 0) + (opt('color') ? 1 : 0) + (opt('label') ? 1 : 0);
      // compressed sizes vary with detail; these are generous guesses for flat cut art
      const bmp = opt('fmt') === 'bmp';   // BMP is uncompressed
      const per = (opt('masks') ? s.layers * px / 8 / (bmp ? 1 : 20) : 0) + (opt('color') ? px * (bmp ? 3 : opt('fmt') === 'png' ? 0.06 : 0.12) : 0) + (opt('label') ? px * (bmp ? 1 : 0.05) : 0);
      out.textContent = `${n} image${n === 1 ? '' : 's'} · ${w.toLocaleString()} × ${h.toLocaleString()} px (${fmt(s.wIn)} × ${fmt(s.hIn)} in) · about ${mb(per)}`;
      out.className = 'xp-est' + (px > 4e8 ? ' note bad' : px > 1.2e8 ? ' note warn' : '');
      if (px > 4e8) out.textContent += ' · very large: expect a long wait and a lot of memory';
    }
    wrap.querySelectorAll('[data-opt]').forEach(e => e.addEventListener('change', estimate));

    /* Output collector: with the local app, files go to the project folder; otherwise one file
       downloads directly and several are zipped. */
    function collector(zipName) {
      const files = [];
      return {
        add(path, data) { files.push({ path, data }); },
        async finish() {
          const project = slug(P.project());
          if (server) {
            let last = '';
            for (let i = 0; i < files.length; i++) { status(`Saving ${files[i].path}`, i / files.length); last = await IO.saveToFolder(project, files[i].path, files[i].data); }
            // the absolute path ends with the relative one (separators differ, lengths don't)
            showSaved(project, files.length, last.slice(0, last.length - files[files.length - 1].path.length - 1));
            return;
          }
          if (files.length === 1) { IO.download(files[0].path.split('/').pop(), files[0].data); toast('Downloaded ' + files[0].path.split('/').pop()); return; }
          if (typeof JSZip === 'undefined') { files.forEach(f => IO.download(f.path.split('/').pop(), f.data)); return; }
          status('Zipping…', 0.95);
          const zip = new JSZip(); files.forEach(f => zip.file(f.path, f.data));
          IO.download(`${project}-${zipName}.zip`, await zip.generateAsync({ type: 'blob' }));
          toast(`Downloaded ${files.length} files as a ZIP`);
        }
      };
    }
    function showSaved(project, n, folder) {
      const box = $('[data-slot="saved"]'); box.hidden = false; box.innerHTML = '';
      box.append(el('span', null, `Saved ${n} file${n === 1 ? '' : 's'} to`), el('code', null, ''));
      box.querySelector('code').textContent = folder || project;
      const b = el('button', { class: 'btn sm' }, 'Open folder');
      b.onclick = () => IO.openFolder(project).catch(e => toast(e.message));
      box.append(b);
      toast(`Saved ${n} file${n === 1 ? '' : 's'}`);
    }

    async function run(name, fn) {
      if (busy) return;
      if (!P.size || !P.size()) { toast('Nothing to export yet'); return; }
      busy = true; wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { await fn(); }
      catch (e) { console.error(e); toast('Export failed: ' + e.message, 6000); }
      finally { busy = false; status(null); wrap.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    }

    /* ---- producers: each adds files to a collector */
    const base = () => slug(P.project());
    function addSvg(out) { out.add(`cricut/${base()}-cricut.svg`, P.cricutSvg()); }
    function addSvgLayers(out) { P.cricutSvgLayers().forEach((L, i) => out.add(`cricut/layers/${pad2(i)}-${slug(L.name)}.svg`, L.svg)); }
    async function addPngLayers(out, set) {
      const f = X.frame(set, 300);
      for (let i = 0; i < set.layers.length; i++) {
        const L = set.layers[i];
        status(`Cricut PNG ${i + 1} of ${set.layers.length}: ${L.name}`, i / set.layers.length);
        out.add(`cricut/png/${pad2(i)}-${slug(L.name)}.png`, await X.png(X.maskRows(L.loops, f), { kind: 'index1', palette: [[255, 255, 255], X.hexRgb(L.hex)], transparent: [0], dpi: 300, text: { Title: L.name } }));
      }
    }
    async function addPtc(out, set) {
      status('Print Then Cut image', 0.5);
      const f = X.frame(set, 300);
      out.add(`cricut/${base()}-print-then-cut.png`, await X.png(X.labelRows(set, f), { kind: 'index8', palette: [[255, 255, 255]].concat(set.layers.map(L => X.hexRgb(L.hex))), transparent: [0], dpi: 300 }));
    }
    function addGds(out, set) {
      status('GDS layout', 0.5);
      const bytes = X.gds(set, { labels: true });
      out.add(`gds/${base()}.gds`, bytes);
      out.add(`gds/${base()}.lyp`, X.lyp(set));
      return bytes.stats;
    }
    async function addImages(out, set) {
      const dpi = Number(opt('dpi')), fmtName = opt('fmt'), mirror = opt('mirror'), invert = opt('invert'), transparent = opt('transparent');
      const f = X.frame(set, dpi, mirror), ext = { png: 'png', tiff: 'tif', bmp: 'bmp' }[fmtName], dir = `images/${dpi}dpi/`;
      const jobs = [];
      if (opt('masks')) set.layers.forEach((L, i) => jobs.push({ name: `${pad2(i)}-${slug(L.name)}-mask`, title: `mask ${i + 1}: ${L.name}`, layer: i, make: () => X.maskRows(L.loops, f, invert), png: { kind: 'gray1' }, tiff: { kind: 'bilevel' }, bmp: { kind: 'gray1' } }));
      if (opt('color')) jobs.push({ name: `${base()}-color`, title: 'color composite', make: () => transparent && fmtName === 'png' ? X.labelRows(set, f) : X.rgbRows(set, f, '#ffffff'),
        png: transparent ? { kind: 'index8', palette: [[255, 255, 255]].concat(set.layers.map(L => X.hexRgb(L.hex))), transparent: [0] } : { kind: 'rgb' }, tiff: { kind: 'rgb' }, bmp: { kind: 'rgb' } });
      if (opt('label')) jobs.push({ name: `${base()}-labels`, title: 'label map', make: () => X.labelRows(set, f), png: { kind: 'index8', palette: grayPalette() }, tiff: { kind: 'gray8' }, bmp: { kind: 'index8', palette: grayPalette() } });
      if (!jobs.length) throw new Error('Pick at least one kind of image');
      const files = set.layers.map(() => []);
      for (let k = 0; k < jobs.length; k++) {
        const J = jobs[k], label = `${dpi} dpi ${J.title} (${k + 1} of ${jobs.length})`;
        const onProgress = p => status(label, (k + p) / jobs.length);
        const rows = J.make(), desc = `${set.name}: ${J.title}, ${dpi} dpi`;
        const blob = fmtName === 'png' ? await X.png(rows, Object.assign({ dpi, onProgress, text: { Title: desc } }, J.png))
          : fmtName === 'bmp' ? await X.bmp(rows, Object.assign({ dpi, onProgress }, J.bmp))
          : await X.tiff(rows, Object.assign({ dpi, onProgress, description: desc }, J.tiff));
        const path = dir + J.name + '.' + ext;
        out.add(path, blob);
        if (J.layer != null) files[J.layer].push(path.slice(dir.length));
      }
      out.add(dir + 'scale.json', X.manifest(set, { frame: f, invert, files }));
    }
    const grayPalette = () => Array.from({ length: 256 }, (_, i) => [i, i, i]);
    const getSet = () => { status('Preparing outlines…', 0.02); return P.layerSet(); };

    const actions = {
      svg: () => run('svg', async () => { const o = collector('cricut'); addSvg(o); await o.finish(); }),
      svgLayers: () => run('svgLayers', async () => { const o = collector('cricut-layers'); addSvgLayers(o); await o.finish(); }),
      pngLayers: () => run('pngLayers', async () => { const o = collector('cricut-png'); await addPngLayers(o, getSet()); await o.finish(); }),
      ptc: () => run('ptc', async () => { const o = collector('print-then-cut'); await addPtc(o, getSet()); await o.finish(); }),
      gds: () => run('gds', async () => { const o = collector('gds'); addGds(o, getSet()); await o.finish(); }),
      images: () => run('images', async () => { const o = collector('images'); await addImages(o, getSet()); await o.finish(); }),
      all: () => run('all', async () => {
        const o = collector('all'), set = getSet();
        addSvg(o); if (P.cricutSvgLayers) addSvgLayers(o);
        await addPngLayers(o, set); await addPtc(o, set); addGds(o, set); await addImages(o, set);
        for (const n of (P.notes ? await P.notes() : [])) o.add(n.path, n.text != null ? n.text : n.data);
        await o.finish();
        if (server) IO.openFolder(slug(P.project())).catch(() => {});
      })
    };
    wrap.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => actions[b.dataset.act]()));

    const panel = {
      refresh() {
        estimate();
        const s = P.size && P.size();
        $('[data-act="pngLayers"] small').textContent = s ? `${s.layers} file${s.layers === 1 ? '' : 's'}, 300 dpi, transparent` : '300 dpi, transparent';
      }
    };
    panel.refresh();
    return panel;
  }

  root.ExportPanel = { mount, slug };
})(typeof self !== 'undefined' ? self : this);
