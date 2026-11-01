// js/audit-core.js
// Pure logic of Project Audit (port of project_audit/core + ui/scanner_worker.py):
// #include expansion, token / character counts, cart references, project summary.
// No DOM; runs in Node for tests. Files are given as a Map of 'dir/name.p8' -> text.

'use strict';

const P8Audit = (() => {
  const TOKEN_LIMIT = 8192;
  const CHAR_LIMIT = 65535;

  const SECTION_RE = /^__([a-z0-9_]+)__$/i;
  const INCLUDE_RE = /^\s*#include\s+(.+?)\s*$/i;

  /** Lua between __lua__ and the next __section__ marker ('' if there is none). */
  function extractLua(p8) {
    const lines = p8.split(/(?<=\n)/);
    const start = lines.findIndex((l) => l.trim().toLowerCase() === '__lua__');
    if (start < 0) return '';
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) if (SECTION_RE.test(lines[j].trim())) { end = j; break; }
    return lines.slice(start + 1, end).join('');
  }

  const cleanInclude = (raw) => raw.trim().replace(/^["']+|["']+$/g, '').trim();

  function parseIncludes(lua) {
    const out = [];
    for (const ln of lua.split(/\r?\n/)) {
      const m = INCLUDE_RE.exec(ln);
      if (m) out.push(cleanInclude(m[1]));
    }
    return out;
  }

  const stripIncludes = (lua) => lua.split(/(?<=\n)/).filter((ln) => !INCLUDE_RE.test(ln.replace(/\r?\n$/, ''))).join('');

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

  const includePayload = (path, text) => (path.toLowerCase().endsWith('.p8') ? extractLua(text) : text);

  /** expand_includes: returns {text, resolved[]}; appends to warnings. */
  function expandIncludes(fs, path, lua, visited, warnings, depth = 0) {
    if (depth > 50) { warnings.push(`include depth exceeded at ${path}`); return { text: lua, resolved: [] }; }
    const dir = dirname(path);
    const resolved = [];
    let out = '';
    for (const ln of lua.split(/(?<=\n)/)) {
      const m = INCLUDE_RE.exec(ln.replace(/\r?\n$/, ''));
      if (!m) { out += ln; continue; }
      const raw = cleanInclude(m[1]);
      const target = resolveInclude(fs, dir, raw);
      if (!target) {
        warnings.push(`unresolved include: ${raw}`);
        out += `-- [[unresolved include: ${raw}]]\n`;
        continue;
      }
      const id = target.toLowerCase();
      if (visited.has(id)) {
        warnings.push(`include cycle detected: ${raw}`);
        out += `-- [[include cycle: ${raw}]]\n`;
        continue;
      }
      // visited is the active include stack (cycle detection), not a global dedup:
      // a file included twice, or via two branches, expands at each occurrence like PICO-8 does.
      visited.add(id);
      resolved.push(target);
      const child = expandIncludes(fs, target, includePayload(target, fs.read(target)), visited, warnings, depth + 1);
      visited.delete(id);
      resolved.push(...child.resolved);
      out += `-- [[begin include: ${raw}]]\n${child.text}${child.text.endsWith('\n') ? '' : '\n'}-- [[end include: ${raw}]]\n`;
    }
    return { text: out, resolved };
  }

  // Comments + tokens ---------------------------------------------------- //

  /** strip_comments_preserve_strings */
  function stripComments(src) {
    let i = 0;
    const n = src.length;
    let out = '';
    while (i < n) {
      const ch = src[i];
      if (src.startsWith('[[', i)) {
        const end = src.indexOf(']]', i + 2);
        const stop = end < 0 ? n : end + 2;
        out += src.slice(i, stop);
        i = stop;
        continue;
      }
      if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === ch) { j++; break; }
          j++;
        }
        out += src.slice(i, Math.min(j, n));
        i = j;
        continue;
      }
      if (src.startsWith('--[[', i)) {
        const end = src.indexOf(']]', i + 4);
        if (end < 0) break;
        i = end + 2;
        continue;
      }
      if (src.startsWith('--', i)) {
        i += 2;
        while (i < n && src[i] !== '\n') i++;
        if (i < n) { out += '\n'; i++; }
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  const OPS = ['...', '>>>', '<<', '>>', '==', '~=', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '..=', '..', '^^', '||', '&&'];
  const SINGLE_OPS = new Set('+-*/%^#=<>|&~:@?$\\');
  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdentStart = (c) => /[\p{L}_]/u.test(c);
  const isIdent = (c) => /[\p{L}\p{N}_]/u.test(c);
  const isSpace = (c) => /\s/.test(c);

  /** count_tokens_fallback: best-effort PICO-8 token count (see project_audit/core/tokenizer.py). */
  function countTokens(lua) {
    const src = stripComments(stripIncludes(lua));
    const n = src.length;
    let i = 0;
    let tokens = 0;
    let last = null;
    const scanDecimal = (j) => {
      while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;
      if (j < n && (src[j] === 'e' || src[j] === 'E')) {
        j++;
        if (j < n && (src[j] === '+' || src[j] === '-')) j++;
        while (j < n && isDigit(src[j])) j++;
      }
      return j;
    };
    while (i < n) {
      const c = src[i];
      if (isSpace(c)) { i++; continue; }
      if (c === "'" || c === '"') {
        i++;
        while (i < n) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === c) { i++; break; }
          i++;
        }
        tokens++; last = 'string';
        continue;
      }
      if (src.startsWith('[[', i)) {
        const end = src.indexOf(']]', i + 2);
        i = end < 0 ? n : end + 2;
        tokens++; last = 'string';
        continue;
      }
      if ('([{'.includes(c)) { tokens++; last = 'open'; i++; continue; }
      if (')]}'.includes(c)) { last = 'close'; i++; continue; }
      if (',.;'.includes(c) && !(c === '.' && i + 1 < n && isDigit(src[i + 1]))) {
        if (!(c === '.' && src.startsWith('..', i))) { last = 'ignored'; i++; continue; }
      }
      if (c === '-' && i + 1 < n && isDigit(src[i + 1]) && !['number', 'ident', 'close', 'string'].includes(last)) {
        i = scanDecimal(i + 1);
        tokens++; last = 'number';
        continue;
      }
      if (isDigit(c) || (c === '.' && i + 1 < n && isDigit(src[i + 1]))) {
        let j = i;
        if (/^0x/i.test(src.slice(i, i + 2))) {
          j += 2;
          while (j < n && /[0-9a-f.]/i.test(src[j])) j++;
        } else if (/^0b/i.test(src.slice(i, i + 2))) {
          j += 2;
          while (j < n && (src[j] === '0' || src[j] === '1')) j++;
          if (j < n && src[j] === '.' && j + 1 < n && isDigit(src[j + 1])) { j++; while (j < n && isDigit(src[j])) j++; }
        } else {
          j = scanDecimal(j);
        }
        tokens++; last = 'number';
        i = j;
        continue;
      }
      if (isIdentStart(c)) {
        let j = i + 1;
        while (j < n && isIdent(src[j])) j++;
        const word = src.slice(i, j).toLowerCase();
        if (word !== 'local' && word !== 'end') { tokens++; last = 'ident'; } else last = 'ignored';
        i = j;
        continue;
      }
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op) { tokens++; last = 'operator'; i += op.length; continue; }
      if (SINGLE_OPS.has(c)) { tokens++; last = 'operator'; i++; continue; }
      last = 'unknown';
      i++;
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
        const t = resolveInclude(fs, dirname(p), inc);
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
      for (const r of [...cs.load_refs, ...cs.run_refs, ...cs.reload_file_refs, ...cs.cstore_file_refs, ...cs.includes_out]) addRef(r);
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
    scanProject, summarize, fileRefCount, toCsv, toJson,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Audit;
