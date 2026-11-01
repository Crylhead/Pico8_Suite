// js/audit-core.js
// Pure logic of Project Audit (port of project_audit/core + ui/scanner_worker.py):
// #include expansion, token / character counts, cart references, project summary.
// Comments, strings and #include lines come from the Code Editor's lexer (js/code-core.js),
// so long brackets of any level and .p8:N tab includes are read the same way everywhere.
// No DOM; runs in Node for tests. Files are given as a Map of 'dir/name.p8' -> text.

'use strict';

const P8Audit = (() => {
  const TOKEN_LIMIT = 8192;
  const CHAR_LIMIT = 65535;

  const SECTION_RE = /^__([a-z0-9_]+)__$/i;
  // resolved when first used: index.html loads this file before code-core.js
  let K = null;
  const lexer = () => (K ||= typeof P8Code !== 'undefined' ? P8Code : require('./code-core.js'));

  /** Lua between __lua__ and the next __section__ marker ('' if there is none). */
  function extractLua(p8) {
    const lines = p8.split(/(?<=\n)/);
    const start = lines.findIndex((l) => l.trim().toLowerCase() === '__lua__');
    if (start < 0) return '';
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) if (SECTION_RE.test(lines[j].trim())) { end = j; break; }
    return lines.slice(start + 1, end).join('');
  }

  /** #include targets as written ('lib.lua', 'gfx.p8:1'); not ones inside comments or strings */
  const parseIncludes = (lua) => lexer().includes(lua).map((i) => i.raw);

  // Paths --------------------------------------------------------------- //

  function normPath(p) {
    const out = [];
    for (const part of p.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); } else out.push(part);
    }
    return out.join('/');
  }
  const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const join = (a, b) => normPath(a ? `${a}/${b}` : b);
  const stem = (p) => basename(p).replace(/\.[^.]*$/, '');

  /** Case-insensitive lookup helper (PICO-8 on Windows / macOS does not care about case). */
  function makeFs(files) {
    const lower = new Map();
    for (const k of files.keys()) lower.set(k.toLowerCase(), k);
    return {
      has: (p) => files.has(p) || lower.has(p.toLowerCase()),
      key: (p) => (files.has(p) ? p : lower.get(p.toLowerCase())),
      read: (p) => files.get(files.has(p) ? p : lower.get(p.toLowerCase())),
    };
  }

  /** resolve_include: relative to the including file, then the project root, then with .lua / .p8 added. */
  function resolveInclude(fs, includingDir, inc) {
    const c1 = join(includingDir, inc);
    const c2 = normPath(inc);
    for (const c of [c1, c2, `${c1}.lua`, `${c2}.lua`, `${c1}.p8`, `${c2}.p8`]) if (fs.has(c)) return fs.key(c);
    return null;
  }

  /**
   * expand_includes: returns {text, resolved[], items[]}; appends to warnings. Only real #include
   * lines expand (not ones in comments or strings); "cart.p8:N" pulls in code tab N of that cart.
   * items: one per #include of this level, {inc, target, status: 'ok' | 'missing' | 'cycle',
   * text: what replaced the directive, warnings: the ones raised while expanding it (nested too)}.
   */
  function expandIncludes(fs, path, lua, visited, warnings, depth = 0) {
    if (depth > 50) { warnings.push(`include depth exceeded at ${path}`); return { text: lua, resolved: [], items: [] }; }
    const dir = dirname(path);
    const resolved = [];
    const items = [];
    let out = '';
    let at = 0;
    for (const inc of lexer().includes(lua)) {
      out += lua.slice(at, inc.s);
      at = inc.e;
      // the directive's line break is replaced by the block below
      if (lua[at] === '\r') at++;
      if (lua[at] === '\n') at++;
      const w0 = warnings.length;
      const item = expandOne(fs, dir, inc, visited, warnings, depth);
      item.warnings = warnings.slice(w0);
      items.push(item);
      resolved.push(...item.resolved);
      out += item.text;
    }
    return { text: out + lua.slice(at), resolved, items };
  }

  /** one #include directive of expandIncludes: its replacement text, status and resolved files */
  function expandOne(fs, dir, inc, visited, warnings, depth) {
    const { raw, tab } = inc;
    const target = resolveInclude(fs, dir, inc.path);
    const tabs = target && tab != null && target.toLowerCase().endsWith('.p8') ? lexer().splitCart(fs.read(target)).lua.split(/^-->8[ \t]*$/m).length : 0;
    if (!target || (tab != null && tab >= tabs)) {
      warnings.push(`unresolved include: ${raw}${target && tab != null ? ` (no code tab ${tab})` : ''}`);
      return { inc, target, status: 'missing', text: `-- [[unresolved include: ${raw}]]\n`, resolved: [] };
    }
    // a tab of a cart is its own unit: m.p8:1 may include m.p8:2
    const id = tab == null ? target.toLowerCase() : `${target.toLowerCase()}:${tab}`;
    if (visited.has(id)) {
      warnings.push(`include cycle detected: ${raw}`);
      return { inc, target, status: 'cycle', text: `-- [[include cycle: ${raw}]]\n`, resolved: [] };
    }
    // visited is the active include stack (cycle detection), not a global dedup:
    // a file included twice, or via two branches, expands at each occurrence like PICO-8 does.
    visited.add(id);
    const child = expandIncludes(fs, target, lexer().includedCode(fs.read(target), target, tab), visited, warnings, depth + 1);
    visited.delete(id);
    const text = `-- [[begin include: ${raw}]]\n${child.text}${child.text.endsWith('\n') ? '' : '\n'}-- [[end include: ${raw}]]\n`;
    return { inc, target, status: 'ok', text, resolved: [tab == null ? target : `${target}:${tab}`, ...child.resolved] };
  }

  /**
   * Every file the #include tree of a file can reach, read once each through an async
   * read(path) -> text | null (the Code Editor reads its folder this way), as a Map for makeFs.
   * names: every path that exists; text: the including file itself (a whole cart or .lua), which
   * stands in for its copy on disk so its own tabs are read from the current code.
   */
  async function readIncludeFiles(names, path, text, read) {
    const exists = makeFs(new Map(names.map((n) => [n, null])));
    const files = new Map();
    const self = exists.key(path) ?? path;
    files.set(self, text);
    const codeOf = (p, t) => (p.toLowerCase().endsWith('.p8') ? lexer().splitCart(t).lua : t);
    const queue = [[self, text]];
    while (queue.length) {
      const [p, t] = queue.pop();
      for (const inc of lexer().includes(codeOf(p, t))) {
        const target = resolveInclude(exists, dirname(p), inc.path);
        if (!target || files.has(target)) continue;
        let got = null;
        try { got = await read(target); } catch { got = null; }
        files.set(target, got);
        if (got != null) queue.push([target, got]);
      }
    }
    for (const [k, v] of files) if (v == null) files.delete(k);
    return files;
  }

  /**
   * The Code Editor's include meter, with Audit's expansion (same resolution, active-stack cycle
   * check, depth limit and .p8:N tabs), so both report the same expanded total.
   * files: Map(path -> text) of the folder (see readIncludeFiles); path: the edited file; lua: its code.
   * -> {self, expanded, included, warnings, items: [{line, raw, path, tab, target, found, cycle,
   *    depth, missing, tokens, warnings}]}. found: the target exists (also when the include is a
   * cycle); cycle / depth: expansion stopped there; missing: unresolved includes nested inside.
   */
  function includeReport(files, path, lua) {
    const fs = makeFs(files);
    const warnings = [];
    const exp = expandIncludes(fs, path, lua, new Set([path.toLowerCase()]), warnings);
    const self = countTokens(lua);
    const expanded = countTokens(exp.text);
    const items = exp.items.map(({ inc, target, status, text, warnings: w }) => ({
      line: inc.line, raw: inc.raw, path: inc.path, tab: inc.tab, target,
      found: status !== 'missing',
      cycle: status === 'cycle' || w.some((m) => /^include cycle/.test(m)),
      depth: w.some((m) => /^include depth/.test(m)),
      missing: status === 'missing' ? 0 : w.filter((m) => /^unresolved include/.test(m)).length,
      tokens: countTokens(text),
      warnings: w,
    }));
    return { self, expanded, included: expanded - self, warnings, items };
  }

  /**
   * Code Editor meter in one call: reads the reachable files (readIncludeFiles), then
   * includeReport; each item also gets rel, the file it opens (or would, when missing).
   * names: the folder's files ([] when no folder is open: every include is then not found).
   */
  async function includeMeter({ names, path, cart, lua, read }) {
    const files = names.length ? await readIncludeFiles(names, path, cart, read) : new Map();
    const rep = includeReport(files, path, lua);
    for (const i of rep.items) i.rel = i.target ?? join(dirname(path), i.path);
    return rep;
  }

  // Comments + tokens ---------------------------------------------------- //

  /** strip_comments_preserve_strings: comments of any long-bracket level and -->8 lines removed */
  function stripComments(src) {
    let out = '';
    let at = 0;
    for (const tk of lexer().lex(src)) {
      if (tk.t !== 'comment' && tk.t !== 'tabsep') continue;
      out += src.slice(at, tk.s);
      at = tk.e;
    }
    return out + src.slice(at);
  }

  const FREE = new Set([',', '.', ';']);
  const VALUE = new Set(['number', 'ident', 'close', 'string']);
  const NAMES = new Set(['ident', 'api', 'callback', 'self', 'constant', 'keyword']);
  const letterish = (tk, src) => NAMES.has(tk.t) || (tk.t === 'glyph' && /^\p{L}/u.test(src.slice(tk.s, tk.e)));

  /**
   * Token estimate after the PICO-8 rules (see project_audit/core/tokenizer.py): every name,
   * value, operator, string (quoted or [=*[long]=*]) and opening bracket counts 1; commas,
   * periods, semicolons, closing brackets, local, end, comments and #include lines are free;
   * a negative number literal is one token. Not checked against every PICO-8 version.
   */
  function countTokens(lua) {
    const toks = lexer().lex(lua);
    let tokens = 0;
    let last = null;
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      const s = lua.slice(tk.s, tk.e);
      switch (tk.t) {
        case 'ws': case 'comment': case 'tabsep': case 'include': continue;
        case 'string': case 'number': tokens++; last = tk.t; continue;
        case 'bracket':
          if ('([{'.includes(s)) { tokens++; last = 'open'; } else last = 'close';
          continue;
        case 'op':
          if (FREE.has(s)) { last = 'ignored'; continue; }
          // -1 straight after an operator / opening bracket is one negative literal
          if (s === '-' && toks[k + 1]?.t === 'number' && toks[k + 1].s === tk.e && !VALUE.has(last)) { k++; last = 'number'; } else last = 'operator';
          tokens++;
          continue;
        case 'keyword':
          if (s === 'local' || s === 'end') { last = 'ignored'; continue; }
          break;
        case 'error': last = 'unknown'; continue;
        default: break;
      }
      // names and P8SCII glyphs (⬅️ is a predefined name); letters outside ASCII continue a name (café)
      if (k && toks[k - 1].e === tk.s && letterish(toks[k - 1], lua) && letterish(tk, lua)) continue;
      tokens++;
      last = 'ident';
    }
    return tokens;
  }

  // References ------------------------------------------------------------ //

  const STRING_RE = /(['"])([\s\S]*?)(?<!\\)\1/g;
  const callRefs = (src, name) => [...src.matchAll(new RegExp(`\\b${name}\\s*\\(\\s*(['"])(.*?)\\1`, 'gi'))].map((m) => m[2].trim());
  function lastStringArgRefs(src, name) {
    const out = [];
    for (const m of src.matchAll(new RegExp(`\\b${name}\\s*\\(([\\s\\S]*?)\\)`, 'gi'))) {
      const strs = [...m[1].matchAll(STRING_RE)].map((s) => s[2]);
      if (strs.length) out.push(strs[strs.length - 1].trim());
    }
    return out;
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Cart basenames appearing as whole words (e.g. partlist={fx_osc, fx_logo}). */
  function basenameRefs(text, names) {
    const low = text.toLowerCase();
    return [...names].filter((nm) => new RegExp(`\\b${escapeRe(nm)}\\b`).test(low)).sort();
  }

  const uniqSorted = (a) => [...new Set(a)].sort();

  // Scan ---------------------------------------------------------------- //

  /**
   * ScannerWorker.run. files: Map(relPath -> text) with every .p8 and include candidate;
   * meta: Map(relPath -> {mtime, size}). Returns CartStats[] sorted by path.
   */
  function scanProject(files, meta = new Map(), onProgress = null) {
    const fs = makeFs(files);
    const carts = [...files.keys()].filter((p) => p.toLowerCase().endsWith('.p8')).sort();
    const names = new Set(carts.map((p) => stem(p).toLowerCase()));

    const includesOut = new Map();
    const includedBy = new Map(carts.map((p) => [p, []]));
    const lowerCarts = new Map(carts.map((p) => [p.toLowerCase(), p]));
    for (const p of carts) {
      const incs = parseIncludes(extractLua(files.get(p)));
      includesOut.set(p, incs);
      for (const inc of incs) {
        const t = resolveInclude(fs, dirname(p), lexer().includeTarget(inc).path);
        if (t && t.toLowerCase().endsWith('.p8') && lowerCarts.has(t.toLowerCase())) includedBy.get(lowerCarts.get(t.toLowerCase())).push(p);
      }
    }

    const stats = [];
    carts.forEach((p, k) => {
      const txt = files.get(p);
      const lua = extractLua(txt);
      const warnings = [];
      const exp = expandIncludes(fs, p, lua, new Set([p.toLowerCase()]), warnings);
      const self = stem(p).toLowerCase();
      const m = meta.get(p) || {};
      stats.push({
        path: p,
        name: p,
        mtime: m.mtime ?? null,
        bytes: m.size ?? txt.length,
        tokens_self: countTokens(lua),
        tokens_expanded: countTokens(exp.text),
        chars_self: lua.replace(/\r\n/g, '\n').length,
        chars_expanded: exp.text.replace(/\r\n/g, '\n').length,
        includes_out: includesOut.get(p),
        includes_in: uniqSorted(includedBy.get(p)),
        includes_resolved: exp.resolved,
        load_refs: uniqSorted(callRefs(exp.text, 'load')),
        run_refs: uniqSorted(callRefs(exp.text, 'run')),
        reload_file_refs: uniqSorted(lastStringArgRefs(exp.text, 'reload')),
        cstore_file_refs: uniqSorted(lastStringArgRefs(exp.text, 'cstore')),
        basename_refs: basenameRefs(txt, names).filter((b) => b !== self),
        warnings,
      });
      onProgress?.(k + 1, carts.length);
    });
    return stats;
  }

  const fileRefCount = (cs) => cs.load_refs.length + cs.run_refs.length + cs.reload_file_refs.length + cs.cstore_file_refs.length;

  /** show_project_summary_view: used / unused carts and totals. */
  function summarize(stats) {
    const referenced = new Set();
    const addRef = (r) => {
      referenced.add(r);
      if (r.endsWith('.p8')) referenced.add(r.slice(0, -3));
      // references are usually written without the folder
      referenced.add(basename(r));
      if (r.endsWith('.p8')) referenced.add(basename(r).slice(0, -3));
    };
    for (const cs of stats) {
      for (const r of [...cs.load_refs, ...cs.run_refs, ...cs.reload_file_refs, ...cs.cstore_file_refs, ...cs.includes_out.map((i) => i.replace(/(\.p8):\d+$/i, '$1'))]) addRef(r);
      for (const r of cs.basename_refs) referenced.add(r);
    }
    const used = [];
    const unused = [];
    for (const cs of stats) {
      const base = cs.name.endsWith('.p8') ? cs.name.slice(0, -3) : cs.name;
      const incoming = referenced.has(cs.name) || referenced.has(base) || referenced.has(basename(cs.name)) || referenced.has(stem(cs.name)) || referenced.has(stem(cs.name).toLowerCase());
      const outgoing = cs.includes_out.length || fileRefCount(cs);
      (incoming || outgoing ? used : unused).push(cs);
    }
    return {
      total: stats.length,
      used, unused,
      tokensSelf: used.reduce((s, c) => s + c.tokens_self, 0),
      charsSelf: used.reduce((s, c) => s + c.chars_self, 0),
      overTokens: stats.filter((c) => c.tokens_expanded > TOKEN_LIMIT),
      overChars: stats.filter((c) => c.chars_expanded > CHAR_LIMIT),
    };
  }

  const CSV_COLUMNS = ['cart', 'path', 'mtime', 'tokens_expanded', 'tokens_self', 'chars_expanded', 'chars_self', 'includes_out', 'includes_in', 'load_refs', 'run_refs', 'reload_refs', 'cstore_refs', 'basename_refs', 'warnings'];

  function toCsv(stats, root = '') {
    const q = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [CSV_COLUMNS];
    for (const c of stats) {
      rows.push([c.name, root ? `${root}/${c.path}` : c.path, c.mtime == null ? '' : Math.trunc(c.mtime / 1000), c.tokens_expanded, c.tokens_self, c.chars_expanded, c.chars_self,
        c.includes_out.join(';'), c.includes_in.join(';'), c.load_refs.join(';'), c.run_refs.join(';'), c.reload_file_refs.join(';'), c.cstore_file_refs.join(';'), c.basename_refs.join(';'), c.warnings.join(';')]);
    }
    return `${rows.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
  }

  /** Same keys as the desktop JSON export (asdict(CartStats)); mtime in seconds. */
  function toJson(stats, root = '') {
    return JSON.stringify(stats.map((c) => ({
      path: root ? `${root}/${c.path}` : c.path, name: c.name, mtime: c.mtime == null ? null : c.mtime / 1000,
      tokens_self: c.tokens_self, tokens_expanded: c.tokens_expanded, chars_self: c.chars_self, chars_expanded: c.chars_expanded,
      includes_out: c.includes_out, includes_in: c.includes_in, load_refs: c.load_refs, run_refs: c.run_refs,
      reload_file_refs: c.reload_file_refs, cstore_file_refs: c.cstore_file_refs, basename_refs: c.basename_refs, warnings: c.warnings,
    })), null, 2);
  }

  return {
    TOKEN_LIMIT, CHAR_LIMIT,
    extractLua, parseIncludes, stripComments, countTokens, resolveInclude, expandIncludes, makeFs, normPath,
    readIncludeFiles, includeReport, includeMeter,
    scanProject, summarize, fileRefCount, toCsv, toJson,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Audit;
