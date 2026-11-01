// js/audit.js
// Project Audit workspace (port of project_audit): pick a project folder, scan every .p8
// for tokens / characters (with #include expanded), includes and cart references.

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const A = P8Audit;
  const { el, $, toast, download, store, showMessage } = App;

  const KEYS = { settings: 'p8suite.audit' };
  const TEXT_EXT = /\.(p8|lua|txt|p8l|inc)$/i;
  const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build']);
  const MAX_FILE = 4 * 1024 * 1024;

  const COLUMNS = [
    { key: 'name', label: 'Cart', always: true, num: false },
    { key: 'tokens_expanded', label: 'Tokens (exp)', num: true, limit: A.TOKEN_LIMIT },
    { key: 'tokens_self', label: 'Tokens (self)', num: true },
    { key: 'chars_expanded', label: 'Chars (exp)', num: true, limit: A.CHAR_LIMIT },
    { key: 'chars_self', label: 'Chars (self)', num: true },
    { key: 'inc_out', label: 'Includes', num: true, get: (c) => c.includes_out.length },
    { key: 'inc_in', label: 'Included by', num: true, get: (c) => c.includes_in.length },
    { key: 'refs', label: 'File refs', num: true, get: (c) => A.fileRefCount(c) },
    { key: 'warn', label: 'Warnings', num: true, get: (c) => c.warnings.length },
  ];
  const value = (col, c) => (col.get ? col.get(c) : c[col.key]);

  const saved = store.get(KEYS.settings, {}) || {};
  const au = {
    handle: null,          // FileSystemDirectoryHandle (rescan without asking again)
    rootName: '',
    files: null,           // Map path -> text
    meta: null,            // Map path -> {mtime, size}
    stats: [],
    selected: null,
    view: 'file',
    sort: saved.sort || { key: 'name', dir: 1 },
    hidden: new Set(saved.hidden || []),
    filter: '',
    scanning: false,
  };

  const dom = {
    open: $('#auOpen'),
    rescan: $('#auRescan'),
    root: $('#auRoot'),
    filter: $('#auFilter'),
    csv: $('#auCsv'),
    json: $('#auJson'),
    cols: $('#auCols'),
    progress: $('#auProgress'),
    status: $('#auStatus'),
    table: $('#auTable'),
    tableWrap: $('#auTableWrap'),
    empty: $('#auEmpty'),
    view: $('#auView'),
    details: $('#auDetails'),
    copy: $('#auCopy'),
    stage: $('#auStage'),
    dirInput: $('#auDirInput'),
  };

  const persist = () => store.set(KEYS.settings, { sort: au.sort, hidden: [...au.hidden] });

  // ------------------------------------------------------------------ //
  // Reading the folder                                                 //
  // ------------------------------------------------------------------ //

  async function readHandle(dir) {
    const files = new Map();
    const meta = new Map();
    const walk = async (h, prefix) => {
      for await (const entry of h.values()) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === 'directory') {
          if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name.toLowerCase())) await walk(entry, path);
        } else if (TEXT_EXT.test(entry.name)) {
          const f = await entry.getFile();
          if (f.size > MAX_FILE) continue;
          files.set(path, await f.text());
          meta.set(path, { mtime: f.lastModified, size: f.size });
        }
      }
    };
    await walk(dir, '');
    return { files, meta };
  }

  /** <input webkitdirectory> / dropped entries: paths include the root folder name. */
  async function readFileList(list) {
    const files = new Map();
    const meta = new Map();
    let root = '';
    for (const { file, path } of list) {
      const parts = path.split('/');
      if (!root) root = parts[0];
      const rel = parts.slice(1).join('/');
      if (!TEXT_EXT.test(file.name) || file.size > MAX_FILE) continue;
      if (parts.slice(1, -1).some((d) => d.startsWith('.') || SKIP_DIRS.has(d.toLowerCase()))) continue;
      files.set(rel, await file.text());
      meta.set(rel, { mtime: file.lastModified, size: file.size });
    }
    return { files, meta, root };
  }

  /** Dropped folder without File System Access: walk FileSystemEntry objects. */
  function entryFiles(entry) {
    return new Promise((resolve) => {
      const out = [];
      let pending = 0;
      const done = () => { if (--pending === 0) resolve(out); };
      const visit = (e) => {
        pending++;
        if (e.isFile) {
          e.file((f) => { out.push({ file: f, path: e.fullPath.replace(/^\//, '') }); done(); }, done);
        } else {
          const reader = e.createReader();
          const readAll = () => reader.readEntries((ents) => {
            if (!ents.length) { done(); return; }
            for (const c of ents) if (c.isFile || (!c.name.startsWith('.') && !SKIP_DIRS.has(c.name.toLowerCase()))) visit(c);
            readAll();
          }, done);
          readAll();
        }
      };
      visit(entry);
    });
  }

  /**
   * Uses the classic folder input, not showDirectoryPicker(): Chrome's folder picker refuses
   * everything under AppData ("contains system files"), which is where PICO-8 keeps its carts.
   */
  function chooseFolder() {
    dom.dirInput.value = '';
    dom.dirInput.click();
  }

  async function scan() {
    if (au.scanning) return;
    if (!au.handle) { chooseFolder(); return; }
    setBusy(true, `Reading ${au.rootName}…`);
    try {
      const { files, meta } = await readHandle(au.handle);
      await analyse(files, meta);
    } catch (err) {
      toast(`Scan failed: ${err.message}`, 'error');
      setBusy(false, 'Scan failed.');
    }
  }

  async function analyse(files, meta) {
    au.files = files;
    au.meta = meta;
    document.dispatchEvent(new CustomEvent('p8:project', { detail: { root: au.rootName } }));
    const n = [...files.keys()].filter((p) => /\.p8$/i.test(p)).length;
    setBusy(true, `Scanning ${n} carts…`);
    await new Promise((r) => setTimeout(r, 0)); // let the status paint
    const t0 = performance.now();
    au.stats = A.scanProject(files, meta);
    const keep = au.selected && au.stats.find((c) => c.path === au.selected);
    au.selected = keep ? keep.path : null;
    setBusy(false, `${au.stats.length} carts scanned in ${Math.round(performance.now() - t0)} ms · ${files.size - au.stats.length} other text files`);
    dom.root.textContent = au.rootName || 'Project';
    dom.rescan.disabled = false;
    dom.csv.disabled = dom.json.disabled = !au.stats.length;
    render();
  }

  function setBusy(on, text) {
    au.scanning = on;
    dom.progress.hidden = !on;
    dom.open.disabled = on;
    dom.rescan.disabled = on || (!au.handle && !au.stats.length);
    if (text != null) dom.status.textContent = text;
  }

  // ------------------------------------------------------------------ //
  // Table                                                              //
  // ------------------------------------------------------------------ //

  function sortedRows() {
    const col = COLUMNS.find((c) => c.key === au.sort.key) || COLUMNS[0];
    const q = au.filter.trim().toLowerCase();
    const rows = au.stats.filter((c) => !q || c.name.toLowerCase().includes(q));
    rows.sort((a, b) => {
      const va = value(col, a);
      const vb = value(col, b);
      const r = col.num ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return r * au.sort.dir || a.name.localeCompare(b.name);
    });
    return rows;
  }

  function cell(col, c) {
    const v = value(col, c);
    if (col.key === 'name') {
      const slash = c.name.lastIndexOf('/');
      return el('td', { className: 'au-name', title: c.name },
        slash >= 0 ? el('span', { className: 'muted', textContent: c.name.slice(0, slash + 1) }) : null, c.name.slice(slash + 1));
    }
    const td = el('td', { className: 'num' });
    if (col.limit) {
      const pct = v / col.limit;
      td.classList.add('au-meter');
      td.dataset.level = pct > 1 ? 'over' : pct > 0.9 ? 'high' : 'ok';
      td.style.setProperty('--pct', `${Math.min(100, pct * 100).toFixed(1)}%`);
      td.title = `${v} of ${col.limit} (${Math.round(pct * 100)}%)`;
    }
    if (col.key === 'warn' && v) td.classList.add('au-warn');
    td.textContent = v.toLocaleString('en-US');
    return td;
  }

  function render() {
    const has = au.stats.length > 0;
    dom.empty.hidden = has;
    dom.tableWrap.hidden = !has;
    const cols = COLUMNS.filter((c) => c.always || !au.hidden.has(c.key));
    const head = el('tr', {}, ...cols.map((c) => {
      const active = au.sort.key === c.key;
      const th = el('th', { className: c.num ? 'num' : '', attrs: { 'aria-sort': active ? (au.sort.dir > 0 ? 'ascending' : 'descending') : 'none' } },
        el('button', { type: 'button', className: 'au-sort', dataset: { key: c.key }, textContent: `${c.label}${active ? (au.sort.dir > 0 ? ' ▲' : ' ▼') : ''}` }));
      return th;
    }));
    const rows = sortedRows();
    const body = rows.map((c) => el('tr', {
      dataset: { path: c.path }, tabIndex: 0,
      className: c.path === au.selected ? 'selected' : '',
      attrs: { 'aria-selected': String(c.path === au.selected) },
    }, ...cols.map((col) => cell(col, c))));
    dom.table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...body));
    if (has && au.filter && !rows.length) dom.table.append(el('tbody', {}, el('tr', {}, el('td', { colSpan: cols.length, className: 'muted', textContent: 'No cart matches the filter.' }))));
    renderDetails();
  }

  function renderColumns() {
    dom.cols.replaceChildren(el('span', { className: 'label', textContent: 'Columns' }), ...COLUMNS.filter((c) => !c.always).map((c) => {
      const input = el('input', { type: 'checkbox', checked: !au.hidden.has(c.key) });
      input.addEventListener('change', () => {
        if (input.checked) au.hidden.delete(c.key); else au.hidden.add(c.key);
        persist();
        render();
      });
      return el('label', { className: 'check' }, input, el('span', { textContent: c.label }));
    }));
  }

  // ------------------------------------------------------------------ //
  // Details + summary                                                  //
  // ------------------------------------------------------------------ //

  const list = (items, empty = 'none') => (items.length
    ? el('ul', { className: 'au-list' }, ...items.map((t) => el('li', {}, el('code', { textContent: t }))))
    : el('p', { className: 'muted', textContent: empty }));

  function meter(label, v, limit) {
    const pct = v / limit;
    return el('div', { className: 'au-bar', dataset: { level: pct > 1 ? 'over' : pct > 0.9 ? 'high' : 'ok' } },
      el('div', { className: 'au-bar-head' }, el('span', { textContent: label }), el('span', { className: 'muted', textContent: `${v.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} · ${Math.round(pct * 100)}%` })),
      el('div', { className: 'au-bar-track' }, el('i', { style: `width:${Math.min(100, pct * 100).toFixed(1)}%` })));
  }

  function fileDetails(c) {
    const when = c.mtime ? new Date(c.mtime).toLocaleString() : '–';
    const refs = [['load(…)', c.load_refs], ['run(…)', c.run_refs], ['reload(…, file)', c.reload_file_refs], ['cstore(…, file)', c.cstore_file_refs]];
    return el('div', { className: 'au-detail' },
      el('h3', { className: 'au-title', textContent: c.name }),
      el('p', { className: 'muted', textContent: `Modified ${when} · ${(c.bytes / 1024).toFixed(1)} KB on disk` }),
      meter('Tokens (with includes)', c.tokens_expanded, A.TOKEN_LIMIT),
      meter('Characters (with includes)', c.chars_expanded, A.CHAR_LIMIT),
      el('p', { className: 'muted', textContent: `This cart alone: ${c.tokens_self.toLocaleString('en-US')} tokens, ${c.chars_self.toLocaleString('en-US')} characters.` }),
      c.warnings.length ? el('div', { className: 'au-warnings' }, el('h4', { textContent: 'Warnings' }), list(c.warnings)) : null,
      el('h4', { textContent: '#include' }), list(c.includes_out),
      el('h4', { textContent: 'Included by' }), list(c.includes_in),
      el('h4', { textContent: 'Cart references (code with includes)' }),
      ...refs.map(([label, items]) => el('div', { className: 'au-ref' }, el('span', { className: 'label', textContent: label }), list(items))),
      el('h4', { textContent: 'Names of other carts in this cart' }),
      el('p', { className: 'muted', textContent: 'Heuristic: another cart\'s name appears as a whole word (e.g. partlist={fx_osc,fx_logo}).' }),
      list(c.basename_refs));
  }

  function summaryView() {
    const s = A.summarize(au.stats);
    const card = (label, v) => el('div', { className: 'au-stat' }, el('strong', { textContent: v.toLocaleString('en-US') }), el('span', { className: 'muted', textContent: label }));
    const names = (arr, empty) => (arr.length
      ? el('ul', { className: 'au-list au-links' }, ...arr.map((c) => el('li', {}, el('button', { type: 'button', className: 'link', dataset: { path: c.path }, textContent: c.name }))))
      : el('p', { className: 'muted', textContent: empty }));
    return el('div', { className: 'au-detail' },
      el('h3', { className: 'au-title', textContent: `Project ${au.rootName}` }),
      el('div', { className: 'au-stats' }, card('carts', s.total), card('used', s.used.length), card('unused', s.unused.length), card('tokens in used carts', s.tokensSelf), card('characters in used carts', s.charsSelf)),
      s.overTokens.length || s.overChars.length
        ? el('div', { className: 'au-warnings' }, el('h4', { textContent: 'Over the PICO-8 limits' }), names([...new Set([...s.overTokens, ...s.overChars])], ''))
        : null,
      el('p', { className: 'muted', textContent: 'A cart counts as used when another cart includes, loads, runs, reloads or names it, or when it references other carts itself.' }),
      el('h4', { textContent: `Used (${s.used.length})` }), names(s.used.sort((a, b) => a.name.localeCompare(b.name)), 'none'),
      el('h4', { textContent: `Unused (${s.unused.length})` }), names(s.unused.sort((a, b) => a.name.localeCompare(b.name)), 'none, every cart is referenced'));
  }

  function renderDetails() {
    for (const b of dom.view.querySelectorAll('[data-value]')) b.setAttribute('aria-checked', String(b.dataset.value === au.view));
    dom.copy.disabled = !au.stats.length;
    if (!au.stats.length) {
      dom.details.replaceChildren(el('p', { className: 'muted', textContent: 'Scan a project to see details.' }));
      return;
    }
    if (au.view === 'summary') { dom.details.replaceChildren(summaryView()); return; }
    const c = au.stats.find((x) => x.path === au.selected);
    dom.details.replaceChildren(c ? fileDetails(c) : el('p', { className: 'muted', textContent: 'Select a cart in the table.' }));
  }

  /** Plain-text report like the desktop details pane. */
  function detailsText() {
    if (au.view === 'summary') {
      const s = A.summarize(au.stats);
      return ['PROJECT SUMMARY', '='.repeat(50), '',
        `Total files in project: ${s.total}`, `Referenced/Used files:  ${s.used.length}`, `Unused files:           ${s.unused.length}`, '',
        'TOTALS FOR USED FILES:', `  Total tokens (self):     ${s.tokensSelf}`, `  Total characters (self): ${s.charsSelf}`, '',
        'USED FILES:', ...(s.used.length ? s.used.map((c) => `  • ${c.name}`) : ['  (none)']), '',
        'UNUSED FILES:', ...(s.unused.length ? s.unused.map((c) => `  • ${c.name}`) : ['  (none - all files are referenced!)'])].join('\n');
    }
    const c = au.stats.find((x) => x.path === au.selected);
    if (!c) return '';
    const sec = (title, items, pad = '  ') => [title, ...(items.length ? items.map((t) => `${pad}- ${t}`) : [`${pad}(none)`])];
    return [`Cart: ${c.name}`, `Modified: ${c.mtime ? new Date(c.mtime).toLocaleString() : '-'}`, '', 'Size:',
      `  Tokens (expanded): ${c.tokens_expanded}`, `  Tokens (self):     ${c.tokens_self}`, `  Chars (expanded):  ${c.chars_expanded}`, `  Chars (self):      ${c.chars_self}`, '',
      ...sec('Includes OUT (#include ...):', c.includes_out), '', ...sec('Included BY (reverse includes):', c.includes_in), '',
      'Cart references (expanded code scan):', ...sec('  load(...):', c.load_refs, '    '), ...sec('  run(...):', c.run_refs, '    '),
      ...sec('  reload(... filename):', c.reload_file_refs, '    '), ...sec('  cstore(... filename):', c.cstore_file_refs, '    '), '',
      ...sec('Heuristic bare-name references (matches other cart basenames in the folder):', c.basename_refs), '',
      ...(c.warnings.length ? ['Warnings:', ...c.warnings.map((w) => `  - ${w}`)] : [])].join('\n');
  }

  function select(path) {
    au.selected = path;
    au.view = 'file';
    for (const tr of dom.table.querySelectorAll('tbody tr[data-path]')) {
      const on = tr.dataset.path === path;
      tr.classList.toggle('selected', on);
      tr.setAttribute('aria-selected', String(on));
    }
    renderDetails();
  }

  // ------------------------------------------------------------------ //
  // Binding                                                            //
  // ------------------------------------------------------------------ //

  function bind() {
    dom.open.addEventListener('click', chooseFolder);
    dom.rescan.addEventListener('click', () => (au.handle ? scan() : chooseFolder()));
    dom.dirInput.addEventListener('change', async () => {
      const list = [...dom.dirInput.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
      if (!list.length) return;
      au.handle = null;
      setBusy(true, 'Reading files…');
      const { files, meta, root } = await readFileList(list);
      au.rootName = root;
      await analyse(files, meta);
    });
    dom.filter.addEventListener('input', () => { au.filter = dom.filter.value; render(); });
    dom.csv.addEventListener('click', () => download(new Blob([A.toCsv(au.stats, au.rootName)], { type: 'text/csv' }), 'pico8_project_audit.csv'));
    dom.json.addEventListener('click', () => download(new Blob([A.toJson(au.stats, au.rootName)], { type: 'application/json' }), 'pico8_project_audit.json'));
    dom.copy.addEventListener('click', async () => {
      const t = detailsText();
      if (!t) return;
      try { await navigator.clipboard.writeText(t); toast('Copied the report.'); } catch { showMessage('Report', t); }
    });

    dom.table.addEventListener('click', (e) => {
      const sortBtn = e.target.closest('.au-sort');
      if (sortBtn) {
        const k = sortBtn.dataset.key;
        au.sort = au.sort.key === k ? { key: k, dir: -au.sort.dir } : { key: k, dir: k === 'name' ? 1 : -1 };
        persist();
        render();
        return;
      }
      const tr = e.target.closest('tr[data-path]');
      if (tr) select(tr.dataset.path);
    });
    dom.table.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-path]');
      if (!tr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr.dataset.path); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
        if (next?.dataset.path) { next.focus(); select(next.dataset.path); }
      }
    });
    dom.view.addEventListener('click', (e) => {
      const b = e.target.closest('[data-value]');
      if (!b) return;
      au.view = b.dataset.value;
      renderDetails();
    });
    dom.details.addEventListener('click', (e) => {
      const b = e.target.closest('button.link[data-path]');
      if (!b) return;
      select(b.dataset.path);
      dom.table.querySelector(`tr[data-path="${CSS.escape(b.dataset.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    });

    // Drop a folder onto the workspace
    dom.stage.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dom.stage.classList.add('dragover'); }
    });
    dom.stage.addEventListener('dragleave', (e) => { if (!dom.stage.contains(e.relatedTarget)) dom.stage.classList.remove('dragover'); });
    dom.stage.addEventListener('drop', async (e) => {
      dom.stage.classList.remove('dragover');
      const item = [...(e.dataTransfer?.items || [])].find((i) => i.kind === 'file');
      if (!item) return;
      e.preventDefault();
      // Both must be requested before the first await; the drop data is gone afterwards.
      const entry = item.webkitGetAsEntry?.();
      const handlePromise = item.getAsFileSystemHandle?.();
      try {
        // A handle allows rescanning without asking again, but Chrome refuses one for
        // folders under AppData; reading through the entry works there.
        const h = await handlePromise?.catch(() => null);
        if (h && h.kind === 'directory') {
          try {
            au.handle = h;
            au.rootName = h.name;
            setBusy(true, `Reading ${h.name}…`);
            const { files, meta } = await readHandle(h);
            await analyse(files, meta);
            return;
          } catch {
            au.handle = null;
          }
        }
        if (entry?.isDirectory) {
          au.handle = null;
          setBusy(true, 'Reading files…');
          const { files, meta } = await readFileList(await entryFiles(entry));
          au.rootName = entry.name;
          await analyse(files, meta);
          return;
        }
        toast('Drop a project folder (not single files).', 'warn');
      } catch (err) {
        setBusy(false, '');
        toast(`Could not read the folder: ${err.message}`, 'error');
      }
    });

    App.registerShortcuts('audit', (e, typing) => {
      if (typing || e.type === 'keyup') return;
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        if (!au.stats.length && !au.handle) return;
        e.preventDefault();
        if (au.handle) scan(); else chooseFolder();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); chooseFolder(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); dom.filter.focus(); }
    });
  }

  // The opened project folder, shared with other workspaces (Data Carts).
  window.P8Project = {
    get files() { return au.files; },
    get meta() { return au.meta; },
    get root() { return au.rootName; },
    choose: chooseFolder,
    rescan: () => (au.handle ? scan() : chooseFolder()),
  };

  S.registerTool({ ws: 'audit', name: 'Project Audit', desc: 'Scan a project folder: tokens and characters per cart (with #include), includes, load/run/reload references, unused carts.', color: '#00e436', tags: ['tokens', 'includes', 'CSV'] });

  bind();
  renderColumns();
  render();
})();
