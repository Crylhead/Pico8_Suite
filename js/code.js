// js/code.js
// Code Editor workspace: edits the __lua__ section of a PICO-8 cart (or a .lua file) and saves
// it back into the file, leaving gfx / map / sound untouched. A transparent textarea does the
// typing (selection, IME, native undo); a layer below it draws the highlighted visible lines,
// the current line, matching brackets, the word under the caret and find matches.

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const K = P8Code;
  const A = P8Audit;
  const { el, $, modal, showMessage, confirmDialog, toast, download, pickFile, formField, store } = App;

  const SESSION_KEY = 'code.session';
  const SETTINGS_KEY = 'p8suite.code';
  const TOKEN_LIMIT = 8192;
  const CHAR_LIMIT = 65535;
  const PAD = 8;            // px around the text
  const OVERSCAN = 12;      // lines rendered above / below the visible ones
  const FILE_TYPES = [{ description: 'PICO-8 cart or Lua', accept: { 'text/plain': ['.p8', '.lua'] } }];

  const saved = store.get(SETTINGS_KEY, {}) || {};
  const set = {
    fontSize: Math.max(10, Math.min(28, saved.fontSize || 14)),
    upper: Boolean(saved.upper),
    indent: ['\t', ' ', '  '].includes(saved.indent) ? saved.indent : ' ',
  };
  const persist = () => store.set(SETTINGS_KEY, set);

  const ed = {
    name: 'untitled.p8',
    parts: K.splitCart(K.NEW_CART),
    handle: null,           // FileSystemFileHandle when the browser lets us write back
    savedLua: '',
    doc: {},                // identity of the open document (a new object on every load)
    baseLua: null,          // the file's Lua when opened / last saved: external Lua edits are detected against it
    text: '',
    tokens: [],
    lines: [],              // per line: [[type, text], ...]
    lineStarts: [0],
    pairs: new Map(),
    names: new Set(),
    tokenCount: 0,
    find: { open: false, q: '', matches: [], cur: -1 },
    complete: null,         // {items, sel, from}
    folder: null,           // FileSystemDirectoryHandle of "Open Folder…"
    folderReady: false,     // permission granted (after a page reload it has to be asked again)
    files: new Map(),       // relative path (lower case) -> {rel, handle}
    rel: null,              // the open file's path inside the folder
    parent: null,           // {rel, name}: the cart this include was opened from
    incs: [],               // P8Audit.includeMeter items: [{line, path, tab, rel, found, cycle, depth, missing, tokens, warnings}]
    incTokens: 0,
    fileCache: new Map(),   // rel -> {stamp, text}
  };

  const dom = {
    editor: $('#ceEditor'),
    view: $('#ceView'),
    layer: $('#ceLayer'),
    ta: $('#ceText'),
    gutter: $('#ceGutter'),
    tabs: $('#ceTabs'),
    file: $('#ceFile'),
    pos: $('#cePos'),
    tabInfo: $('#ceTabInfo'),
    tokens: $('#ceTokens'),
    chars: $('#ceChars'),
    outline: $('#ceOutline'),
    outlineFilter: $('#ceOutlineFilter'),
    outlineCount: $('#ceOutlineCount'),
    cartInfo: $('#ceCartInfo'),
    gfxBtn: $('#ceGfxBtn'),
    mapBtn: $('#ceMapBtn'),
    complete: $('#ceComplete'),
    sig: $('#ceSig'),
    find: $('#ceFind'),
    findIn: $('#ceFindIn'),
    findCount: $('#ceFindCount'),
    findCase: $('#ceFindCase'),
    findWord: $('#ceFindWord'),
    replRow: $('#ceReplRow'),
    replIn: $('#ceReplIn'),
    back: $('#ceBack'),
    run: $('#ceRun'),
    stop: $('#ceStop'),
    output: $('#ceOutput'),
    outLog: $('#ceOutLog'),
    runInfo: $('#ceRunInfo'),
    files: $('#ceFiles'),
    folderName: $('#ceFolderName'),
    includes: $('#ceIncludes'),
  };

  // ------------------------------------------------------------------ //
  // Metrics                                                            //
  // ------------------------------------------------------------------ //

  let charW = 8;
  let lineH = 20;

  function applyFont() {
    lineH = Math.round(set.fontSize * 1.5);
    dom.editor.style.setProperty('--ce-font', `${set.fontSize}px`);
    dom.editor.style.setProperty('--ce-line', `${lineH}px`);
    dom.editor.style.setProperty('--ce-pad', `${PAD}px`);
    dom.editor.classList.toggle('ce-upper', set.upper);
    const probe = el('span', { className: 'ce-probe', textContent: 'M'.repeat(100) });
    dom.layer.append(probe);
    charW = probe.getBoundingClientRect().width / 100 || set.fontSize * 0.6;
    probe.remove();
  }

  /** column -> x, with tabs (tab-size 2, as in the CSS) */
  function colX(line, col) {
    const t = ed.text.slice(ed.lineStarts[line], ed.lineStarts[line] + col);
    let v = 0;
    for (const ch of t) v = ch === '\t' ? v + 2 - (v % 2) : v + 1;
    return PAD + v * charW;
  }

  function lineOf(off) {
    let lo = 0;
    let hi = ed.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ed.lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // ------------------------------------------------------------------ //
  // Analysis (lex the whole text; cheap for cart-sized code)           //
  // ------------------------------------------------------------------ //

  function analyze() {
    const text = dom.ta.value;
    ed.text = text;
    ed.tokens = K.lex(text);
    ed.lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) ed.lineStarts.push(i + 1);
    const lines = ed.lineStarts.map(() => []);
    let ln = 0;
    for (const tk of ed.tokens) {
      let s = tk.s;
      while (s < tk.e) {
        const nl = text.indexOf('\n', s);
        const e = nl < 0 || nl >= tk.e ? tk.e : nl;
        if (e > s) lines[ln].push([tk.t, text.slice(s, e), s]);
        if (e < tk.e && text[e] === '\n') { ln++; s = e + 1; } else s = e;
      }
    }
    ed.lines = lines;
    ed.pairs = K.bracketPairs(ed.tokens, text);
    ed.names = K.identifiers(ed.tokens, text);
    scheduleCount();
  }

  // token count is the slowest part: a moment after typing stops
  let countTimer = 0;
  function scheduleCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      try { ed.tokenCount = A.countTokens(ed.text); } catch { ed.tokenCount = NaN; }
      renderMeters();
    }, 250);
  }

  // ------------------------------------------------------------------ //
  // Rendering                                                          //
  // ------------------------------------------------------------------ //

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let frame = 0;
  const requestRender = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };

  function render() {
    if (document.body.dataset.workspace !== 'code') return;
    const top = dom.ta.scrollTop;
    const left = dom.ta.scrollLeft;
    const h = dom.view.clientHeight;
    const first = Math.max(0, Math.floor((top - PAD) / lineH) - OVERSCAN);
    const last = Math.min(ed.lines.length - 1, Math.ceil((top + h) / lineH) + OVERSCAN);
    const caret = dom.ta.selectionStart;
    const caretLine = lineOf(caret);
    const marks = [];
    const box = (line, c0, c1, cls) => {
      const x = colX(line, c0);
      marks.push(`<div class="${cls}" style="top:${PAD + line * lineH}px;left:${x}px;width:${Math.max(2, colX(line, c1) - x)}px"></div>`);
    };
    // current line
    marks.push(`<div class="ce-curline" style="top:${PAD + caretLine * lineH}px"></div>`);
    // find matches
    if (ed.find.open) {
      ed.find.matches.forEach(([s, e], i) => {
        const l = lineOf(s);
        if (l >= first && l <= last) box(l, s - ed.lineStarts[l], e - ed.lineStarts[l], i === ed.find.cur ? 'ce-mark ce-find-cur' : 'ce-mark ce-find-hit');
      });
    }
    // brackets at the caret
    for (const at of [caret, caret - 1]) {
      const other = ed.pairs.get(at);
      if (other == null) continue;
      for (const o of [at, other]) { const l = lineOf(o); box(l, o - ed.lineStarts[l], o - ed.lineStarts[l] + 1, 'ce-mark ce-bracket'); }
      break;
    }
    // the word under the caret, everywhere it is visible
    const word = wordAt(caret);
    if (word && dom.ta.selectionStart === dom.ta.selectionEnd) {
      for (let l = first; l <= last; l++) {
        for (const [t, s, off] of ed.lines[l]) {
          if ((t === 'ident' || t === 'api' || t === 'self' || t === 'callback') && s === word.text) box(l, off - ed.lineStarts[l], off - ed.lineStarts[l] + s.length, 'ce-mark ce-same');
        }
      }
    }
    // text
    const rows = [];
    for (let l = first; l <= last; l++) {
      let html = '';
      for (const [t, s] of ed.lines[l]) html += t === 'ws' || t === 'ident' ? esc(s) : `<span class="t-${t}">${esc(s)}</span>`;
      rows.push(`<div class="ce-row${ed.lines[l][0]?.[0] === 'tabsep' ? ' ce-tabrow' : ''}" style="top:${PAD + l * lineH}px">${html}</div>`);
    }
    dom.layer.innerHTML = marks.join('') + rows.join('');
    dom.layer.style.transform = `translate(${-left}px,${-top}px)`;
    dom.layer.style.height = `${PAD * 2 + ed.lines.length * lineH}px`;
    // gutter
    const g = [];
    for (let l = first; l <= last; l++) g.push(`<div class="ce-ln${l === caretLine ? ' cur' : ''}" style="top:${PAD + l * lineH}px">${l + 1}</div>`);
    dom.gutter.innerHTML = g.join('');
    dom.gutter.style.transform = `translateY(${-top}px)`;
    dom.gutter.parentElement.style.width = `${Math.max(3, String(ed.lines.length).length) * charW + 18}px`;
    positionPopups();
  }

  function renderCaretInfo() {
    const c = dom.ta.selectionStart;
    const l = lineOf(c);
    const selLen = Math.abs(dom.ta.selectionEnd - dom.ta.selectionStart);
    dom.pos.textContent = `Ln ${l + 1}, Col ${c - ed.lineStarts[l] + 1}${selLen ? ` · ${selLen} selected` : ''}`;
    const tabs = K.codeTabs(ed.text);
    const cur = [...tabs].reverse().find((t) => t.line <= l) || tabs[0];
    dom.tabInfo.textContent = tabs.length > 1 ? `tab ${cur.index}` : '';
    for (const b of dom.tabs.querySelectorAll('[data-tab]')) b.setAttribute('aria-current', String(Number(b.dataset.tab) === cur.index));
    renderSig();
  }

  function renderMeters() {
    const n = ed.tokenCount;
    const meter = (node, v, max, label) => {
      const pct = Math.min(100, (v / max) * 100);
      node.textContent = `${Number.isFinite(v) ? v : '?'} / ${max} ${label}`;
      node.style.setProperty('--pct', `${pct}%`);
      node.dataset.level = v > max ? 'over' : pct > 90 ? 'high' : '';
    };
    // PICO-8 counts the included code too
    const withInc = n + ed.incTokens;
    const missing = ed.incs.filter((i) => !i.found).length;
    meter(dom.tokens, withInc, TOKEN_LIMIT, !ed.incs.length ? 'tokens'
      : missing === ed.incs.length ? `tokens (${missing} include${missing > 1 ? 's' : ''} not counted)`
        : `tokens (${n} here + ${ed.incTokens} included${missing ? `, ${missing} not found` : ''})`);
    meter(dom.chars, ed.text.length, CHAR_LIMIT, 'chars');
  }

  function renderStructure() {
    // code tabs
    const tabs = K.codeTabs(ed.text);
    dom.tabs.replaceChildren(...tabs.map((t) => el('button', { type: 'button', className: 'ce-tab', dataset: { tab: String(t.index), line: String(t.line) }, title: t.label ? `${t.index}: ${t.label}` : `tab ${t.index}`, textContent: String(t.index) })),
      el('button', { type: 'button', className: 'ce-tab ce-tab-add', dataset: { action: 'code-new-tab' }, title: 'New code tab (-->8)', textContent: '+' }));
    // outline
    const q = dom.outlineFilter.value.trim().toLowerCase();
    const fns = K.outline(ed.text);
    const shown = fns.filter((f) => !q || f.name.toLowerCase().includes(q));
    dom.outlineCount.textContent = String(fns.length);
    dom.outline.replaceChildren(...(shown.length ? shown.map((f) => el('button', { type: 'button', className: 'ce-fn', dataset: { line: String(f.line) }, title: `line ${f.line + 1}` },
      el('span', { className: f.local ? 'ce-fn-name local' : 'ce-fn-name', textContent: f.name }), el('span', { className: 'ce-fn-args', textContent: `(${f.args})` }))) : [el('p', { className: 'muted', textContent: fns.length ? 'No match.' : 'No functions yet.' })]));
    // cart
    const p = ed.parts;
    const lines = p.head == null
      ? ['Lua file: saved as plain code.']
      : [`Sections: lua${p.sections.length ? `, ${p.sections.join(', ')}` : ''}`, 'Saving changes only __lua__; the other sections stay byte for byte.'];
    lines.push(ed.handle ? 'Saves straight into the file.' : window.showSaveFilePicker ? 'Save asks where to write it (Open… a file to save in place).' : 'Save downloads the cart (this browser cannot write files).');
    dom.cartInfo.replaceChildren(...lines.map((t) => el('span', { textContent: t })));
    dom.gfxBtn.disabled = !p.sections.includes('gfx');
    dom.mapBtn.disabled = !p.sections.includes('map') && !p.sections.includes('gfx');
    dom.back.hidden = !ed.parent;
    if (ed.parent) dom.back.textContent = `← ${ed.parent.name}`;
    renderFiles();
    resolveIncludes();
    renderTitle();
  }

  const dirty = () => ed.text !== ed.savedLua;
  function renderTitle() {
    dom.file.textContent = `${ed.name}${dirty() ? ' •' : ''}`;
    dom.file.title = dirty() ? 'Unsaved changes' : 'Saved';
  }

  let structTimer = 0;
  function changed() {
    analyze();
    requestRender();
    renderCaretInfo();
    renderTitle();
    clearTimeout(structTimer);
    structTimer = setTimeout(() => { renderStructure(); saveSession(); }, 300);
    if (ed.find.open) runFind(false);
  }

  // ------------------------------------------------------------------ //
  // Editing helpers (execCommand keeps the browser's undo history)     //
  // ------------------------------------------------------------------ //

  function replaceRange(s, e, text, selS = null, selE = null) {
    const ta = dom.ta;
    ta.focus();
    ta.setSelectionRange(s, e);
    if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, s, e, 'end');
    if (selS != null) ta.setSelectionRange(selS, selE ?? selS);
    // an edit made inside an input handler fires no second input event
    if (ta.value !== ed.text) changed();
  }

  /** whole lines touched by the selection -> {s, e (end of last line), first, last} */
  function selLines() {
    const ta = dom.ta;
    const first = lineOf(ta.selectionStart);
    let endOff = ta.selectionEnd;
    if (endOff > ta.selectionStart && ed.text[endOff - 1] === '\n') endOff--;
    const last = lineOf(endOff);
    const s = ed.lineStarts[first];
    const e = last + 1 < ed.lineStarts.length ? ed.lineStarts[last + 1] - 1 : ed.text.length;
    return { s, e, first, last };
  }

  const indentOf = (line) => /^[ \t]*/.exec(line)[0];
  const lineText = (l) => ed.text.slice(ed.lineStarts[l], l + 1 < ed.lineStarts.length ? ed.lineStarts[l + 1] - 1 : ed.text.length);

  function indentLines(dir) {
    const r = selLines();
    const lines = ed.text.slice(r.s, r.e).split('\n');
    const unit = set.indent;
    const out = lines.map((l) => {
      if (dir > 0) return l.length ? unit + l : l;
      if (l.startsWith(unit)) return l.slice(unit.length);
      return l.replace(/^[ \t]/, '');
    });
    const text = out.join('\n');
    replaceRange(r.s, r.e, text, r.s, r.s + text.length);
  }

  function toggleComment() {
    const r = selLines();
    const lines = ed.text.slice(r.s, r.e).split('\n');
    const code = lines.filter((l) => l.trim());
    const all = code.length && code.every((l) => /^\s*--/.test(l));
    const minIndent = Math.min(...code.map((l) => indentOf(l).length));
    const out = lines.map((l) => {
      if (!l.trim()) return l;
      return all ? l.replace(/^(\s*)-- ?/, '$1') : `${l.slice(0, minIndent)}-- ${l.slice(minIndent)}`;
    });
    const text = out.join('\n');
    replaceRange(r.s, r.e, text, r.s, r.s + text.length);
  }

  function duplicateLines() {
    const r = selLines();
    const block = ed.text.slice(r.s, r.e);
    const caret = dom.ta.selectionStart + block.length + 1;
    replaceRange(r.e, r.e, `\n${block}`, caret);
  }

  function moveLines(dir) {
    const r = selLines();
    if ((dir < 0 && r.first === 0) || (dir > 0 && r.last >= ed.lineStarts.length - 1)) return;
    const block = ed.text.slice(r.s, r.e);
    const caretOff = dom.ta.selectionStart - r.s;
    if (dir < 0) {
      const ps = ed.lineStarts[r.first - 1];
      const prev = ed.text.slice(ps, r.s - 1);
      replaceRange(ps, r.e, `${block}\n${prev}`, ps + caretOff);
    } else {
      const ne = r.last + 2 < ed.lineStarts.length ? ed.lineStarts[r.last + 2] - 1 : ed.text.length;
      const next = ed.text.slice(r.e + 1, ne);
      replaceRange(r.s, ne, `${next}\n${block}`, r.s + next.length + 1 + caretOff);
    }
  }

  function newline() {
    const ta = dom.ta;
    const s = ta.selectionStart;
    const l = lineOf(s);
    const before = ed.text.slice(ed.lineStarts[l], s);
    let indent = indentOf(lineText(l));
    if (indent.length > before.length) indent = indent.slice(0, before.length);
    if (K.opensBlock(before)) indent += set.indent;
    // between brackets: open an indented line and put the closer below it
    const closer = ed.pairs.get(s);
    if (closer != null && closer === s && ed.pairs.get(s - 1) == null && '({['.includes(ed.text[s - 1]) && ')}]'.includes(ed.text[s])) {
      const base = indentOf(lineText(l));
      replaceRange(s, ta.selectionEnd, `\n${indent}\n${base}`, s + 1 + indent.length);
      return;
    }
    replaceRange(s, ta.selectionEnd, `\n${indent}`);
  }

  /** after typing: "end" / "else" / "until" / closers move back to their block's indentation */
  function autoDedent() {
    const ta = dom.ta;
    const s = ta.selectionStart;
    const l = lineOf(s);
    if (l === 0) return;
    const line = lineText(l);
    if (!/^\s*(end|else|elseif|until|[)}\]])$/.test(line.slice(0, s - ed.lineStarts[l]).replace(/\s+$/, '')) || !K.DEDENT.test(line)) return;
    let p = l - 1;
    while (p > 0 && !lineText(p).trim()) p--;
    const prev = lineText(p);
    const base = indentOf(prev);
    const target = K.opensBlock(prev) ? base : base.slice(0, Math.max(0, base.length - set.indent.length));
    const cur = indentOf(line);
    if (cur.length <= target.length) return;
    const ls = ed.lineStarts[l];
    replaceRange(ls, ls + cur.length, target, s - (cur.length - target.length));
  }

  // auto-closing brackets and quotes; typing a closer over the same closer just steps over it
  const CLOSE = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
  function autoPair(e) {
    const ta = dom.ta;
    const s = ta.selectionStart;
    const next = ed.text[s] || '';
    const ch = e.key;
    if (')]}"\''.includes(ch) && next === ch && ta.selectionStart === ta.selectionEnd) {
      const inString = (ch === '"' || ch === "'") && tokenAt(s)?.t === 'string';
      if (ch === ')' || ch === ']' || ch === '}' || inString) { ta.setSelectionRange(s + 1, s + 1); return true; }
    }
    if (!CLOSE[ch]) return false;
    const tk = tokenAt(s - 1);
    if (tk && (tk.t === 'string' || tk.t === 'comment') && s < tk.e) return false;
    if (ta.selectionStart !== ta.selectionEnd) {
      // wrap the selection
      const sel = ed.text.slice(ta.selectionStart, ta.selectionEnd);
      replaceRange(ta.selectionStart, ta.selectionEnd, ch + sel + CLOSE[ch], s + 1, s + 1 + sel.length);
      return true;
    }
    if (next && !/[\s)\]},;]/.test(next)) return false;
    if ((ch === '"' || ch === "'") && /\w/.test(ed.text[s - 1] || '')) return false;
    replaceRange(s, s, ch + CLOSE[ch], s + 1);
    return true;
  }

  function tokenAt(off) {
    let lo = 0;
    let hi = ed.tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = ed.tokens[mid];
      if (off < t.s) hi = mid - 1; else if (off >= t.e) lo = mid + 1; else return t;
    }
    return null;
  }

  function wordAt(off) {
    const t = tokenAt(off) || tokenAt(off - 1);
    if (!t || !['ident', 'api', 'self', 'callback'].includes(t.t)) return null;
    return { s: t.s, e: t.e, text: ed.text.slice(t.s, t.e) };
  }

  // ------------------------------------------------------------------ //
  // Completion + signature help                                        //
  // ------------------------------------------------------------------ //

  function openComplete(force = false) {
    const ta = dom.ta;
    const s = ta.selectionStart;
    const m = /[A-Za-z_][\w]*$/.exec(ed.text.slice(Math.max(0, s - 40), s));
    const prefix = m ? m[0] : '';
    const tk = tokenAt(s - 1);
    if ((!force && prefix.length < 2) || (tk && (tk.t === 'string' || tk.t === 'comment'))) { closeComplete(); return; }
    const lower = prefix.toLowerCase();
    const seen = new Set();
    const items = [];
    const addAll = (names, kind) => {
      for (const n of names) {
        if (seen.has(n) || n === prefix || !n.toLowerCase().startsWith(lower)) continue;
        seen.add(n);
        items.push({ name: n, kind });
      }
    };
    addAll([...ed.names].sort(), 'name');
    addAll(K.API_NAMES, 'api');
    addAll([...K.KEYWORDS].sort(), 'keyword');
    items.sort((a, b) => (b.name.startsWith(prefix) - a.name.startsWith(prefix)) || a.name.length - b.name.length || a.name.localeCompare(b.name));
    if (!items.length) { closeComplete(); return; }
    ed.complete = { items: items.slice(0, 40), sel: 0, from: s - prefix.length };
    renderComplete();
  }

  function renderComplete() {
    const c = ed.complete;
    if (!c) { dom.complete.hidden = true; return; }
    dom.complete.replaceChildren(...c.items.map((it, i) => el('div', {
      className: `ce-item${i === c.sel ? ' sel' : ''}`, dataset: { i: String(i) }, attrs: { role: 'option', 'aria-selected': String(i === c.sel) },
    }, el('span', { className: `ce-item-name t-${it.kind === 'api' ? (K.CALLBACKS.has(it.name) ? 'callback' : 'api') : it.kind === 'keyword' ? 'keyword' : 'ident'}`, textContent: it.name }),
    el('span', { className: 'ce-item-doc', textContent: it.kind === 'api' ? K.API[it.name].sig.slice(it.name.length) : it.kind }))));
    dom.complete.hidden = false;
    dom.complete.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    positionPopups();
  }

  function closeComplete() { ed.complete = null; dom.complete.hidden = true; }

  function acceptComplete() {
    const c = ed.complete;
    if (!c) return;
    const it = c.items[c.sel];
    const s = dom.ta.selectionStart;
    closeComplete();
    replaceRange(c.from, s, it.name);
  }

  function renderSig() {
    const s = dom.ta.selectionStart;
    const tk = tokenAt(s - 1);
    const call = !(tk && tk.t === 'comment') && K.callAt(ed.text, s);
    const api = call && K.API[call.name];
    if (!api) { dom.sig.hidden = true; return; }
    // parameters with their optional flag: "x, y, [w, h,] [flip]" -> x y w? h? flip?
    const inner = api.sig.slice(api.sig.indexOf('(') + 1, api.sig.lastIndexOf(')'));
    const params = [];
    let depth = 0;
    for (const m of inner.matchAll(/\[|\]|[A-Za-z_][\w]*|\.\.\./g)) {
      if (m[0] === '[') depth++;
      else if (m[0] === ']') depth--;
      else params.push({ name: m[0], opt: depth > 0 });
    }
    const html = params.map((p, i) => {
      const t = p.opt ? `<i>${esc(p.name)}</i>?` : esc(p.name);
      return i === call.arg || (p.name === '...' && call.arg >= i) ? `<b>${t}</b>` : t;
    }).join(', ');
    dom.sig.innerHTML = `<span class="t-api">${esc(call.name)}</span>(${html}) <span class="muted">${esc(api.doc)}</span>`;
    dom.sig.hidden = false;
    dom.sig.dataset.open = String(call.open);
    positionPopups();
  }

  function positionPopups() {
    const s = dom.ta.selectionStart;
    const l = lineOf(s);
    const x = colX(l, s - ed.lineStarts[l]) - dom.ta.scrollLeft;
    const y = PAD + (l + 1) * lineH - dom.ta.scrollTop;
    const maxX = dom.view.clientWidth - 260;
    if (!dom.complete.hidden) {
      dom.complete.style.left = `${Math.max(4, Math.min(maxX, x - charW * ((s - (ed.complete?.from ?? s)))))}px`;
      dom.complete.style.top = `${y + 2}px`;
    }
    if (!dom.sig.hidden) {
      const o = Number(dom.sig.dataset.open);
      const ol = lineOf(o);
      const sx = colX(ol, o - ed.lineStarts[ol]) - dom.ta.scrollLeft;
      dom.sig.style.left = `${Math.max(4, Math.min(dom.view.clientWidth - 300, sx - 40))}px`;
      dom.sig.style.top = `${Math.max(2, PAD + ol * lineH - dom.ta.scrollTop - lineH - 8)}px`;
    }
  }

  // ------------------------------------------------------------------ //
  // Find / replace / go to                                             //
  // ------------------------------------------------------------------ //

  function openFind(replace = false) {
    ed.find.open = true;
    dom.find.hidden = false;
    dom.replRow.hidden = !replace;
    const sel = ed.text.slice(dom.ta.selectionStart, dom.ta.selectionEnd);
    if (sel && !sel.includes('\n')) dom.findIn.value = sel;
    dom.findIn.focus();
    dom.findIn.select();
    runFind(false);
  }

  function closeFind() {
    ed.find.open = false;
    dom.find.hidden = true;
    dom.ta.focus();
    requestRender();
  }

  function runFind(jump = true) {
    const q = dom.findIn.value;
    ed.find.matches = [];
    if (q) {
      const escq = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(dom.findWord.checked ? `\\b${escq}\\b` : escq, dom.findCase.checked ? 'g' : 'gi');
      for (const m of ed.text.matchAll(re)) ed.find.matches.push([m.index, m.index + m[0].length]);
    }
    const caret = dom.ta.selectionStart;
    ed.find.cur = ed.find.matches.findIndex(([s]) => s >= caret);
    if (ed.find.cur < 0 && ed.find.matches.length) ed.find.cur = 0;
    dom.findCount.textContent = q ? `${ed.find.matches.length ? ed.find.cur + 1 : 0} / ${ed.find.matches.length}` : '';
    if (jump && ed.find.cur >= 0) selectMatch();
    requestRender();
  }

  function stepFind(dir) {
    const n = ed.find.matches.length;
    if (!n) return;
    const caret = dom.ta.selectionStart;
    if (dir > 0) ed.find.cur = ed.find.matches.findIndex(([s]) => s > caret);
    else ed.find.cur = ed.find.matches.map(([s]) => s).findLastIndex((s) => s < caret);
    if (ed.find.cur < 0) ed.find.cur = dir > 0 ? 0 : n - 1;
    dom.findCount.textContent = `${ed.find.cur + 1} / ${n}`;
    selectMatch();
  }

  function selectMatch() {
    const [s, e] = ed.find.matches[ed.find.cur];
    dom.ta.setSelectionRange(s, e);
    revealLine(lineOf(s));
    requestRender();
    renderCaretInfo();
  }

  function replaceOne() {
    const m = ed.find.matches[ed.find.cur];
    if (!m) return;
    if (dom.ta.selectionStart !== m[0] || dom.ta.selectionEnd !== m[1]) { selectMatch(); return; }
    replaceRange(m[0], m[1], dom.replIn.value);
    runFind(true);
    dom.findIn.focus();
  }

  function replaceAll() {
    const ms = ed.find.matches;
    if (!ms.length) return;
    // one edit, so one undo step
    let out = '';
    let at = 0;
    for (const [s, e] of ms) { out += ed.text.slice(at, s) + dom.replIn.value; at = e; }
    out += ed.text.slice(at);
    replaceRange(0, ed.text.length, out, 0);
    toast(`Replaced ${ms.length}`);
    runFind(false);
  }

  async function gotoLine() {
    const input = el('input', { type: 'number', min: 1, max: ed.lineStarts.length, value: lineOf(dom.ta.selectionStart) + 1 });
    const n = await modal({
      title: 'Go to Line',
      body: el('div', { className: 'dialog-form' }, formField(`Line (1–${ed.lineStarts.length})`, input)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Go', primary: true, value: () => Number(input.value) }],
      onOpen: () => input.select(),
    });
    if (n) goLine(n - 1);
  }

  function goLine(l) {
    l = Math.max(0, Math.min(ed.lineStarts.length - 1, l));
    const s = ed.lineStarts[l] + indentOf(lineText(l)).length;
    dom.ta.focus();
    dom.ta.setSelectionRange(s, s);
    revealLine(l, true);
    renderCaretInfo();
    requestRender();
  }

  function revealLine(l, center = false) {
    const y = PAD + l * lineH;
    const h = dom.ta.clientHeight;
    if (center || y < dom.ta.scrollTop || y + lineH > dom.ta.scrollTop + h) dom.ta.scrollTop = Math.max(0, y - (center ? h / 3 : h / 2));
  }

  // ------------------------------------------------------------------ //
  // Files                                                              //
  // ------------------------------------------------------------------ //

  async function confirmDiscard(what) {
    if (!dirty()) return true;
    return confirmDialog('Unsaved Changes', `${what}\n\nThe code has changes that are not saved.`, 'Discard changes');
  }

  function load(text, name, handle = null, { rel = null, parent = null } = {}) {
    ed.parts = K.splitCart(text);
    ed.name = name;
    ed.handle = handle;
    ed.rel = rel;
    ed.parent = parent;
    ed.incs = [];
    ed.incTokens = 0;
    dom.ta.value = ed.parts.lua;
    ed.savedLua = ed.parts.lua;
    ed.doc = {};
    ed.baseLua = handle ? ed.parts.lua : null;
    dom.ta.setSelectionRange(0, 0);
    dom.ta.scrollTop = 0;
    dom.ta.scrollLeft = 0;
    closeComplete();
    analyze();
    renderStructure();
    renderCaretInfo();
    requestRender();
    saveSession();
  }

  async function newCart() {
    App.setWorkspace('code');
    const r = await transitions.open({
      what: 'Start a new cart?',
      apply: () => {
        load(`${K.NEW_CART}function _init()\n\nend\n\nfunction _update()\n\nend\n\nfunction _draw()\n cls()\n\nend\n`, 'untitled.p8');
        ed.savedLua = '';
        renderTitle();
        goLine(10);
      },
    });
    explain('New Cart', r, 'start a new cart');
  }

  async function openFile(file = null) {
    App.setWorkspace('code');
    let handle = null;
    if (!file) {
      if (window.showOpenFilePicker) {
        try { [handle] = await window.showOpenFilePicker({ id: 'p8-code', types: FILE_TYPES }); } catch { return; }
        file = await handle.getFile();
      } else {
        file = await pickFile('.p8,.lua,text/plain');
        if (!file) return;
      }
    }
    const r = await transitions.open({
      what: `Open "${file.name}"?`,
      prepare: async () => {
        const text = await file.text();
        if (/\.p8$/i.test(file.name) && !/^pico-8 cartridge/.test(text)) { showMessage('Open', `${file.name} is not a PICO-8 text cart (.p8.png carts are not supported; save it as .p8 in PICO-8).`); return null; }
        // a file inside the open folder keeps its place there (for #include)
        const inFolder = handle && ed.folder ? await ed.folder.resolve(handle).catch(() => null) : null;
        return { text, rel: inFolder ? inFolder.join('/') : null };
      },
      apply: ({ text, rel }) => {
        load(text, file.name, handle, { rel });
        toast(`Opened ${file.name}${handle ? ' (Save writes into it)' : ''}`);
      },
    });
    explain('Open', r, `open "${file.name}"`);
  }

  /** code handed over by another tool (code-open-text) */
  async function openText({ text, name }) {
    App.setWorkspace('code');
    const r = await transitions.open({ what: `Open "${name}"?`, prepare: () => text, apply: (t) => load(t, name) });
    explain('Open', r, `open "${name}"`);
  }

  async function writeHandle(h, text) {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('No permission to write the file.');
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
  }

  async function readHandle(h) {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('No permission to read the file.');
    return (await h.getFile()).text();
  }

  async function saveConflict({ name, diskLua, canReload }) {
    const lines = diskLua.split('\n').length;
    return modal({
      title: 'Code Changed on Disk',
      body: `The code in ${name} was changed outside this editor (in PICO-8 or another tab) since it was opened or last saved here; the file now has ${lines} line(s) of Lua.\n\nOverwrite: write your code; the file's sprites, map and sound stay as they are on disk.${canReload ? '\nReload: discard your edits and open the version on disk.' : ''}\nCancel: write nothing, keep your edits here.`,
      buttons: [{ label: 'Cancel', value: 'cancel' }, ...(canReload ? [{ label: 'Reload from disk', value: 'reload' }] : []), { label: 'Overwrite with mine', value: 'overwrite', primary: true }],
    });
  }

  // saves run one at a time; each marks only the code it wrote as saved, and only in its own file
  const saver = K.createSaver({
    snapshot: () => ({ doc: ed.doc, lua: ed.text, parts: ed.parts, baseLua: ed.baseLua, handle: ed.handle, name: ed.name }),
    isCurrent: (doc) => doc === ed.doc,
    commit: (doc, r) => {
      ed.savedLua = r.lua;
      if (r.text != null) {
        ed.parts = r.parts;
        ed.baseLua = r.parts.lua;
        ed.handle = r.handle;
        ed.name = r.name;
      }
      renderTitle();
      renderStructure();
      saveSession();
    },
    done: (how, r) => toast(how === 'downloaded' ? `Downloaded ${r.name}: replace the original with it` : `Saved ${r.name}${r.merged ? ' (kept the sprite/map/sound changes made on disk)' : ''}`),
    read: readHandle,
    write: writeHandle,
    conflict: saveConflict,
    reload: (doc, text) => { load(text, ed.name, ed.handle, { rel: ed.rel, parent: ed.parent }); toast('Reloaded the version on disk'); },
    pickSave: window.showSaveFilePicker ? (name) => window.showSaveFilePicker({ id: 'p8-code', suggestedName: name, types: FILE_TYPES }) : null,
    download: (text, name) => download(text, name),
    warn: (msg) => toast(msg, 'warn', 4000),
  });

  /** -> 'saved' (written to a file handle) | 'downloaded' (fallback copy, not in place) | 'cancelled' */
  const save = (opts) => saver.save(opts);

  // everything that replaces the open code (or runs it) is bound to the open document and its saved
  // revision, and checked again after every wait: newer edits stay open or are discarded only on request
  const transitions = K.createTransitions({
    current: () => ({ doc: ed.doc, lua: ed.text, savedLua: ed.savedLua, handle: ed.handle, name: ed.name }),
    idle: () => saver.idle(),
    save: () => save(),
    confirmDiscard,
  });

  /** why a transition kept the open code (silent when the user declined or a newer action took over) */
  function explain(title, r, next) {
    if (r.why === 'unsaved') showMessage(title, `${r.name} was not saved in place, so it stays open. Save it, then ${next} again.`);
    else if (r.why === 'changed') showMessage(title, `${r.name} was edited while it was being saved or while the next file was loading, so it stays open with your newest code (not saved yet). Save it, then ${next} again.`);
    else if (r.why === 'switched') toast(`${title}: another file was opened meanwhile`, 'warn');
  }

  async function reloadFromDisk() {
    if (!ed.handle) { showMessage('Reload', 'The code was not opened from a file this browser can read again. Use Open… instead.'); return; }
    const r = await transitions.open({
      what: `Reload "${ed.name}" from disk?`,
      prepare: async () => {
        const { handle, name } = ed;
        try {
          if ((await handle.queryPermission?.({ mode: 'read' })) !== 'granted') await handle.requestPermission?.({ mode: 'read' });
          return { text: await (await handle.getFile()).text(), handle, name };
        } catch (err) { showMessage('Reload', err.message); return null; }
      },
      apply: ({ text, handle, name }) => { load(text, name, handle); toast('Reloaded'); },
    });
    explain('Reload', r, 'reload it');
  }

  // the cart's other sections, in the other tools
  function cartText() { return K.joinCart(ed.parts, ed.text); }
  function openGfx() {
    if (!ed.parts.sections.includes('gfx')) { showMessage('Sprites', 'This cart has no __gfx__ section.'); return; }
    App.runAction('ps-import-cart-file', { file: new File([cartText()], ed.name) });
  }
  function openMap() {
    if (!window.P8MapEditor?.importCartText) return;
    window.P8MapEditor.importCartText(cartText(), ed.name);
  }

  // ------------------------------------------------------------------ //
  // Folder: its carts and .lua files, #include followed                //
  // ------------------------------------------------------------------ //

  const dirOf = (rel) => (rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

  async function openFolder() {
    App.setWorkspace('code');
    if (!window.showDirectoryPicker) { showMessage('Open Folder', 'This browser cannot open folders. Use Chrome or Edge.'); return; }
    let h;
    try { h = await window.showDirectoryPicker({ id: 'p8-code-folder', mode: 'readwrite' }); } catch { return; }
    ed.folder = h;
    ed.folderReady = true;
    await listFolder();
    // the open file may live in this folder
    if (ed.handle && !ed.rel) {
      const p = await h.resolve(ed.handle).catch(() => null);
      if (p) ed.rel = p.join('/');
    }
    renderStructure();
    saveSession();
    toast(`Folder ${h.name}: ${ed.files.size} carts and .lua files`);
  }

  async function reconnectFolder() {
    if (!ed.folder) return;
    if ((await ed.folder.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
    ed.folderReady = true;
    await listFolder();
    renderStructure();
  }

  async function listFolder() {
    ed.files = new Map();
    const walk = async (dir, prefix, depth) => {
      for await (const [name, h] of dir.entries()) {
        if (ed.files.size > 3000) return;
        if (h.kind === 'directory') {
          if (depth < 5 && !name.startsWith('.') && !['node_modules', 'backup', 'bbs'].includes(name.toLowerCase())) await walk(h, `${prefix}${name}/`, depth + 1);
        } else if (/\.(p8|lua)$/i.test(name)) {
          ed.files.set(`${prefix}${name}`.toLowerCase(), { rel: `${prefix}${name}`, handle: h });
        }
      }
    };
    try { await walk(ed.folder, '', 0); } catch (err) { toast(`Could not read the folder: ${err.message}`, 'warn'); }
  }

  function renderFiles() {
    dom.folderName.textContent = ed.folder ? `· ${ed.folder.name}` : '';
    if (!ed.folder) {
      dom.files.replaceChildren(el('p', { className: 'muted', textContent: 'Open a folder to see its carts and .lua files, follow #include and count their tokens.' }));
      return;
    }
    if (!ed.folderReady) {
      const b = el('button', { type: 'button', className: 'btn btn-sm', textContent: `Reconnect “${ed.folder.name}”` });
      b.addEventListener('click', reconnectFolder);
      dom.files.replaceChildren(b);
      return;
    }
    const list = [...ed.files.values()].sort((a, b) => a.rel.localeCompare(b.rel));
    const cur = ed.rel?.toLowerCase();
    dom.files.replaceChildren(...(list.length ? list.map((f) => el('button', {
      type: 'button', className: `ce-file-item${f.rel.toLowerCase() === cur ? ' cur' : ''}${/\.lua$/i.test(f.rel) ? ' lua' : ''}`,
      dataset: { rel: f.rel }, title: f.rel, textContent: f.rel,
    })) : [el('p', { className: 'muted', textContent: 'No .p8 or .lua files here.' })]));
  }

  async function readRel(rel) {
    const f = ed.files.get(rel.toLowerCase());
    if (!f) return null;
    const file = await f.handle.getFile();
    const stamp = `${file.lastModified}:${file.size}`;
    const c = ed.fileCache.get(f.rel);
    if (c && c.stamp === stamp) return c.text;
    const text = await file.text();
    ed.fileCache.set(f.rel, { stamp, text });
    return text;
  }

  async function openRel(rel, { parent = null } = {}) {
    const f = ed.files.get(rel.toLowerCase());
    if (!f) { showMessage('Open', `${rel} is not in the folder.`); return; }
    // moving between the files of a folder saves the one you leave (it has a place on disk). It is left
    // only once exactly the code on screen is written: a cancelled or download-only save, or code typed
    // during the save, keeps this buffer open
    const r = await transitions.open({
      what: `Open "${f.rel}"?`,
      autosave: true,
      prepare: () => readRel(f.rel),
      apply: (text) => load(text, f.handle.name, f.handle, { rel: f.rel, parent }),
    });
    explain('Open', r, `open "${f.rel}"`);
  }

  // includes: resolved like Project Audit does (P8Audit.includeMeter), nested ones too, with their
  // tokens; a file included twice counts twice, a cycle stops (and is not "missing")
  let incRun = 0;
  async function resolveIncludes() {
    const run = ++incRun;
    if (!K.includes(ed.text).length) { ed.incs = []; ed.incTokens = 0; renderIncludes(); renderMeters(); return; }
    const can = ed.folder && ed.folderReady && ed.rel != null;
    let rep;
    try {
      rep = await A.includeMeter({ names: can ? [...ed.files.values()].map((f) => f.rel) : [], path: ed.rel ?? ed.name ?? '', cart: cartText(), lua: ed.text, read: readRel });
    } catch {
      rep = { included: 0, items: K.includes(ed.text).map((i) => ({ ...i, rel: i.path, found: false, tokens: 0, warnings: [] })) };
    }
    if (run !== incRun) return;
    ed.incs = rep.items;
    ed.incTokens = rep.included;
    renderIncludes();
    renderMeters();
  }

  function renderIncludes() {
    if (!ed.incs.length) { dom.includes.replaceChildren(); return; }
    const can = ed.folder && ed.folderReady && ed.rel != null;
    const note = (i) => [i.cycle && 'cycle stopped', i.depth && 'too deep', i.missing && `${i.missing} missing inside`].filter(Boolean).join(', ');
    const rows = ed.incs.map((i) => el('button', {
      type: 'button', className: `ce-inc${i.found ? '' : ' missing'}`, dataset: { line: String(i.line) },
      title: i.found ? `${i.rel} · click to open (or Ctrl+click the #include line)${i.warnings.length ? `\n${i.warnings.join('\n')}` : ''}` : can ? (i.target ? `${i.rel} has no code tab ${i.tab}` : `${i.rel} is not in the folder`) : 'Open the folder of this cart to follow its includes',
    }, el('span', { className: 't-include', textContent: `#include ${i.path}${i.tab != null ? `:${i.tab}` : ''}` }),
    el('span', { className: 'muted', textContent: !i.found ? (can ? 'missing' : '?') : `${i.tokens} tokens${note(i) ? ` (${note(i)})` : ''}` })));
    const head = el('div', { className: 'ce-inc-head', textContent: 'Includes' });
    if (!can) {
      const b = el('button', { type: 'button', className: 'btn btn-sm', dataset: { action: 'code-open-folder' }, textContent: 'Open the folder to follow them…' });
      dom.includes.replaceChildren(head, ...rows, b);
    } else dom.includes.replaceChildren(head, ...rows);
  }

  async function openInclude(line) {
    const inc = ed.incs.find((i) => i.line === line);
    if (!inc) return;
    if (!inc.found) {
      if (!ed.folder || !ed.folderReady || ed.rel == null) { await openFolder(); return; }
      showMessage('#include', `${inc.rel} is not in the folder ${ed.folder.name}.`);
      return;
    }
    await openRel(inc.rel, { parent: ed.rel ? { rel: ed.rel, name: ed.name } : null });
  }

  // ------------------------------------------------------------------ //
  // Run in PICO-8 (through tools/pico8_bridge.py)                       //
  // ------------------------------------------------------------------ //

  const BRIDGE = `http://127.0.0.1:${saved.bridgePort || 8708}`;
  const bridge = { since: 0, timer: 0, running: false };
  // pairing token printed by the bridge; valid until it restarts, so this tab's session is enough
  const TOKEN_KEY = 'p8suite.bridgeToken';
  const bridgeToken = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
    set(v) { try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } },
  };

  async function call(path, body = null, token = bridgeToken.get()) {
    const headers = token ? { 'X-Bridge-Token': token } : {};
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(BRIDGE + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
    const j = await r.json();
    if (!j.ok) throw Object.assign(new Error(j.error || `bridge error ${r.status}`), { status: r.status });
    return j;
  }

  /** the cart to run: this one, or for an included .lua file the cart that includes it; text(lua) gets the Lua to send for the open file */
  async function runTarget() {
    if (/\.p8$/i.test(ed.name) || ed.parts.head != null) return { name: ed.name, text: (lua) => K.joinCart(ed.parts, lua) };
    const parent = ed.parent && ed.files.get(ed.parent.rel.toLowerCase());
    if (parent) return { name: parent.handle.name, text: () => readRel(parent.rel) };
    // a .p8 in the folder that includes this file
    if (ed.folder && ed.folderReady && ed.rel) {
      for (const f of ed.files.values()) {
        if (!/\.p8$/i.test(f.rel)) continue;
        const t = await readRel(f.rel);
        if (K.includes(K.splitCart(t).lua).some((i) => K.joinPath(dirOf(f.rel), i.path).toLowerCase() === ed.rel.toLowerCase())) return { name: f.handle.name, text: () => readRel(f.rel) };
      }
    }
    return null;
  }

  async function runCart() {
    App.setWorkspace('code');
    const doc = ed.doc;
    const target = await runTarget();
    if (!target) { showMessage('Run', 'This .lua file is not included by a cart in the open folder, so there is nothing to run. Open the cart instead.'); return; }
    // PICO-8 runs what is on disk: save first (includes are read by PICO-8 itself) and send exactly the
    // saved code, so newer unsaved edits are never presented as the cart on disk
    const r = await transitions.ready(doc);
    if (!r.ok) {
      if (r.why === 'unsaved') showMessage('Run', `${r.name} was not saved in place, so PICO-8 would run the old version from disk. Save it, then Run again.`);
      else if (r.why === 'changed') showMessage('Run', `${r.name} was edited while it was being saved, so the file on disk is older than the code on screen. Save it, then Run again.`);
      else if (r.why === 'switched') showMessage('Run', 'Another file was opened before Run could start. Run again.');
      return;
    }
    let res;
    try {
      res = await call('/run', { name: target.name, text: await target.text(r.lua) });
    } catch (err) {
      if (err instanceof TypeError || err.status === 401) { runSetup(); return; }
      showMessage('Run', err.message);
      return;
    }
    dom.output.hidden = false;
    dom.runInfo.textContent = ` ${res.path}`;
    if (res.temp) appendOut(`(not found on disk, so a copy runs from ${res.path}${ed.incs.length ? '; its #include files are not next to it' : ''}. Save the cart into a carts folder of the bridge to run it in place.)`);
    setRunning(true);
    poll();
  }

  async function stopCart() {
    try { await call('/stop', {}); } catch { /* bridge gone */ }
    setRunning(false);
  }

  function setRunning(on) {
    bridge.running = on;
    dom.stop.hidden = !on;
    dom.run.textContent = on ? '↻ Run' : '▶ Run';
  }

  function appendOut(line) {
    const atEnd = dom.outLog.scrollTop + dom.outLog.clientHeight >= dom.outLog.scrollHeight - 4;
    dom.outLog.append(`${line.replace(/^INFO: /, '')}\n`);
    if (atEnd) dom.outLog.scrollTop = dom.outLog.scrollHeight;
  }

  function poll() {
    clearTimeout(bridge.timer);
    bridge.timer = setTimeout(async () => {
      try {
        const j = await call(`/log?since=${bridge.since}`);
        for (const l of j.lines) appendOut(l);
        bridge.since = j.next;
        if (j.running) poll(); else setRunning(false);
      } catch { setRunning(false); }
    }, 400);
  }

  /** -> { paired, text } for the setup dialog; checks `token` without storing it */
  async function bridgeStatus(token) {
    let j;
    try { j = await call('/ping', null, token); } catch { return { paired: false, text: 'The bridge is not running.' }; }
    if (!j.paired) {
      return { paired: false, text: token
        ? 'The bridge is running, but this token was not accepted. Copy the current one from the bridge window: it changes every time the bridge starts.'
        : 'The bridge is running. Paste the pairing token shown in its window, then press Pair.' };
    }
    return { paired: true, text: `The bridge is running and paired.\npico8: ${j.pico8 || 'not found'}\ncarts folders:\n${j.roots.join('\n')}` };
  }

  async function runSetup() {
    const cmd = 'python tools/pico8_bridge.py --root "C:/path/to/your/demo"';
    const status = el('pre', { className: 'ce-cmd', textContent: 'Checking the bridge…' });
    const input = el('input', { type: 'text', value: bridgeToken.get(), spellcheck: false, autocomplete: 'off', placeholder: 'token printed by the bridge' });
    const pair = async () => {
      const token = input.value.trim();
      const st = await bridgeStatus(token);
      status.textContent = st.text;
      if (st.paired) bridgeToken.set(token);
    };
    pair();
    await modal({
      title: 'Run in PICO-8',
      body: el('div', { className: 'dialog-form' },
        el('p', { textContent: 'A web page cannot start programs, so Run goes through a small helper on your computer (Python, standard library only).' }),
        el('ol', {},
          el('li', {}, 'Start tools/run_pico8_bridge.bat (double-click), or in a terminal:', el('pre', { className: 'ce-cmd', textContent: cmd })),
          el('li', { textContent: 'Copy the pairing token it prints, paste it below and press Pair (again whenever the bridge restarts).' }),
          el('li', { textContent: 'Keep its window open. Press Run (Ctrl+R): the cart is saved, PICO-8 starts it, printh() output shows up below the code.' })),
        formField('Pairing token', input),
        el('p', { className: 'muted', textContent: 'The bridge runs carts where they are, so #include, reload() and load() find their files. It looks in PICO-8\'s carts folder and in every --root folder; --pico8 PATH if PICO-8 is not installed in the usual place. It only accepts this page from a local file, localhost or 127.0.0.1.' }),
        status),
      actions: [{ label: 'Pair', primary: true, onClick: pair }],
      buttons: [{ label: 'Close', value: true }],
      onOpen: () => input.focus(),
    });
  }

  // session: the code and where it came from survive a reload of the page
  let sessTimer = 0;
  function saveSession() {
    clearTimeout(sessTimer);
    sessTimer = setTimeout(() => S.kv.set(SESSION_KEY, {
      name: ed.name, parts: { head: ed.parts.head, tail: ed.parts.tail, crlf: ed.parts.crlf, sections: ed.parts.sections },
      lua: ed.text, savedLua: ed.savedLua, baseLua: ed.baseLua, handle: ed.handle, sel: [dom.ta.selectionStart, dom.ta.selectionEnd], top: dom.ta.scrollTop,
      folder: ed.folder, rel: ed.rel, parent: ed.parent,
    }).catch(S.autosaveFailed('Code Editor session')), 500);
  }

  async function restoreSession() {
    const s = await S.kv.get(SESSION_KEY).catch(S.autosaveFailed('Code Editor session'));
    if (!s || typeof s.lua !== 'string') { load(`${K.NEW_CART}function _init()\n\nend\n\nfunction _update()\n\nend\n\nfunction _draw()\n cls()\n\nend\n`, 'untitled.p8'); return; }
    ed.parts = { lua: '', ...s.parts };
    ed.name = s.name || 'untitled.p8';
    ed.handle = s.handle || null;
    ed.rel = s.rel ?? null;
    ed.parent = s.parent || null;
    ed.folder = s.folder || null;
    // the browser keeps the folder, but asks again for access after a reload
    if (ed.folder) {
      ed.folderReady = (await ed.folder.queryPermission?.({ mode: 'readwrite' }).catch(() => 'prompt')) === 'granted';
      if (ed.folderReady) await listFolder();
    }
    dom.ta.value = s.lua;
    ed.savedLua = typeof s.savedLua === 'string' ? s.savedLua : s.lua;
    ed.doc = {};
    ed.baseLua = typeof s.baseLua === 'string' ? s.baseLua : ed.handle ? ed.savedLua : null;
    analyze();
    renderStructure();
    if (Array.isArray(s.sel)) dom.ta.setSelectionRange(...s.sel);
    requestAnimationFrame(() => { dom.ta.scrollTop = s.top || 0; requestRender(); renderCaretInfo(); });
  }

  // ------------------------------------------------------------------ //
  // Keys                                                               //
  // ------------------------------------------------------------------ //

  function onEditorKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const c = ed.complete;
    if (c) {
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); c.sel = (c.sel + (k === 'ArrowDown' ? 1 : -1) + c.items.length) % c.items.length; renderComplete(); return true; }
      if (k === 'Enter' || k === 'Tab') { e.preventDefault(); acceptComplete(); return true; }
      if (k === 'Escape') { e.preventDefault(); closeComplete(); return true; }
    }
    if (k === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const ta = dom.ta;
      if (e.shiftKey || ed.text.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) indentLines(e.shiftKey ? -1 : 1);
      else replaceRange(ta.selectionStart, ta.selectionEnd, set.indent);
      return true;
    }
    if (k === 'Enter' && !mod && !e.altKey) { e.preventDefault(); newline(); return true; }
    if (k === 'Escape') {
      if (ed.find.open) { closeFind(); return true; }
      if (!dom.sig.hidden) { dom.sig.hidden = true; return true; }
      return false;
    }
    if (mod && !e.altKey && (k === '/' || k === '#')) { e.preventDefault(); toggleComment(); return true; }
    if (mod && !e.shiftKey && k.toLowerCase() === 'd') { e.preventDefault(); duplicateLines(); return true; }
    if (e.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); moveLines(k === 'ArrowUp' ? -1 : 1); return true; }
    if (mod && k === ' ') { e.preventDefault(); openComplete(true); return true; }
    if (mod && (k === ']' || k === '[')) { e.preventDefault(); indentLines(k === ']' ? 1 : -1); return true; }
    if (!mod && !e.altKey && k.length === 1 && autoPair(e)) { e.preventDefault(); return true; }
    if (k === 'Backspace' && !mod) {
      // delete an empty pair "()" at once
      const ta = dom.ta;
      const s = ta.selectionStart;
      if (s === ta.selectionEnd && CLOSE[ed.text[s - 1]] === ed.text[s] && CLOSE[ed.text[s - 1]]) { e.preventDefault(); replaceRange(s - 1, s + 1, ''); return true; }
    }
    return false;
  }

  /** workspace keys (also when the focus is in the side panel or the find bar) */
  function onKey(e, typing) {
    if (e.type === 'keyup') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && e.altKey && k === 'n') { e.preventDefault(); newCart(); return; }
    if (mod && !e.shiftKey && !e.altKey && k === 'r') { e.preventDefault(); runCart(); return; }
    if (mod && k === 's') { e.preventDefault(); save({ as: e.shiftKey }); return; }
    if (mod && !e.shiftKey && k === 'o') { e.preventDefault(); openFile(); return; }
    if (mod && e.shiftKey && k === 'o') { e.preventDefault(); dom.outlineFilter.focus(); dom.outlineFilter.select(); return; }
    if (mod && k === 'f') { e.preventDefault(); openFind(false); return; }
    if (mod && k === 'h') { e.preventDefault(); openFind(true); return; }
    if (mod && k === 'g') { e.preventDefault(); gotoLine(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoom(1); return; }
    if (mod && k === '-') { e.preventDefault(); zoom(-1); return; }
    if (e.key === 'F3') { e.preventDefault(); if (!ed.find.open) openFind(false); else stepFind(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape' && ed.find.open) { closeFind(); return; }
    if (typing) return;
  }

  function zoom(d) {
    set.fontSize = Math.max(10, Math.min(28, set.fontSize + d));
    persist();
    applyFont();
    requestRender();
  }

  // ------------------------------------------------------------------ //
  // Bindings                                                           //
  // ------------------------------------------------------------------ //

  function bind() {
    const ta = dom.ta;
    ta.addEventListener('keydown', (e) => { if (onEditorKey(e)) e.stopPropagation(); });
    ta.addEventListener('input', (e) => {
      changed();
      // typed characters only (edits made with execCommand arrive as longer texts)
      if (e.inputType === 'insertText' && e.data?.length === 1) {
        if (/[A-Za-z_0-9]/.test(e.data)) openComplete(Boolean(ed.complete));
        else closeComplete();
        if (/[a-z)\]}]/.test(e.data)) autoDedent();
      } else if (e.inputType?.startsWith('delete') && ed.complete) openComplete(true);
      else closeComplete();
    });
    ta.addEventListener('scroll', () => requestRender());
    ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) closeComplete(); }, 150));
    document.addEventListener('selectionchange', () => {
      if (document.activeElement !== ta) return;
      renderCaretInfo();
      requestRender();
      if (ed.complete) {
        const s = ta.selectionStart;
        if (s < ed.complete.from || /\W/.test(ed.text.slice(ed.complete.from, s))) closeComplete();
      }
    });
    dom.complete.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.ce-item');
      if (!it) return;
      e.preventDefault();
      ed.complete.sel = Number(it.dataset.i);
      acceptComplete();
    });
    new ResizeObserver(requestRender).observe(dom.view);

    // Ctrl+click an #include line opens the file
    ta.addEventListener('click', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = tokenAt(ta.selectionStart) || tokenAt(ta.selectionStart - 1);
      if (t?.t === 'include') openInclude(lineOf(t.s));
    });
    dom.files.addEventListener('click', (e) => { const b = e.target.closest('[data-rel]'); if (b) openRel(b.dataset.rel); });
    dom.includes.addEventListener('click', (e) => { const b = e.target.closest('.ce-inc'); if (b) openInclude(Number(b.dataset.line)); });
    dom.back.addEventListener('click', () => { if (ed.parent) openRel(ed.parent.rel); });
    $('#ceOutClear').addEventListener('click', () => { dom.outLog.textContent = ''; });
    $('#ceOutClose').addEventListener('click', () => { dom.output.hidden = true; });

    dom.tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) goLine(Number(b.dataset.line)); });
    dom.outline.addEventListener('click', (e) => { const b = e.target.closest('[data-line]'); if (b) goLine(Number(b.dataset.line)); });
    dom.outlineFilter.addEventListener('input', renderStructure);
    dom.outlineFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const b = dom.outline.querySelector('[data-line]'); if (b) goLine(Number(b.dataset.line)); }
      if (e.key === 'Escape') { dom.outlineFilter.value = ''; renderStructure(); ta.focus(); }
    });

    dom.findIn.addEventListener('input', () => runFind(true));
    dom.findIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    });
    dom.replIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    });
    for (const b of [dom.findCase, dom.findWord]) b.addEventListener('change', () => runFind(false));
    $('#ceFindNext').addEventListener('click', () => stepFind(1));
    $('#ceFindPrev').addEventListener('click', () => stepFind(-1));
    $('#ceReplOne').addEventListener('click', replaceOne);
    $('#ceReplAll').addEventListener('click', replaceAll);
    $('#ceFindClose').addEventListener('click', closeFind);

    // drop a .p8 / .lua file onto the editor
    dom.editor.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dom.editor.classList.add('dragover'); } });
    dom.editor.addEventListener('dragleave', () => dom.editor.classList.remove('dragover'));
    dom.editor.addEventListener('drop', async (e) => {
      dom.editor.classList.remove('dragover');
      const item = [...(e.dataTransfer?.items || [])].find((i) => i.kind === 'file');
      if (!item) return;
      e.preventDefault();
      const handle = await item.getAsFileSystemHandle?.().catch(() => null);
      const file = item.getAsFile();
      const r = await transitions.open({
        what: `Open "${file.name}"?`,
        prepare: () => file.text(),
        apply: (text) => load(text, file.name, handle?.kind === 'file' ? handle : null),
      });
      explain('Open', r, `open "${file.name}"`);
    });

    document.addEventListener('p8:workspace', () => {
      if (document.body.dataset.workspace !== 'code') return;
      applyFont();
      requestRender();
      requestAnimationFrame(() => ta.focus({ preventScroll: true }));
    });
    window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  }

  // ------------------------------------------------------------------ //
  // Suite integration                                                  //
  // ------------------------------------------------------------------ //

  S.registerTool({
    ws: 'code', name: 'Code Editor',
    desc: 'PICO-8 Lua with PICO-8 syntax highlighting, API completion and hints, code tabs, functions list, live token count; saves straight back into the .p8.',
    color: '#ff77a8', tags: ['code', 'tokens', '.p8'],
  });
  App.registerShortcuts('code', onKey);
  const exec = (cmd) => () => { dom.ta.focus(); document.execCommand(cmd); };
  App.registerActions({
    'code-new': newCart,
    'code-open': () => openFile(),
    'code-save': () => save(),
    'code-save-as': () => save({ as: true }),
    'code-reload': reloadFromDisk,
    'code-undo': exec('undo'),
    'code-redo': exec('redo'),
    'code-find': () => openFind(false),
    'code-replace': () => openFind(true),
    'code-goto': gotoLine,
    'code-comment': toggleComment,
    'code-duplicate': duplicateLines,
    'code-indent': () => indentLines(1),
    'code-outdent': () => indentLines(-1),
    'code-complete': () => { dom.ta.focus(); openComplete(true); },
    'code-new-tab': () => {
      const t = ed.text.replace(/\n*$/, '');
      replaceRange(0, ed.text.length, `${t}\n-->8\n-- new tab\n`, t.length + 6);
      revealLine(lineOf(dom.ta.selectionStart), true);
    },
    'code-bigger': () => zoom(1),
    'code-smaller': () => zoom(-1),
    'code-upper': () => { set.upper = !set.upper; persist(); applyFont(); requestRender(); },
    'code-indent-1': () => { set.indent = ' '; persist(); toast('Indent: 1 space'); },
    'code-indent-2': () => { set.indent = '  '; persist(); toast('Indent: 2 spaces'); },
    'code-indent-tab': () => { set.indent = '\t'; persist(); toast('Indent: tab'); },
    'code-gfx': openGfx,
    'code-map': openMap,
    'code-open-folder': openFolder,
    'code-run': runCart,
    'code-stop': stopCart,
    'code-run-setup': runSetup,
  });
  // other tools can open a cart's code: App.runAction('code-open-text', {text, name})
  App.registerActions({ 'code-open-text': openText });

  applyFont();
  bind();
  S.assets.ready.then(restoreSession);
})();

