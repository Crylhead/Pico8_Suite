// js/project.js
// Cart Builder workspace: a demo project folder (read/write), its assets and parts, the data
// carts as stacks, auto-pack, and writing carts + --@data anchors. Logic: js/project-core.js

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const C = P8Cart;
  const P = P8Project;
  const V = P8DataView;
  const { el, $, toast, showMessage, modal, confirmDialog } = App;
  const { rgbOf } = P8;
  const hex = P.hex;
  const kb = (n) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  const TYPE_COLOR = { image: '#29adff', layered: '#83769c', palette: '#ff77a8', fades: '#ffa300', tiles: '#00e436', table: '#c2c3c7' };
  const KV_HANDLE = 'cartbuilder.folder';
  const SUITE_MARK = 'data cart written by the pico-8 dev suite';

  const pj = {
    root: null,          // FileSystemDirectoryHandle of the project folder
    demo: null,          // its demo/ folder
    texts: new Map(),    // demo/*.p8 name -> text
    project: null,       // suite.json
    assets: [],
    dirtyAssets: new Set(),
    dirtyTexts: new Set(), // fx carts changed in memory (renamed anchors)
    renamed: new Map(),    // new asset name -> name of its file in assets/
    layout: [],          // [{name, items: [{ref, off}]}]
    parts: [],
    adoptPlan: null,
    pendingHandle: null, // remembered folder that still needs permission
    journalPending: false, // an interrupted write left suite.journal.json: no writes until it is recovered
    busy: false,         // a write, adoption or recovery is running: other mutations and folder switches wait
    writtenSig: null,    // layoutSig() when the project was loaded / last written (#66: tells "written" from "changed since")
    lastWrite: '',       // what the last verified write produced, shown by the workflow strip; cleared on open
    disk: new Map(),     // "demo/x.p8" | "assets/x.json" | "demo/suite.json" -> raw text as read (null: absent); writes expect it unchanged
  };

  const dom = {
    open: $('#cbOpen'), reconnect: $('#cbReconnect'), root: $('#cbRoot'), status: $('#cbStatus'),
    pack: $('#cbPack'), write: $('#cbWrite'), addLib: $('#cbAddLib'), addMap: $('#cbAddMap'), addFile: $('#cbAddFile'),
    parts: $('#cbParts'), stacks: $('#cbStacks'), report: $('#cbReport'), adopt: $('#cbAdopt'), stages: $('#cbStages'),
  };

  // ------------------------------------------------------------------ //
  // Folder access                                                      //
  // ------------------------------------------------------------------ //

  async function exists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch { return false; }
  }

  /** one project mutation at a time in this page (P.transact also holds a cross-tab lock) */
  async function exclusive(title, fn) {
    if (pj.busy) { showMessage(title, 'Cart Builder is still writing or recovering the project. Try again when it has finished.'); return; }
    pj.busy = true;
    render();
    try { await fn(); } finally { pj.busy = false; render(); }
  }

  async function openFolder() {
    if (pj.busy) { showMessage('Cart Builder', 'Wait until the current write has finished before opening another folder.'); return; }
    if (!window.showDirectoryPicker) { showMessage('Cart Builder', 'This browser cannot write to folders. Use Chrome or Edge.'); return; }
    let h;
    try { h = await window.showDirectoryPicker({ id: 'p8-demo-project', mode: 'readwrite' }); } catch { return; }
    await useFolder(h);
  }

  async function useFolder(h) {
    await exclusive('Cart Builder', () => openProject(h));
  }

  async function openProject(h) {
    // demoframe layout (demo/ next to tools/, music/) or a flat demo (main.p8 in the folder)
    let demo = null;
    try { demo = await h.getDirectoryHandle('demo'); } catch {
      if (await exists(h, 'main.p8')) demo = h;
    }
    if (!demo) {
      showMessage('Cart Builder', `“${h.name}” has neither a demo/ folder nor a main.p8. Choose the project folder (the one that contains demo/, e.g. a copy of demoframe) or a flat demo folder with main.p8.`);
      return;
    }
    pj.root = h;
    pj.demo = demo;
    pj.pendingHandle = null;
    pj.writtenSig = null;
    pj.lastWrite = '';
    App.projectContextPublisher?.select({ name: h.name, source: 'cartbuilder', handle: h }).catch(() => {});
    try { await S.kv.set(KV_HANDLE, h); } catch { /* not storable: ask again next time */ }
    await load();
  }

  async function reconnect() {
    const h = pj.pendingHandle;
    if (!h) return;
    if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') await useFolder(h);
  }

  async function restore() {
    if (pj.root || pj.pendingHandle) return;
    let h = null;
    try { h = await S.kv.get(KV_HANDLE); } catch { /* none */ }
    if (!h?.queryPermission) return;
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') await useFolder(h);
    else { pj.pendingHandle = h; render(); }
  }

  // ------------------------------------------------------------------ //
  // Recoverable writes (P.transact, docs/PROJECT_MODEL.md)              //
  // ------------------------------------------------------------------ //

  /** the folders of the project open now (captured: switching folders cannot redirect a running write) */
  function projectDirs() {
    const { root, demo } = pj;
    return {
      demo,
      assets: (create) => root.getDirectoryHandle('assets', { create }),
      unused: (create) => demo.getDirectoryHandle('unused', { create }),
    };
  }
  const inDemo = (name) => `${pj.demo === pj.root ? '' : 'demo/'}${name}`;

  /** runs a transaction; on failure explains what happened and returns null (the in-memory state stays dirty) */
  async function commit(plan, title) {
    if (pj.journalPending) { showMessage(title, `${inDemo(P.JOURNAL)} from an interrupted write is still there. Reopen the project to restore it first. Nothing was written.`); return null; }
    // everything the write was computed from must still be on disk as it was read (issue #4)
    const key = (dir, name) => `${dir}/${name}`;
    const writes = plan.writes.map((w) => ({ ...w, expect: pj.disk.has(key(w.dir, w.name)) ? pj.disk.get(key(w.dir, w.name)) : null }));
    const written = new Set(writes.map((w) => key(w.dir, w.name)));
    const checks = [...pj.disk].filter(([k]) => !written.has(k)).map(([k, expect]) => ({ dir: k.split('/')[0], name: k.slice(k.indexOf('/') + 1), expect }));
    // files that appeared since: a new cart may reference what is about to retire, a new asset may be overwritten
    let assetDir = null;
    try { assetDir = await pj.root.getDirectoryHandle('assets'); } catch { /* none yet */ }
    for (const [dir, handle, re] of [['demo', pj.demo, /\.p8$/i], ['assets', assetDir, /\.json$/i]]) {
      if (handle) for await (const [n, h] of handle.entries()) if (h.kind === 'file' && re.test(n) && !pj.disk.has(key(dir, n)) && !written.has(key(dir, n))) checks.push({ dir, name: n, expect: null });
    }
    try {
      const r = await P.transact(projectDirs(), { ...plan, writes, checks });
      for (const w of writes) pj.disk.set(key(w.dir, w.name), w.text);
      for (const n of r.retired) pj.disk.delete(key('demo', n));
      if (r.retireErrors.length) showMessage(title, `Everything was written, but some old carts could not be moved to ${inDemo('unused/')} and stay where they are:\n${r.retireErrors.join('\n')}`);
      return r;
    } catch (e) {
      if (!(e instanceof P.WriteError)) throw e;
      pj.journalPending = e.journalKept;
      if (e.stage === 'busy') { showMessage(title, e.message); return null; }
      if (e.stage === 'conflict') {
        showMessage(title, `These files changed on disk after Cart Builder read them (in PICO-8, another tab or another program):\n${e.conflicts.join('\n')}\n\nNothing was written: the files on disk keep the external changes and Cart Builder keeps its own changes in memory. To continue from the disk versions, open the folder again (Cart Builder's unsaved changes are then dropped).`);
        return null;
      }
      showMessage(title, `${e.message}${pj.project ? '\n\nYour unsaved changes are still here.' : ''}`);
      return null;
    }
  }

  /**
   * a journal left by an interrupted write: finish or undo it before anything else. P.recover decides
   * from the files themselves (under the write lock) and asks before restoring originals.
   */
  async function recoverWrites() {
    pj.journalPending = false;
    if (!(await exists(pj.demo, P.JOURNAL))) return;
    const j = inDemo(P.JOURNAL);
    const r = await P.recover(projectDirs(), {
      confirmRollback: ({ reason, files }) => confirmDialog('Interrupted write', reason === 'mixed'
        ? `An earlier write was recorded as finished (${j}), but these files now hold neither its new contents nor their originals:\n${files.join('\n')}\n\nRestore every file that write changed (and the carts it moved to unused/) to the state before it? Otherwise the files stay as they are and Cart Builder writes nothing.`
        : `An earlier write did not finish (${j}). Restore the files it changed, and the carts it moved to unused/, to their state before that write? Until then Cart Builder writes nothing.`, 'Restore'),
    });
    if (!r) return;
    if (r.outcome === 'busy') { pj.journalPending = true; showMessage('Interrupted write', `${j} is there, but ${r.problems[0]} Reopen the project when it has finished.`); return; }
    if (r.outcome === 'declined') { pj.journalPending = true; return; }
    if (r.problems.length) { pj.journalPending = true; showMessage('Interrupted write', `Could not finish the recovery; ${j} stays and keeps the original contents:\n${r.problems.join('\n')}`); return; }
    if (r.notes.length) showMessage('Interrupted write', `Finished an earlier write. Some old carts stay where they are:\n${r.notes.join('\n')}`);
    else toast(r.outcome === 'new' ? `Finished an earlier write (${r.retired.length} carts moved to unused/).` : 'Restored the files and carts of an interrupted write.', 'info', 4000);
  }

  // ------------------------------------------------------------------ //
  // Loading                                                            //
  // ------------------------------------------------------------------ //

  /** demo/*.p8 texts -> carts as Data Carts analyses them (with reads) */
  function cartsFromTexts(texts) {
    const carts = new Map();
    for (const [name, text] of texts) {
      let p;
      try { p = C.parseP8(text); } catch { continue; }
      carts.set(name.toLowerCase(), { name, text, rom: p.rom, lua: p.lua, luaAt: text.split('\n').findIndex((l) => /^__lua__\s*$/.test(l)) + 1, used: C.usedMask(p.rom), reads: [] });
    }
    const names = [...carts.values()].map((c) => c.name);
    for (const c of carts.values()) {
      for (const r of C.findReloads(c.lua)) {
        const t = C.reloadTarget(r.fileExpr, c.lua);
        if (!t) continue;
        for (const n of names.filter(t.match)) {
          const src = r.src ?? 0;
          carts.get(n.toLowerCase()).reads.push({ from: c.name, src, len: Math.min(r.len ?? C.ROM_SIZE, C.ROM_SIZE - src), dest: r.dest });
        }
      }
    }
    return carts;
  }

  async function load() {
    dom.status.textContent = 'reading…';
    await recoverWrites();
    pj.texts = new Map();
    pj.disk = new Map([['demo/suite.json', null]]);
    for await (const [name, h] of pj.demo.entries()) {
      if (h.kind !== 'file' || !(/\.p8$/i.test(name) || name === 'suite.json')) continue;
      const raw = await (await h.getFile()).text();
      pj.disk.set(`demo/${name}`, raw);
      if (name !== 'suite.json') pj.texts.set(name, raw.replace(/\r\n/g, '\n'));
    }
    pj.project = null;
    pj.assets = [];
    pj.dirtyAssets = new Set();
    pj.dirtyTexts = new Set();
    pj.renamed = new Map();
    pj.layout = [];
    if (await exists(pj.demo, 'suite.json')) {
      try { pj.project = JSON.parse(pj.disk.get('demo/suite.json').replace(/\r\n/g, '\n')); } catch (e) { showMessage('Cart Builder', `demo/suite.json could not be read: ${e.message}`); }
    }
    try {
      const ad = await pj.root.getDirectoryHandle('assets');
      for await (const [name, h] of ad.entries()) {
        if (h.kind !== 'file' || !name.endsWith('.json')) continue;
        const raw = await (await h.getFile()).text();
        pj.disk.set(`assets/${name}`, raw);
        try { pj.assets.push(P.assetFromJson(raw)); } catch { /* skip broken asset files */ }
      }
    } catch { /* no assets/ yet */ }
    pj.adoptPlan = pj.project ? null : P.adopt(cartsFromTexts(pj.texts));
    upgradeSegments();
    syncLayout();
    render();
  }

  /**
   * Assets adopted before segments existed: find them in their source cart (meta.from =
   * "cart.p8 0xoffset"), as long as that cart is still in the folder (until the first Write).
   */
  function upgradeSegments() {
    const todo = pj.assets.filter((a) => !a.meta?.segments && a.type !== 'cartset');
    if (!todo.length) return;
    const carts = cartsFromTexts(pj.texts);
    for (const a of todo) {
      const m = /^(\S+\.p8) (0x[\da-f]+)$/i.exec(a.meta?.from || '');
      const cart = m && carts.get(m[1].toLowerCase());
      if (!cart) continue;
      const [id, part] = Object.entries(a.parts)[0];
      a.meta.segments = { [id]: P.segmentsOf(cart, carts, C.parseNum(m[2]), part.bytes.length) };
      pj.dirtyAssets.add(a.name);
    }
  }

  /** layout from suite.json, minus parts that are gone; new parts stay unplaced */
  function syncLayout() {
    pj.parts = P.partsOf(pj.assets);
    const refs = new Set(pj.parts.map((p) => p.ref));
    const size = new Map(pj.parts.map((p) => [p.ref, p.bytes.length]));
    pj.layout = (pj.layout.length ? pj.layout : pj.project?.carts || []).map((c) => ({ name: c.name, items: c.items.filter((i) => refs.has(i.ref)).map((i) => ({ ref: i.ref })) }));
    for (const c of pj.layout) { let off = 0; for (const it of c.items) { it.off = off; off += size.get(it.ref); } }
  }

  const placed = () => new Set(pj.layout.flatMap((c) => c.items.map((i) => i.ref)));
  const partOf = (ref) => pj.parts.find((p) => p.ref === ref);
  const cartUsed = (c) => c.items.reduce((s, i) => s + (partOf(i.ref)?.bytes.length || 0), 0);
  const repack = () => { const size = new Map(pj.parts.map((p) => [p.ref, p.bytes.length])); for (const c of pj.layout) { let off = 0; for (const it of c.items) { it.off = off; off += size.get(it.ref) || 0; } } };

  // ------------------------------------------------------------------ //
  // Preflight dialog and workflow stages (#66, js/preflight-core.js)      //
  // ------------------------------------------------------------------ //

  const ACTION_TEXT = { add: 'added', change: 'changed', retire: 'moved to unused/', remove: 'removed' };

  /** shows every file target before a write; resolves true only on the confirm button (Cancel / Esc = false, nothing written) */
  async function showPreflight(report, title, intro) {
    const section = (action) => {
      const rows = report.files.filter((f) => f.action === action);
      if (!rows.length) return null;
      return el('section', {}, el('h3', { textContent: `${rows.length} ${ACTION_TEXT[action]}` }),
        el('ul', { className: 'pf-list' }, ...rows.map((f) => el('li', {}, el('code', { textContent: f.path }), el('span', { className: 'muted', textContent: ` ${f.why}` })))));
    };
    const body = el('div', { className: 'pf' },
      el('p', { className: 'pf-intro', textContent: intro }),
      el('p', { className: 'pf-summary', textContent: report.summary }),
      ...['add', 'change', 'remove', 'retire'].map(section).filter(Boolean),
      report.kept.length ? el('section', {}, el('h3', { textContent: 'Stay in place (still referenced)' }), el('ul', { className: 'pf-list' }, ...report.kept.map((k) => el('li', { textContent: `${k.cart} (${k.by})` })))) : null,
      report.unresolved.length ? el('section', {}, el('h3', { className: 'cb-warn', textContent: 'References that cannot be resolved, so no cart is moved' }),
        el('ul', { className: 'pf-list' }, ...report.unresolved.map((u) => el('li', {}, el('code', { textContent: `${u.file}:${u.line}` }), el('span', { textContent: ` ${u.call} (${u.why})` }))))) : null);
    const v = await modal({
      title, body, wide: true, alert: true,
      buttons: [{ label: 'Cancel', value: false }, { label: report.confirmLabel, value: true, primary: true }],
    });
    return v === true;
  }

  /** signature of the arrangement, to tell "written" from "changed since" */
  const layoutSig = () => JSON.stringify(pj.layout.map((c) => [c.name, c.items.map((i) => i.ref)]));

  function renderStages() {
    if (!dom.stages) return;
    const chk = pj.project ? P.checkAnchors(anchorFiles(), pj.parts, pj.layout) : { errors: [], warnings: [] };
    if (pj.project && pj.writtenSig == null) pj.writtenSig = layoutSig();
    const list = P8Preflight.stages({
      open: Boolean(pj.root), hasProject: Boolean(pj.root && pj.project), partCount: pj.parts.length,
      unplaced: pj.project ? pj.parts.filter((p) => !placed().has(p.ref)).length : 0,
      errors: chk.errors.length, warnings: chk.warnings.length,
      needsWrite: Boolean(pj.project) && (pj.dirtyAssets.size > 0 || pj.dirtyTexts.size > 0 || pj.writtenSig !== layoutSig()),
      lastWrite: pj.lastWrite || '',
    });
    const ICON = { done: '✓', current: '●', todo: '○', blocked: '✕' };
    dom.stages.replaceChildren(...list.map((s, i) => el('li', { className: `cb-stage cb-stage-${s.status}`, attrs: s.status === 'current' ? { 'aria-current': 'step' } : {} },
      el('span', { className: 'cb-stage-icon', textContent: ICON[s.status], attrs: { 'aria-hidden': 'true' } }),
      el('strong', { textContent: `${i + 1}. ${s.label}` }),
      el('span', { className: 'sr-only', textContent: ` (${s.status})` }),
      el('span', { className: 'muted cb-stage-detail', textContent: s.detail }))));
  }

  /** keyboard / button alternative to dragging: choose the cart (or "not placed") for a part */
  async function movePartDialog(ref) {
    if (pj.busy) { showMessage('Cart Builder', 'Wait until the current write has finished.'); return; }
    const p = partOf(ref);
    if (!p) return;
    const here = pj.layout.find((c) => c.items.some((i) => i.ref === ref));
    const sel = el('select', { className: 'select', attrs: { 'aria-label': `Cart for ${ref}` } },
      ...pj.layout.map((c) => el('option', { value: c.name, textContent: `${c.name} (${kb(P.CART - cartUsed(c))} free)` })),
      el('option', { value: '+', textContent: 'A new cart' }),
      el('option', { value: '', textContent: 'Not placed (remove from carts)' }));
    sel.value = here ? here.name : '';
    const v = await modal({
      title: `Move ${ref}`,
      body: el('div', { className: 'dialog-form' }, el('p', { className: 'muted', textContent: `${kb(p.bytes.length)}${here ? ` · now in ${here.name}` : ' · not placed'}. Nothing is written until Write Carts.` }),
        el('label', { className: 'field' }, el('span', { textContent: 'Move to' }), sel)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Move', primary: true, value: () => sel.value }],
      onOpen: () => sel.focus(),
    });
    if (v == null || pj.busy) return;
    if (v === (here ? here.name : '')) return;
    moveTo(ref, v);
    toast(v === '' ? `${ref} is not placed any more.` : `${ref} moved to ${v === '+' ? 'a new cart' : v}.`);
  }

  // ------------------------------------------------------------------ //
  // Adopting an existing demo                                          //
  // ------------------------------------------------------------------ //

  async function adoptNow() {
    const plan = pj.adoptPlan;
    if (!plan) return;
    const kept = plan.keptCarts.length ? ` Kept in place, because reload() lines left as they are still read them: ${plan.keptCarts.join(', ')}.` : '';
    // #66: the first writes of adoption are listed file by file (anchors in fx carts, new assets, the manifest)
    const perFile = new Map();
    for (const e of plan.edits) perFile.set(e.file, (perFile.get(e.file) || 0) + 1);
    const report = P8Preflight.build({
      mode: 'adopt', prefix: inDemo(''), onDisk: new Set([...pj.texts.keys()].map((n) => n.toLowerCase())),
      carts: [], rewrites: [...perFile].map(([name, changes]) => ({ name, changes })),
      assets: plan.assets.map((a) => ({ name: a.name, exists: false })), manifestExists: pj.disk.get('demo/suite.json') != null,
      retire: [], kept: plan.keptCarts.map((c) => ({ cart: c, by: 'a reload() line left as it is' })), unresolved: [],
    });
    const ok = await showPreflight(report, 'Adopt this demo: writes now', `The suite takes over the data of ${plan.sourceCarts.length} carts as ${plan.assets.length} assets (assets/), adds ${plan.edits.length} --@data anchors to the fx code and then packs new data carts. Old carts nothing reads any more move to demo/unused/.${kept} The demo runs the same as before.\n\nNothing is written until you press “Write carts”, except the anchors and assets now.`);
    if (!ok) return;
    // anchors into the fx files
    const byFile = new Map();
    for (const e of plan.edits) { if (!byFile.has(e.file)) byFile.set(e.file, []); byFile.get(e.file).push(e); }
    const fxTexts = new Map();
    for (const [file, es] of byFile) {
      const lines = pj.texts.get(file).split('\n');
      for (const e of es) {
        if (lines[e.line - 1] !== e.before) { showMessage('Adopt', `${file}:${e.line} changed meanwhile. Nothing was adopted.`); return; }
        lines[e.line - 1] = e.after;
      }
      fxTexts.set(file, lines.join('\n'));
    }
    const project = { ...plan.project, carts: [], adoptedFrom: plan.adoptedCarts };
    const result = await commit({
      writes: [
        ...[...fxTexts].map(([name, text]) => ({ dir: 'demo', name, text, stage: 'fx' })),
        ...plan.assets.map((a) => ({ dir: 'assets', name: `${a.name}.json`, text: P.assetToJson(a), stage: 'asset' })),
        { dir: 'demo', name: 'suite.json', text: JSON.stringify(project, null, 1), stage: 'manifest' },
      ],
    }, 'Adopt');
    if (!result) return;
    for (const [file, t] of fxTexts) pj.texts.set(file, t);
    pj.assets = plan.assets.slice();
    pj.project = project;
    pj.adoptPlan = null;
    syncLayout();
    autoPack();
    toast(`Adopted: ${plan.assets.length} assets, ${plan.edits.length} anchors. Check the stacks, then “Write carts”.`, 'info', 4000);
  }

  // ------------------------------------------------------------------ //
  // Packing + writing                                                  //
  // ------------------------------------------------------------------ //

  /** demo carts the project does not own (their names cannot be used for new carts) */
  function foreignCarts() {
    const own = new Set([...(pj.project?.carts || []).map((c) => c.name.toLowerCase()), ...(pj.project?.adoptedFrom || []).map((n) => n.toLowerCase())]);
    return new Set([...pj.texts.keys()].map((n) => n.toLowerCase()).filter((n) => !own.has(n)));
  }

  function autoPack() {
    const r = P.autoPack(pj.parts, { prefix: pj.project?.prefix || 'd', taken: foreignCarts() });
    if (r.errors.length) showMessage('Auto-pack', r.errors.join('\n'));
    pj.layout = r.carts;
    render();
  }

  function anchorFiles() {
    return [...pj.texts].filter(([, t]) => t.includes('--@data')).map(([name, text]) => ({ name, text }));
  }

  async function writeAll() {
    const unplaced = pj.parts.filter((p) => !placed().has(p.ref));
    if (unplaced.length) { showMessage('Write carts', `Not placed yet: ${unplaced.map((p) => p.ref).join(', ')}. Drag them onto a stack or use Auto-pack.`); return; }
    const over = pj.layout.filter((c) => cartUsed(c) > P.CART);
    if (over.length) { showMessage('Write carts', `Too full: ${over.map((c) => c.name).join(', ')}.`); return; }
    const layout = pj.layout.filter((c) => c.items.length);
    const texts = P.buildCarts(layout, pj.parts);
    const bad = P.verifyCarts(texts, layout, pj.parts);
    if (bad.length) { showMessage('Write carts', `The carts failed their check, nothing was written:\n${bad.join('\n')}`); return; }
    const { where, whereSet } = P.placements(layout, pj.parts);
    const rewrites = [];
    const errors = [];
    for (const f of anchorFiles()) {
      const r = P.rewriteAnchors(f.text, (ref) => where.get(ref), (n) => whereSet.get(n));
      errors.push(...r.errors.map((e) => `${f.name}:${e.line} ${e.msg}`));
      if (r.changes.length || pj.dirtyTexts.has(f.name)) rewrites.push({ name: f.name, text: r.text, changes: r.changes });
    }
    errors.push(...P.checkAnchors(rewrites.length ? anchorFiles().map((f) => rewrites.find((r) => r.name === f.name) || f) : anchorFiles(), pj.parts, layout).errors);
    if (errors.length) { showMessage('Write carts', `Anchors that cannot be resolved, nothing was written:\n${[...new Set(errors)].join('\n')}`); return; }
    // carts the project wrote before (or adopted) that the new layout no longer uses go to demo/unused/,
    // but only when nothing in the final sources still references them (docs/PROJECT_MODEL.md)
    const inLayout = new Set(layout.map((c) => c.name.toLowerCase()));
    const candidates = [...new Set([...(pj.project?.carts || []).map((c) => c.name), ...(pj.project?.adoptedFrom || [])])].filter((n) => !inLayout.has(n.toLowerCase()) && pj.texts.has(n));
    const finalTexts = new Map([...pj.texts, ...Object.entries(texts), ...rewrites.map((r) => [r.name, r.text])]);
    const files = [...finalTexts].map(([name, text]) => ({ name, text }));
    for await (const [name, h] of pj.demo.entries()) if (h.kind === 'file' && /\.lua$/i.test(name)) files.push({ name, text: await (await h.getFile()).text() });
    // a cart this write rewrites is not also moved (one write, one original per file); it stays as a source,
    // so the carts it references stay as well
    const rewritten = new Map(rewrites.map((r) => [r.name, 'its anchors are rewritten by this write']));
    const analysis = P.retirement(candidates, files, rewritten);
    const { kept, unresolved, retire } = analysis;
    const unusedDir = inDemo('unused/');
    const keptNote = kept.length ? `\n\nStays in place because it is still referenced:\n${kept.map((k) => `${k.cart} (${k.by})`).join('\n')}` : '';
    const unresolvedNote = unresolved.length ? `\n\nReferences that cannot be resolved, so no cart is moved:\n${unresolved.map((u) => `${u.file}:${u.line} ${u.call} (${u.why})`).join('\n')}` : '';
    // #66: the confirmation lists the real file targets and what is added, changed or moved; nothing is written before it
    const removedAssets = [...pj.renamed].filter(([to, from]) => to !== from && !pj.assets.some((a) => a.name === from)).map(([, from]) => from);
    const report = P8Preflight.build({
      mode: 'write', prefix: inDemo(''), onDisk: new Set([...pj.texts.keys()].map((n) => n.toLowerCase())),
      carts: layout.map((c) => ({ name: c.name, parts: c.items.length })),
      rewrites: rewrites.map((r) => ({ name: r.name, changes: r.changes.length })),
      assets: [...pj.dirtyAssets].map((n) => ({ name: n, exists: pj.disk.has(`assets/${n}.json`) && pj.disk.get(`assets/${n}.json`) != null })),
      removedAssets, manifestExists: pj.disk.get('demo/suite.json') != null,
      retire, kept, unresolved,
    });
    const ok = await showPreflight(report, 'Write carts: review the files', 'Only these files change. Nothing is written until you confirm; Cancel keeps your arrangement and writes nothing. A failed write is explained and can be recovered; success is shown only after the write was verified.');
    if (!ok) return;
    // Store lengths for manifest inspection and optional external release checkers.
    const saved = layout.map((c) => ({ name: c.name, items: c.items.map((i) => ({ ref: i.ref, off: i.off, len: partOf(i.ref).bytes.length, lz: partOf(i.ref).lz })) }));
    const project = { ...(pj.project || { format: P.FORMAT, prefix: 'd', unmanaged: [] }), carts: saved, adoptedFrom: [] };
    const assetWrites = [];
    for (const n of pj.dirtyAssets) { const a = pj.assets.find((x) => x.name === n); if (a) assetWrites.push({ dir: 'assets', name: `${a.name}.json`, text: P.assetToJson(a), stage: 'asset' }); }
    // renamed assets: the file under the old name goes
    for (const [to, from] of pj.renamed) if (to !== from && !pj.assets.some((a) => a.name === from)) assetWrites.push({ dir: 'assets', name: `${from}.json`, text: null, stage: 'asset' });
    const result = await commit({
      writes: [
        ...Object.entries(texts).map(([name, text]) => ({ dir: 'demo', name, text, stage: 'cart' })),
        ...rewrites.map((r) => ({ dir: 'demo', name: r.name, text: r.text, stage: 'fx' })),
        ...assetWrites,
        { dir: 'demo', name: 'suite.json', text: JSON.stringify(project, null, 1), stage: 'manifest' },
      ],
      retire: retire.map((name) => ({ from: 'demo', to: 'unused', name })),
    }, 'Write carts');
    if (!result) return;
    for (const [name, text] of Object.entries(texts)) pj.texts.set(name, text);
    for (const r of rewrites) pj.texts.set(r.name, r.text);
    for (const n of result.retired) pj.texts.delete(n);
    pj.dirtyTexts.clear();
    pj.dirtyAssets.clear();
    pj.renamed.clear();
    pj.project = project;
    pj.writtenSig = layoutSig();
    pj.lastWrite = `${layout.length} data cart${layout.length === 1 ? '' : 's'}, ${rewrites.length} fx cart${rewrites.length === 1 ? '' : 's'}${retire.length ? `, ${retire.length} moved to unused/` : ''}`;
    toast(`Wrote ${layout.length} carts and ${rewrites.reduce((s, r) => s + r.changes.length, 0)} anchor lines.`, 'info', 4000);
    render();
  }

  // ------------------------------------------------------------------ //
  // Adding assets                                                      //
  // ------------------------------------------------------------------ //

  async function askName(base) {
    const input = el('input', { type: 'text', value: P.safeName(base), spellcheck: false });
    const v = await modal({
      title: 'New asset', body: el('div', { className: 'dialog-form' }, el('label', { className: 'field' }, el('span', { textContent: 'Name (letters, digits, _)' }), input)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Add', primary: true, value: () => input.value }], onOpen: () => input.select(),
    });
    if (v == null) return null;
    let name = P.safeName(v);
    for (let k = 2; pj.assets.some((a) => a.name === name); k++) name = `${P.safeName(v)}_${k}`;
    return name;
  }

  function addAsset(a) {
    pj.assets.push(a);
    pj.dirtyAssets.add(a.name);
    syncLayout();
    render();
    toast(`Added ${a.name}. Place it (Auto-pack or drag) and anchor a reload() line with --@data ${Object.keys(a.parts).map((p) => `${a.name}.${p}`).join(' / ')}.`, 'info', 4500);
  }

  async function addFromLibrary() {
    if (!pj.root) return;
    const a = await S.pickAsset({ title: 'Image for the project (4 bits per pixel)' });
    if (!a) return;
    const name = await askName(a.name);
    if (!name) return;
    const w = a.w + (a.w & 1);
    const bytes = new Uint8Array((w >> 1) * a.h);
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x += 2) bytes[y * (w >> 1) + (x >> 1)] = (a.pixels[y * a.w + x] & 15) | ((x + 1 < a.w ? a.pixels[y * a.w + x + 1] & 15 : 0) << 4);
    addAsset({ format: P.FORMAT, name, type: 'image', meta: { w, h: a.h, pal: a.pal, fades: a.meta?.fades ? true : undefined, from: `library: ${a.name}` }, parts: { img: { bytes, lz: false, group: null } } });
  }

  /** Map Editor map -> tiles asset: .gfx (sprite sheet bytes, only the rows it has) + .map (1 byte per cell). */
  async function addMapFromLibrary() {
    if (!pj.root) return;
    const a = await S.pickAsset({ title: 'Map for the project (tiles: .gfx + .map)', kind: 'map', allowImport: false });
    if (!a) return;
    const name = await askName(a.name);
    if (!name) return;
    const gfx = P8Map.sheetBytes(a.sheet);
    const map = Uint8Array.from(a.cells);
    if (map.length > P.CART) { showMessage('Add map', `The ${a.w}×${a.h} map has ${map.length} bytes; one part can hold at most ${P.CART} (one cart). Make it smaller or split it.`); return; }
    addAsset({ format: P.FORMAT, name, type: 'tiles', meta: { w: a.w, h: a.h, pal: a.pal, from: `library: ${a.name}` }, parts: { gfx: { bytes: gfx, lz: false, group: null }, map: { bytes: map, lz: false, group: null } } });
  }

  async function addFile() {
    if (!pj.root) return;
    const f = await App.pickFile('');
    if (!f) return;
    const name = await askName(f.name.replace(/\.[^.]*$/, ''));
    if (!name) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length > P.CART) { showMessage('Add file', `${f.name} has ${bytes.length} bytes; one part can hold at most ${P.CART} (one cart). Split it first.`); return; }
    addAsset({ format: P.FORMAT, name, type: 'table', meta: { from: `file: ${f.name}` }, parts: { bin: { bytes, lz: false, group: null } } });
  }

  // ------------------------------------------------------------------ //
  // Rendering                                                          //
  // ------------------------------------------------------------------ //

  function render() {
    dom.root.textContent = pj.root ? pj.root.name : '';
    dom.reconnect.hidden = !pj.pendingHandle;
    if (pj.pendingHandle) dom.reconnect.textContent = `Reconnect “${pj.pendingHandle.name}”`;
    const has = Boolean(pj.root && pj.project);
    for (const b of [dom.pack, dom.write, dom.addLib, dom.addMap, dom.addFile]) b.disabled = !has || pj.busy;
    dom.open.disabled = pj.busy;
    dom.status.textContent = pj.root ? (pj.project ? `${pj.assets.length} assets · ${pj.parts.length} parts · ${pj.layout.filter((c) => c.items.length).length} data carts` : 'not a suite project yet') : '';
    renderStages();
    renderAdopt();
    renderParts();
    renderStacks();
    renderReport();
  }

  function renderAdopt() {
    const plan = pj.adoptPlan;
    dom.adopt.hidden = !(pj.root && !pj.project);
    if (dom.adopt.hidden) return;
    dom.adopt.replaceChildren(...[
      el('h3', { textContent: 'Adopt this demo' }),
      el('p', { textContent: plan && plan.assets.length ? `The suite found ${plan.assets.length} pieces of data in ${plan.sourceCarts.length} carts (${plan.sourceCarts.join(', ')}), read by ${plan.edits.length} reload() lines. Adopting stores them as assets, marks those lines with --@data anchors and packs new carts. The demo runs the same.` : 'No reload() of a data cart found in demo/.' }),
      plan?.skipped.length ? el('p', { className: 'muted', textContent: `Left as they are: ${plan.skipped.map((s) => `${s.file}:${s.line} (${s.why})`).join('; ')}` }) : null,
      plan?.keptCarts.length ? el('p', { className: 'muted', textContent: `Still read by lines left as they are, so they stay in demo/: ${plan.keptCarts.join(', ')}` }) : null,
      plan?.assets.length ? el('button', { className: 'btn btn-primary', type: 'button', textContent: 'Adopt', disabled: pj.busy, onclick: () => exclusive('Adopt', adoptNow) }) : null,
    ].filter(Boolean));
  }

  function anchorsByRef() {
    const m = new Map();
    const add = (ref, v) => { if (!m.has(ref)) m.set(ref, []); m.get(ref).push(v); };
    for (const f of anchorFiles()) {
      for (const a of P.findAnchors(f.text)) {
        if (!a.set && !a.ref) continue; // malformed beyond its name: reported by the check
        if (a.set) { for (const p of pj.parts) if (p.set === a.set) add(p.ref, { file: f.name, line: a.line + 1, lz: false, set: true }); } else add(a.ref, { file: f.name, line: a.line + 1, lz: a.lz, ranged: a.ranged });
      }
    }
    return m;
  }

  const KIND_TEXT = { img: 'image', pal: 'palette / fades', hex: 'data' };

  function renderParts() {
    if (!pj.project) { dom.parts.replaceChildren(el('p', { className: 'muted', textContent: pj.root ? 'Adopt the demo first.' : 'Open a demo project folder (outside AppData), e.g. a copy of demoframe.' })); return; }
    const anchors = anchorsByRef();
    const isPlaced = placed();
    const out = [];
    let lastAsset = null;
    for (const p of pj.parts) {
      const a = p.asset;
      if (a !== lastAsset) {
        lastAsset = a;
        out.push(el('div', { className: 'cb-asset' },
          el('strong', { textContent: a.name, title: a.meta?.from || '' }),
          el('span', { className: 'muted', textContent: a.type === 'cartset' ? `cart set · ${Object.keys(a.parts).length} carts read by one reload() (list ${a.meta?.list || '?'})` : a.type }),
          el('button', { className: 'btn btn-sm', type: 'button', textContent: 'Rename', dataset: { rename: a.name } })));
      }
      const an = anchors.get(p.ref) || [];
      const lzOk = !p.set && an.length > 0 && an.every((x) => x.lz && !x.ranged);
      const segs = a.meta?.segments?.[p.id] || [];
      out.push(el('div', { className: `cb-part${isPlaced.has(p.ref) ? '' : ' unplaced'}`, draggable: true, dataset: { ref: p.ref } },
        el('i', { className: 'cb-dot', style: `background:${TYPE_COLOR[a.type] || TYPE_COLOR.table}` }),
        el('span', { className: 'cb-ref', textContent: `.${p.id}${p.set && segs[0]?.from ? ` (${segs[0].from})` : ''}` }),
        el('span', { className: 'muted', textContent: p.lz ? `${kb(p.bytes.length)} (LZ of ${kb(p.raw)})` : kb(p.bytes.length) }),
        el('span', { className: an.length ? 'muted' : 'cb-warn', textContent: an.length ? `${an.length} anchor${an.length > 1 ? 's' : ''}: ${[...new Set(an.map((x) => `${x.file}:${x.line}`))].join(', ')}` : 'no anchor yet', title: an.length ? '' : `Add  --@data ${p.ref}  at the end of the reload() line that loads it` }),
        segs.length ? el('div', { className: 'cb-segs' }, ...segs.map((g, k) => el('div', { className: 'cb-seg' },
          el('span', { textContent: `${g.name}`, title: `${hex(g.off)}–${hex(g.off + g.len - 1)}${g.fx ? ` · used by ${g.fx}` : ''}` }),
          el('span', { className: 'muted', textContent: `${KIND_TEXT[g.kind] || g.kind} · ${hex(g.off)} +${kb(g.len)}` }),
          g.kind !== 'hex' ? el('span', { className: 'cb-seg-tools' },
            el('button', { className: 'btn btn-sm', type: 'button', textContent: '→ Library', title: g.kind === 'img' ? 'Image in its palette (and fades) to the library: open it in Pixel Studio, Palette & Fades or Tile Maker' : 'The palette (row 0) to the library', dataset: { segout: p.ref, seg: String(k) } }),
            el('button', { className: 'btn btn-sm', type: 'button', textContent: '← Library', title: g.kind === 'img' ? 'Replace the image with a library image of the same size' : 'Replace the palette (row 0) with a library palette', dataset: { segin: p.ref, seg: String(k) } })) : null))) : null,
        el('span', { className: 'cb-part-tools' },
          el('label', { className: 'check', title: p.set ? 'Cart sets stay raw (one reload() reads every cart of the set)' : lzOk ? 'Store LZ-packed (the anchored lines call unlz)' : an.some((x) => x.ranged) ? 'LZ needs whole-part anchors: unlz() cannot unpack a +offset range of the packed stream' : 'LZ needs anchored lines of the form  reload(tmp,…) unlz(tmp,dest)' },
            el('input', { type: 'checkbox', checked: p.lz, disabled: p.set || (!lzOk && !p.lz), dataset: { lz: p.ref } }), el('span', { textContent: 'LZ' })),
          el('button', { className: 'btn btn-sm', type: 'button', textContent: 'Move…', disabled: pj.busy, title: 'Choose the cart for this part without dragging', attrs: { 'aria-label': `Move ${p.ref} to a cart` }, dataset: { move: p.ref } }),
          p.set ? null : el('button', { className: 'btn btn-sm', type: 'button', textContent: 'Line', title: 'Copy a reload() line with the anchor for this part', dataset: { line: p.ref } }))));
    }
    dom.parts.replaceChildren(...out);
  }

  // region bands of a cart (bytes)
  const BANDS = C.REGIONS.map((r) => ({ name: r.name.split(' ')[0], start: r.start, end: Math.min(r.end, P.CART) }));

  function renderStacks() {
    if (!pj.project) { dom.stacks.replaceChildren(); return; }
    const col = (c, label) => {
      const used = c ? cartUsed(c) : 0;
      const items = c ? c.items : pj.parts.filter((p) => !placed().has(p.ref)).map((p) => ({ ref: p.ref, off: null }));
      let y = 0;
      return el('div', { className: 'cb-stack', dataset: { cart: c ? c.name : '' } },
        el('div', { className: 'cb-stack-head' }, el('strong', { textContent: label }), el('span', { className: used > P.CART ? 'cb-warn' : 'muted', textContent: c ? `${Math.round((used / P.CART) * 100)}% · ${kb(P.CART - used)} free` : `${items.length} parts` })),
        el('div', { className: 'cb-bar' },
          ...(c ? BANDS.map((b) => el('i', { className: 'cb-band', style: `top:${(b.start / P.CART) * 100}%;height:${((b.end - b.start) / P.CART) * 100}%`, title: b.name })) : []),
          ...items.map((it) => {
            const p = partOf(it.ref);
            const top = c ? it.off : y;
            if (!c) y += p.bytes.length;
            return el('div', {
              className: `cb-block${p.set ? ' cb-setpart' : ''}`, draggable: true, dataset: { ref: it.ref },
              style: `top:${(top / P.CART) * 100}%;height:${(Math.min(p.bytes.length, P.CART) / P.CART) * 100}%;--c:${TYPE_COLOR[p.asset.type] || TYPE_COLOR.table}`,
              title: `${it.ref}\n${c ? `${c.name} ${hex(it.off)}–${hex(it.off + p.bytes.length - 1)}` : 'not placed'} · ${p.bytes.length} bytes${p.set ? '\ncart set: always at offset 0, one per cart' : ''}`,
            }, el('span', { textContent: it.ref }));
          })));
    };
    // carts other tools make (music: mod2pico, tracks: rocket): shown, never written here
    const ext = externalCarts();
    dom.stacks.replaceChildren(
      ...pj.layout.map((c) => col(c, c.name)),
      el('div', { className: 'cb-stack cb-new', dataset: { cart: '+' } }, el('div', { className: 'cb-stack-head' }, el('strong', { textContent: 'New cart' }), el('span', { className: 'muted', textContent: 'drop here' })), el('div', { className: 'cb-bar' })),
      pj.parts.some((p) => !placed().has(p.ref)) ? col(null, 'Not placed') : null,
      ext.length ? el('div', { className: 'cb-stack cb-ext' },
        el('div', { className: 'cb-stack-head' }, el('strong', { textContent: 'Made by other tools' }), el('span', { className: 'muted', textContent: `${ext.length} carts, not packed here` })),
        el('div', { className: 'cb-extlist' }, ...ext.map((x) => el('div', { title: x.why }, el('code', { textContent: x.name }), el('span', { className: 'muted', textContent: ` ${x.kind} · ${kb(x.used)}` }))))) : null);
  }

  /** carts in the demo the project does not pack: music (mod2pico), tracks (rocket), reloads with computed names */
  function externalCarts() {
    const own = new Set(pj.layout.map((c) => c.name.toLowerCase()));
    const out = [];
    for (const [name, text] of pj.texts) {
      const n = name.toLowerCase();
      if (own.has(n)) continue;
      const kind = P.isMusic(name) ? 'music (mod2pico)' : P.isTracks(name) ? 'tracks (rocket)' : null;
      if (!kind) continue;
      let used = 0;
      try { used = C.usedMask(C.parseP8(text).rom).reduce((s, v) => s + v, 0); } catch { /* unreadable */ }
      out.push({ name, kind, used, why: kind.startsWith('music') ? 'Generated from the .mod by music/convert.bat; the mod player streams it at runtime.' : 'Exported by rocket-interface (Export Tracks).' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  function renderReport() {
    if (!pj.project) { dom.report.replaceChildren(); return; }
    const { where, whereSet } = P.placements(pj.layout, pj.parts);
    const files = anchorFiles().map((f) => ({ name: f.name, text: P.rewriteAnchors(f.text, (ref) => where.get(ref), (n) => whereSet.get(n)).text }));
    const chk = P.checkAnchors(files, pj.parts, pj.layout);
    const carts = pj.layout.filter((c) => c.items.length);
    const used = carts.reduce((s, c) => s + cartUsed(c), 0);
    const pending = pj.dirtyAssets.size + pj.dirtyTexts.size;
    dom.report.replaceChildren(
      el('p', { textContent: `${carts.length} data carts · ${kb(used)} used of ${kb(carts.length * P.CART)} · ${chk.anchors.length} anchored reload() lines${pj.parts.some((p) => p.lz) ? ' · LZ parts need unlz() (60 tokens) once' : ''}${pending ? ` · ${pending} unsaved change${pending > 1 ? 's' : ''} (Write Carts saves them)` : ''}` }),
      ...chk.errors.map((e) => el('p', { className: 'cb-err', textContent: e })),
      ...chk.warnings.map((w) => el('p', { className: 'cb-warn', textContent: w })),
      !chk.errors.length && !chk.warnings.length ? el('p', { className: 'muted', textContent: 'Every part is anchored, every anchor has its part.' }) : null);
  }

  // ------------------------------------------------------------------ //
  // Renaming, segments                                                 //
  // ------------------------------------------------------------------ //

  async function renameAsset(from) {
    const a = pj.assets.find((x) => x.name === from);
    if (!a) return;
    const input = el('input', { type: 'text', value: a.name, spellcheck: false });
    const v = await modal({
      title: `Rename ${a.name}`,
      body: el('div', { className: 'dialog-form' }, el('p', { className: 'muted', textContent: 'The --@data anchors in the fx code are renamed with it (saved with Write Carts).' }), el('label', { className: 'field' }, el('span', { textContent: 'Name (letters, digits, _)' }), input)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', primary: true, value: () => input.value }], onOpen: () => input.select(),
    });
    const to = v == null ? null : P.safeName(v);
    if (!to || to === from) return;
    if (pj.assets.some((x) => x.name === to)) { showMessage('Rename', `There is already an asset “${to}”.`); return; }
    a.name = to;
    pj.renamed.set(to, pj.renamed.get(from) || from);
    pj.renamed.delete(from);
    pj.dirtyAssets.delete(from);
    pj.dirtyAssets.add(to);
    for (const [file, text] of pj.texts) {
      if (!text.includes('--@data')) continue;
      const t = P.renameInText(text, from, to);
      if (t !== text) { pj.texts.set(file, t); pj.dirtyTexts.add(file); }
    }
    for (const c of pj.layout) for (const it of c.items) if (it.ref.startsWith(`${from}.`)) it.ref = to + it.ref.slice(from.length);
    pj.parts = P.partsOf(pj.assets);
    render();
  }

  /** a 'pal' segment of the same asset (same fx first) -> fades for the library image */
  function segFades(a, partId, seg) {
    for (const [id, list] of Object.entries(a.meta?.segments || {})) {
      const t = list.find((g) => g.kind === 'pal' && (!seg.fx || g.fx === seg.fx));
      if (t) return V.fadeFromTable({ name: a.name, rom: a.parts[id].bytes }, { start: t.off, len: t.len });
    }
    return null;
  }

  async function segmentOut(ref, k) {
    const p = partOf(ref);
    const g = p.asset.meta.segments[p.id][k];
    const link = { asset: p.asset.name, part: p.id, seg: k };
    if (g.kind === 'img') {
      const { w, h, pixels } = P.segmentImage(p.asset, p.id, g);
      const fades = segFades(p.asset, p.id, g);
      const a = await S.assets.put(S.imageAsset({ name: `${p.asset.name} ${g.name}`, w, h, pixels, pal: g.pal || undefined, transparent: -1, source: 'cart-builder', meta: { link, ...(fades ? { fades } : {}) } })).catch((e) => S.reportStorageError('Segment to Library', e));
      if (!a) return;
      toast(`${a.name} is in the library (${w}×${h}${fades ? ', with its fades' : ''}). Edit it there, then “← Library” writes it back.`, 'info', 4000);
    } else {
      const row = Array.from(p.asset.parts[p.id].bytes.subarray(g.off, g.off + 16));
      if (!(await S.assets.put(S.paletteAsset({ name: `${p.asset.name} ${g.name}`, colors: row })).catch((e) => S.reportStorageError('Segment to Library', e)))) return;
      toast('The palette (row 0) is in the library.');
    }
  }

  async function segmentIn(ref, k) {
    const p = partOf(ref);
    const g = p.asset.meta.segments[p.id][k];
    let bytes;
    if (g.kind === 'img') {
      const w = g.w || 128;
      const h = Math.ceil((g.len * 2) / w);
      const a = await S.pickAsset({ title: `Image for ${p.asset.name} · ${g.name} (${w}×${h})`, filter: (x) => (x.w === w && x.h === h ? true : `needs ${w}×${h}`) });
      if (!a) return;
      bytes = P.imageBytes(a.pixels, w, h, g.len);
      if (a.pal) g.pal = Array.from(a.pal);
    } else {
      const a = await S.pickAsset({ title: `Palette for ${p.asset.name} · ${g.name} (row 0)`, kind: 'palette' });
      if (!a) return;
      bytes = new Uint8Array(p.asset.parts[p.id].bytes.subarray(g.off, g.off + g.len));
      a.colors.forEach((c, i) => { if (c != null) bytes[i] = c; });
    }
    const err = P.setSegment(p.asset, p.id, g, bytes);
    if (err) { showMessage('← Library', err); return; }
    pj.dirtyAssets.add(p.asset.name);
    syncLayout();
    render();
    toast(`${p.asset.name} · ${g.name} replaced. Write Carts puts it into the data carts.`);
  }

  // ------------------------------------------------------------------ //
  // Events                                                             //
  // ------------------------------------------------------------------ //

  function moveTo(ref, cartName) {
    const p = partOf(ref);
    const target = cartName && cartName !== '+' ? pj.layout.find((c) => c.name === cartName) : null;
    // cart-set parts sit at offset 0, one per cart (one reload() reads all of them there)
    if (p?.set && target && target.items.some((i) => i.ref !== ref && partOf(i.ref)?.set)) { toast('A cart can hold only one part of a cart set.', 'warn'); return; }
    for (const c of pj.layout) c.items = c.items.filter((i) => i.ref !== ref);
    if (cartName === '+') {
      const taken = new Set([...foreignCarts(), ...pj.layout.map((c) => c.name.toLowerCase())]);
      let n = 0;
      while (taken.has(`${pj.project.prefix || 'd'}${n}.p8`)) n++;
      pj.layout.push({ name: `${pj.project.prefix || 'd'}${n}.p8`, items: [{ ref }] });
    } else if (target) {
      if (p?.set) target.items.unshift({ ref }); else target.items.push({ ref });
    }
    pj.layout = pj.layout.filter((c) => c.items.length || c.name === cartName);
    repack();
    render();
  }

  function bind() {
    dom.open.addEventListener('click', openFolder);
    dom.reconnect.addEventListener('click', reconnect);
    dom.pack.addEventListener('click', autoPack);
    dom.write.addEventListener('click', () => exclusive('Write carts', writeAll));
    dom.addLib.addEventListener('click', addFromLibrary);
    dom.addMap.addEventListener('click', addMapFromLibrary);
    dom.addFile.addEventListener('click', addFile);
    document.querySelector('main[data-ws="cartbuilder"]').addEventListener('dragstart', (e) => {
      const b = e.target.closest('[data-ref]');
      if (b) e.dataTransfer.setData('text/x-p8part', b.dataset.ref);
    });
    dom.stacks.addEventListener('dragover', (e) => { if (e.target.closest('[data-cart]')) e.preventDefault(); });
    dom.stacks.addEventListener('drop', (e) => {
      if (pj.busy) return;
      const s = e.target.closest('[data-cart]');
      const ref = e.dataTransfer.getData('text/x-p8part');
      if (s && ref) { e.preventDefault(); moveTo(ref, s.dataset.cart); }
    });
    dom.parts.addEventListener('change', (e) => {
      const ref = e.target.dataset.lz;
      if (!ref) return;
      if (pj.busy) { e.target.checked = !e.target.checked; return; }
      const p = partOf(ref);
      const ranged = (anchorsByRef().get(ref) || []).filter((x) => x.ranged);
      if (e.target.checked && ranged.length) {
        e.target.checked = false;
        showMessage('LZ', `${ref} is read as a +offset range by ${ranged.map((x) => `${x.file}:${x.line}`).join(', ')}. unlz() can only unpack the whole packed stream, so this part stays raw.`);
        return;
      }
      p.asset.parts[p.id].lz = e.target.checked;
      pj.dirtyAssets.add(p.asset.name);
      syncLayout();
      render();
    });
    dom.parts.addEventListener('click', async (e) => {
      const d = e.target.dataset || {};
      if (pj.busy && (d.rename || d.segin)) { showMessage('Cart Builder', 'Wait until the current write has finished.'); return; }
      if (d.move) return movePartDialog(d.move);
      if (d.rename) return renameAsset(d.rename);
      if (d.segout) return segmentOut(d.segout, Number(d.seg));
      if (d.segin) return segmentIn(d.segin, Number(d.seg));
      const ref = d.line;
      if (!ref) return;
      const where = P.placements(pj.layout, pj.parts).where.get(ref);
      const p = partOf(ref);
      const line = p.lz
        ? `reload(tmp,${hex(where?.off ?? 0)},${hex(p.bytes.length)},"${where?.cart || '?'}") unlz(tmp,dest) --@data ${ref}`
        : `reload(dest,${hex(where?.off ?? 0)},${hex(p.bytes.length)},"${where?.cart || '?'}") --@data ${ref}`;
      try { await navigator.clipboard.writeText(line); toast(`Copied: ${line}`); } catch { showMessage('reload() line', line); }
    });
    document.addEventListener('p8:workspace', () => { if (document.body.dataset.workspace === 'cartbuilder') restore(); });
  }

  S.registerTool({ ws: 'cartbuilder', category: 'develop', name: 'Cart Builder', desc: 'A demo project folder: its data as assets, packed into data carts (drag or auto-pack); the fx find their data through --@data anchors.', tasks: [{ group: 'edit', label: 'Pack data carts', hint: 'Needs a project folder (Chrome or Edge)' }], color: '#00e436', tags: ['project', 'pack', 'reload'] });

  // folder handles can also come from elsewhere (tests, drag & drop)
  window.P8CartBuilder = { useFolder };

  bind();
  render();
})();
