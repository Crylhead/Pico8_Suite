// js/project-core.js
// Demo projects (pure logic, no DOM): assets and their parts, --@data anchors in the fx code,
// packing parts into data carts, writing and checking. Spec: docs/PROJECT_MODEL.md
//
//   project = { format, prefix, carts: [{name, items: [{ref, off}]}], unmanaged: [cart names] }
//   asset   = { format, name, type, meta, parts: {id: {bytes: Uint8Array, lz, group}} }
//   ref     = "asset.part"
//   anchor  = a reload() line in an fx cart ending in  --@data asset.part[+offset]

'use strict';

const P8Project = (() => {
  const C = typeof P8Cart !== 'undefined' ? P8Cart : require('./cart-core.js');
  const V = typeof P8DataView !== 'undefined' ? P8DataView : require('./datacarts-core.js');
  const K = typeof P8Code !== 'undefined' ? P8Code : require('./code-core.js'); // the shared Lua lexer
  const FORMAT = 1;
  const CART = C.ROM_SIZE; // 0x4300 bytes per data cart
  const hex = (n) => `0x${(n >>> 0).toString(16).padStart(4, '0')}`;
  const TYPES = ['image', 'layered', 'palette', 'fades', 'tiles', 'table', 'cartset'];

  // ------------------------------------------------------------------ //
  // Bytes <-> text (asset files)                                       //
  // ------------------------------------------------------------------ //

  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
  };
  const fromB64 = (b) => {
    const s = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('binary');
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };

  function assetToJson(a) {
    const parts = {};
    for (const [id, p] of Object.entries(a.parts)) parts[id] = { bytes: toB64(p.bytes), lz: !!p.lz, group: p.group || null };
    return JSON.stringify({ format: FORMAT, name: a.name, type: a.type, meta: a.meta || {}, parts }, null, 1);
  }
  function assetFromJson(text) {
    const j = JSON.parse(text);
    const parts = {};
    for (const [id, p] of Object.entries(j.parts || {})) parts[id] = { bytes: fromB64(p.bytes), lz: !!p.lz, group: p.group || null };
    return { format: j.format, name: j.name, type: TYPES.includes(j.type) ? j.type : 'table', meta: j.meta || {}, parts };
  }

  const safeName = (s) => (s.replace(/\.p8$/i, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').toLowerCase() || 'data');

  // ------------------------------------------------------------------ //
  // Anchors                                                            //
  // ------------------------------------------------------------------ //

  // --@data asset.part[+offset]   one part (offset: decimal or 0x hex, 0..0xffff)
  // --@data asset[]               a cart set: reload(dest,src,len,list[i]) over the carts in `list`
  // The payload ends the line: only whitespace, or whitespace and a `--` comment, may follow.
  const MARKER = /--@data(?![A-Za-z0-9_])/i;

  /**
   * The --@data anchor of one line -> null (no marker) | {set, ref, sub, ranged, error}.
   * The whole payload is checked: anything else after a marker is an `error` (with set / ref
   * when the name could still be read), never a shorter anchor.
   */
  function parseAnchor(line) {
    const m = MARKER.exec(line);
    if (!m) return null;
    const rest = line.slice(m.index + m[0].length);
    const a = { set: null, ref: null, sub: 0, ranged: false, error: null };
    const bad = (error) => ({ ...a, error });
    const name = /^\s+([A-Za-z_]\w*)(?:(\[\])|\.([A-Za-z_]\w*))?/.exec(rest);
    if (!name || (!name[2] && !name[3])) return bad(`--@data needs asset.part or asset[] after it, not “${rest.trim() || 'nothing'}”`);
    if (name[2]) a.set = name[1]; else a.ref = `${name[1]}.${name[3]}`;
    let tail = rest.slice(name[0].length);
    const plus = /^\s*\+\s*/.exec(tail);
    if (plus) {
      const off = /^\S*/.exec(tail.slice(plus[0].length))[0];
      tail = tail.slice(plus[0].length + off.length);
      a.ranged = true;
      if (a.set) return bad(`the cart set anchor ${a.set}[] takes no +offset`);
      if (!off) return bad(`--@data ${a.ref}+ has no offset after the +`);
      if (!/^(?:0x[\da-f]+|\d+)$/i.test(off)) return bad(`the offset “+${off}” of --@data ${a.ref} is not a decimal or 0x hex number`);
      a.sub = C.parseNum(off);
      if (a.sub > 0xffff) return bad(`the offset +${off} of --@data ${a.ref} does not fit in 16 bits`);
    }
    if (!/^(?:\s*$|\s+--)/.test(tail)) return bad(`unexpected “${tail.trim()}” after --@data ${a.set ? `${a.set}[]` : a.ref}; only whitespace or a “ -- comment” may follow an anchor`);
    if (MARKER.test(tail)) return bad('more than one --@data anchor on the line');
    return a;
  }

  // ------------------------------------------------------------------ //
  // Executable Lua (shared lexer): what mutation and retirement may     //
  // rely on. Comments, strings and long brackets never count as code.   //
  // ------------------------------------------------------------------ //

  const SKIP = new Set(['ws', 'comment', 'tabsep', 'include']);
  const NAME = new Set(['ident', 'api', 'callback']);
  // assignment operators (PICO-8 also has the compound ones: += ..= |= ...)
  const isAssign = (s) => s === '=' || (s.length > 1 && s.endsWith('=') && !['==', '~=', '!=', '<=', '>='].includes(s));

  /** the Lua of a cart text (or the whole text of a .lua file) -> {code, at (offset in text), firstLine (0-based)} */
  function luaOf(text) {
    const m = /^__lua__[ \t\r]*$/m.exec(text);
    if (!m) return { code: text, at: 0, firstLine: 0 };
    const at = Math.min(text.length, m.index + m[0].length + 1);
    const e = /^__\w+__[ \t\r]*$/m.exec(text.slice(at));
    const end = e ? Math.max(at, at + e.index - 1) : text.length;
    return { code: text.slice(at, end), at, firstLine: text.slice(0, at).split('\n').length - 1 };
  }

  /**
   * Lexical view of one cart's Lua: every token (toks) and the significant ones (sig, no whitespace,
   * comments or #include lines) with, per significant token, the bracket depth, whether it is in a
   * declaration list (local a,b / for a,b) or a function's parameter list.
   */
  function luaContext(text) {
    const { code, at, firstLine } = luaOf(text);
    const toks = K.lex(code);
    const sig = toks.filter((tk) => !SKIP.has(tk.t));
    const src = (tk) => (tk ? code.slice(tk.s, tk.e) : '');
    const index = new Map(sig.map((tk, k) => [tk.s, k]));
    const pairs = K.bracketPairs(sig, code);
    const partner = (k) => { const p = sig[k] ? pairs.get(sig[k].s) : null; return p == null ? -1 : index.get(p); };
    const nl = [];
    for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) nl.push(i);
    /** code offset -> 0-based line of the whole text */
    const lineOf = (off) => { let lo = 0; let hi = nl.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < off) lo = mid + 1; else hi = mid; } return firstLine + lo; };
    const info = [];
    const stack = [];
    let decl = false;
    let paramEnd = -1;
    sig.forEach((tk, k) => {
      const s = src(tk);
      if (decl && !(NAME.has(tk.t) || s === ',')) decl = false;
      info.push({ depth: stack.length, top: stack[stack.length - 1] || null, decl, param: tk.s < paramEnd });
      if (tk.t === 'bracket') { if ('([{'.includes(s)) stack.push(s); else stack.pop(); }
      if (tk.t === 'keyword' && (s === 'local' || s === 'for')) decl = src(sig[k + 1]) !== 'function';
      if (tk.t === 'keyword' && s === 'function') {
        let j = k + 1;
        while (j < sig.length && (NAME.has(sig[j].t) || sig[j].t === 'self' || ['.', ':'].includes(src(sig[j])))) j++;
        const close = src(sig[j]) === '(' ? partner(j) : -1;
        if (close >= 0) paramEnd = Math.max(paramEnd, sig[close].s);
      }
    });
    return {
      text, code, at, firstLine, toks, sig, src, partner, lineOf, info,
      env: sig.some((tk) => NAME.has(tk.t) && (src(tk) === '_ENV' || src(tk) === '_G')),
      includes: toks.filter((tk) => tk.t === 'include'),
    };
  }

  /** the arguments of the call whose name is sig[k] -> {close (sig index of ")"), args: [{from, to (sig indexes), text}]} | null */
  function callAt(ctx, k) {
    const { sig, src, partner, code } = ctx;
    if (src(sig[k + 1]) !== '(') return null;
    const close = partner(k + 1);
    if (close < 0) return null;
    const args = [];
    let from = -1;
    let to = -1;
    for (let j = k + 2; j <= close; j++) {
      const s = src(sig[j]);
      if (j === close || s === ',') {
        if (from >= 0) args.push({ from, to, text: code.slice(sig[from].s, sig[to].e) });
        else if (j !== close || args.length) args.push({ from: j, to: j - 1, text: '' });
        from = -1;
        continue;
      }
      if (from < 0) from = j;
      const p = sig[j].t === 'bracket' && '([{'.includes(s) ? partner(j) : -1;
      to = p >= 0 ? p : j;
      if (p >= 0) j = p;
    }
    return { close, args };
  }

  /** executable calls name(...) (not obj.name / obj:name / definitions) -> [{k, s, e (code offsets), line, endLine, args}] */
  function realCalls(ctx, name) {
    const out = [];
    ctx.sig.forEach((tk, k) => {
      if (!NAME.has(tk.t) || ctx.src(tk) !== name) return;
      const prev = ctx.src(ctx.sig[k - 1]);
      if (prev === '.' || prev === ':' || prev === 'function' || ctx.info[k].param) return;
      const call = callAt(ctx, k);
      if (!call) return;
      const end = ctx.sig[call.close];
      out.push({ k, s: tk.s, e: end.e, line: ctx.lineOf(tk.s), endLine: ctx.lineOf(end.s), args: call.args });
    });
    return out;
  }

  /** a plain string literal ("x", 'x', [[x]]: no escapes, quotes or line breaks) -> its text, or null */
  function plainString(s) {
    const m = /^(?:"([^"'\\\n]*)"|'([^"'\\\n]*)'|\[(=*)\[\n?([^"'\]\n]*)\]\3\])$/.exec(s);
    return m ? (m[1] ?? m[2] ?? m[4]) : null;
  }

  /** whether the expression goes on at sig[j] (so the value before it is only part of it) */
  function goesOn(ctx, j) {
    const tk = ctx.sig[j];
    if (!tk) return false;
    const s = ctx.src(tk);
    if (tk.t === 'string' || ['(', '[', '{'].includes(s)) return true;
    if (tk.t === 'keyword') return s === 'and' || s === 'or';
    return tk.t === 'op' && s !== ';' && s !== '?';
  }

  /**
   * The one binding of `name` that the executable code allows to be trusted, or why there is none.
   * Every token `name` that is not a field (a.name), a table key ({name=...}) or the binding itself
   * must be a read: a second assignment, a compound assignment, a declaration (parameter, loop
   * variable, local without the value), a multiple assignment, an #include the binding is visible to
   * or _ENV/_G for a global make it unprovable. kind 'list' also allows only cs[...] (never assigned),
   * #cs and all/ipairs/pairs/count(cs): any other use may hand the table to code that changes it.
   * -> {k (sig index of the name), rhs (sig index after "="), local} | {why}
   */
  function bindingOf(ctx, name, kind, useAt) {
    const { sig, src, info } = ctx;
    const defs = [];
    const other = [];
    for (let k = 0; k < sig.length; k++) {
      const tk = sig[k];
      if (!NAME.has(tk.t) || src(tk) !== name) continue;
      const prev = src(sig[k - 1]);
      const next = src(sig[k + 1]);
      if (prev === '.' || prev === ':') continue;
      if (info[k].top === '{' && ['{', ',', ';'].includes(prev) && next === '=') continue;
      const local = prev === 'local' && next === '=';
      if (info[k].param || prev === 'function' || (info[k].decl && !local)) { other.push([k, 'is declared again (parameter, loop variable or local without a value)']); continue; }
      if (next === '=') {
        if (prev === ',' || info[k].depth > 0) other.push([k, 'is assigned in a multiple assignment']);
        else defs.push({ k, local, rhs: k + 2 });
        continue;
      }
      if (isAssign(next)) { other.push([k, `is changed with ${next}`]); continue; }
      if (next === ',' && info[k].depth === 0) { other.push([k, 'may be assigned in a multiple assignment']); continue; }
      if (kind !== 'list') continue; // a string cannot be changed through a read
      if (next === '[') {
        const close = ctx.partner(k + 1);
        if (close < 0) other.push([k, 'is indexed without a closing ]']);
        else if (isAssign(src(sig[close + 1]))) other.push([k, `has an entry replaced (${ctx.code.slice(tk.s, sig[close + 1].e)})`]);
        continue;
      }
      if (prev === '#') continue;
      const fn = src(sig[k - 2]);
      if (prev === '(' && next === ')' && ['all', 'ipairs', 'pairs', 'count'].includes(fn) && !['.', ':'].includes(src(sig[k - 3]))) continue;
      other.push([k, 'is used as a whole (code it is handed to may change it)']);
    }
    const at = (k) => `line ${ctx.lineOf(sig[k].s) + 1}`;
    if (!defs.length) return { why: `${name} is never assigned in this code` };
    if (defs.length > 1) return { why: `${name} is assigned more than once (${defs.map((d) => at(d.k)).join(', ')})` };
    if (other.length) return { why: `${name} ${other[0][1]} at ${at(other[0][0])}` };
    const d = defs[0];
    if (!d.local && ctx.env) return { why: `the code uses _ENV/_G, which can change the global ${name}` };
    const inc = ctx.includes.find((i) => !d.local || i.s > sig[d.k].s);
    if (inc) return { why: `#include at line ${ctx.lineOf(inc.s) + 1} brings code that may change ${name}` };
    if (d.local && useAt != null && useAt < sig[d.k].s) return { why: `${name} is used before its local declaration (${at(d.k)})` };
    return d;
  }

  /**
   * The string value of the expression sig[from..to] if the code proves it: plain string literals,
   * whole decimal numbers and names bound once to such a value, joined by "..". -> {value} | {why}
   */
  function stringValue(ctx, from, to, useAt, depth = 0) {
    const { sig, src } = ctx;
    const text = ctx.code.slice(sig[from]?.s ?? 0, sig[to]?.e ?? 0);
    if (to < from || (to - from) % 2) return { why: `the cart name ${text} is computed` };
    for (let j = from + 1; j < to; j += 2) if (src(sig[j]) !== '..') return { why: `the cart name ${text} is computed` };
    let value = '';
    for (let j = from; j <= to; j += 2) {
      const tk = sig[j];
      const s = src(tk);
      if (tk.t === 'string') {
        const v = plainString(s);
        if (v == null) return { why: `the cart name ${s} cannot be resolved` };
        value += v;
      } else if (tk.t === 'number' && /^\d+$/.test(s)) value += String(Number(s));
      else if (NAME.has(tk.t)) {
        if (depth > 3) return { why: `${s} is bound through too many names to follow` };
        const b = bindingOf(ctx, s, 'string', useAt);
        if (b.why) return b;
        let end = b.rhs;
        while (src(sig[end + 1]) === '..') end += 2;
        if (goesOn(ctx, end + 1)) return { why: `${s} is assigned a computed value (line ${ctx.lineOf(sig[b.k].s) + 1})` };
        const v = stringValue(ctx, b.rhs, end, sig[b.k].s, depth + 1);
        if (v.why) return v.why.startsWith('the cart name') ? { why: `${s} is assigned a computed value (line ${ctx.lineOf(sig[b.k].s) + 1})` } : v;
        value += v.value;
      } else return { why: `the cart name ${text} is computed` };
    }
    return { value };
  }

  /**
   * The cart list that list[index] (sig[from..to]) reads, proven from the executable code: one binding
   * `[local] list = {"a.p8", 'b.p8'; [[c.p8]]}` of plain strings (comments and , ; allowed), no other
   * change to list (bindingOf). -> {name, open, close (text offsets inside the braces), entries:
   * [{s, e (text offsets), name}], carts, comments, line} | {why}
   */
  function cartList(ctx, from, to, useAt) {
    const { sig, src } = ctx;
    const text = ctx.code.slice(sig[from]?.s ?? 0, sig[to]?.e ?? 0);
    if (!(sig[from] && NAME.has(sig[from].t) && src(sig[from + 1]) === '[' && ctx.partner(from + 1) === to)) return { why: `${text} is not a complete list index name[i]` };
    const name = src(sig[from]);
    const b = bindingOf(ctx, name, 'list', useAt);
    if (b.why) return b;
    const line = ctx.lineOf(sig[b.k].s) + 1;
    const open = b.rhs;
    const close = src(sig[open]) === '{' ? ctx.partner(open) : -1;
    if (close < 0) return { why: `${name} is not assigned a table literal {"a.p8", ...} (line ${line})` };
    if (goesOn(ctx, close + 1)) return { why: `the table literal of ${name} is part of a longer expression (line ${line})` };
    const entries = [];
    for (let j = open + 1; j < close; j++) {
      const tk = sig[j];
      const v = tk.t === 'string' ? plainString(src(tk)) : null;
      const sep = j + 1 === close || [',', ';'].includes(src(sig[j + 1]));
      if (v && sep) { entries.push({ s: ctx.at + tk.s, e: ctx.at + tk.e, name: v }); j++; continue; }
      let e = j;
      for (;;) {
        if (sig[e].t === 'bracket' && ctx.partner(e) > e) e = ctx.partner(e);
        if (e + 1 >= close || [',', ';'].includes(src(sig[e + 1]))) break;
        e++;
      }
      const entry = ctx.code.slice(tk.s, sig[e].e);
      return { why: v && src(sig[j + 1]) === '..' ? `the entry ${entry} of ${name} is concatenated, not a literal cart name (line ${line})` : `the entry ${entry} of ${name} is not a plain "name.p8" string (line ${line})` };
    }
    if (!entries.length || entries.some((en) => !en.name)) return { why: `the list ${name} is empty or has an empty name (line ${line})` };
    const comments = ctx.toks.some((tk) => tk.t === 'comment' && tk.s > sig[open].s && tk.s < sig[close].s);
    return { name, open: ctx.at + sig[open].e, close: ctx.at + sig[close].s, entries, carts: entries.map((en) => en.name), comments, line };
  }

  /**
   * The carts a cart-name argument (sig[from..to]) can name, for destructive decisions: only what
   * the code proves (literal, single-bound names, fully resolvable "..", proven cart lists).
   * -> {names: [cart names as written]} ([] = the running cart) | {why}
   */
  function cartTargets(ctx, from, to, useAt) {
    if (to < from || (from === to && ctx.src(ctx.sig[from]) === 'nil')) return { names: [] };
    if (NAME.has(ctx.sig[from].t) && ctx.src(ctx.sig[from + 1]) === '[') {
      const l = cartList(ctx, from, to, useAt);
      return l.why ? l : { names: l.carts };
    }
    const v = stringValue(ctx, from, to, useAt);
    return v.why ? v : { names: [v.value] };
  }

  /**
   * Anchors in one cart's text, found through the shared lexer: a --@data marker in a real line
   * comment of the Lua (never inside a string or a long comment), anchoring the one executable
   * reload() call on that line. Several calls on the line, or a call spread over several lines, is a
   * `problem` (never a guess). Cart-set anchors carry their proven `list` (cartList) or its why.
   * -> [{line (0-based), ref | set, sub, ranged, error, problem, call: {s, e (text offsets), args: [text]} | null, list, lz, text, name, nameAt}]
   */
  function findAnchors(text, ctx = luaContext(text)) {
    const out = [];
    const lines = text.split('\n');
    const reloads = realCalls(ctx, 'reload');
    const unlz = new Set(realCalls(ctx, 'unlz').map((c) => c.line));
    for (const tk of ctx.toks) {
      if (tk.t !== 'comment') continue;
      const c = ctx.code.slice(tk.s, tk.e);
      if (/^--\[=*\[/.test(c)) continue; // a long comment is never an anchor
      const a = parseAnchor(c);
      if (!a) continue;
      const line = ctx.lineOf(tk.s);
      const m = MARKER.exec(c);
      const nm = /^(\s+)([A-Za-z_]\w*)(?=\.|\[\])/.exec(c.slice(m.index + m[0].length));
      const on = reloads.filter((r) => r.line <= line && r.endLine >= line);
      const r = on.length === 1 ? on[0] : null;
      const problem = on.length > 1 ? `more than one reload() on the anchored line ${line + 1}; put each anchored call on its own line`
        : r && r.line !== r.endLine ? `the anchored reload() spans several lines (${r.line + 1}–${r.endLine + 1}); put it on one line with its anchor` : null;
      const call = r && !problem ? { s: ctx.at + r.s, e: ctx.at + r.e, args: r.args.map((x) => x.text) } : null;
      const list = call && a.set && r.args.length >= 4 ? cartList(ctx, r.args[3].from, r.args[3].to, r.s) : null;
      out.push({ line, ...a, problem, call, list, lz: unlz.has(line), text: lines[line].trim(), name: nm ? nm[2] : null, nameAt: nm ? ctx.at + tk.s + m.index + m[0].length + nm[1].length : null });
    }
    return out.sort((x, y) => x.line - y.line);
  }

  /**
   * Rewrites src / len / cart of every anchored reload() in `text` (and, for cart sets, the cart
   * names in the proven list binding). where(ref) -> {cart, off, len, lz}; whereSet(name) -> {off, len, carts}.
   * Only the anchored calls and the list entries change; a rejected anchor changes nothing.
   * -> {text, changes: [..], errors: [..]}
   */
  function rewriteAnchors(text, where, whereSet = () => null) {
    const lines = text.split('\n');
    const changes = [];
    const errors = [];
    const edits = []; // {s, e, text} in text offsets, never overlapping
    const lists = new Map(); // list binding offset -> {set, line}
    for (const a of findAnchors(text)) {
      const id = a.set ? `${a.set}[]` : a.ref;
      const fail = (msg) => errors.push({ line: a.line + 1, ref: id || '--@data', msg });
      if (a.error) { fail(a.error); continue; }
      const problem = anchorCallProblem(a);
      if (problem) { fail(problem); continue; }
      let call;
      if (a.set) {
        const ps = whereSet(a.set);
        if (!ps) { fail(`no cart set “${a.set}” in the project`); continue; }
        const l = a.list;
        const prior = lists.get(l.open);
        if (prior && prior.set !== a.set) { fail(`the cart list ${l.name} (line ${l.line}) is already the list of ${prior.set}[] (line ${prior.line}); one list cannot hold two sets`); continue; }
        if (!prior) {
          const same = l.entries.length === ps.carts.length;
          if (!same && l.comments) { fail(`the cart list ${l.name} (line ${l.line}) has comments and would change from ${l.entries.length} to ${ps.carts.length} carts; edit it by hand`); continue; }
          lists.set(l.open, { set: a.set, line: a.line + 1 });
          const body = ps.carts.map((c) => `"${c}"`).join(', ');
          const before = text.slice(l.open, l.close);
          const listEdits = same ? l.entries.filter((en, k) => en.name !== ps.carts[k]).map((en) => ({ s: en.s, e: en.e, text: `"${ps.carts[l.entries.indexOf(en)]}"` }))
            : [{ s: l.open, e: l.close, text: body }];
          if (listEdits.length) {
            let after = before;
            for (const ed of [...listEdits].sort((x, y) => y.s - x.s)) after = after.slice(0, ed.s - l.open) + ed.text + after.slice(ed.e - l.open);
            changes.push({ line: l.line, ref: id, before: `${l.name}={${before.trim()}}`, after: `${l.name}={${after.trim()}}` });
            edits.push(...listEdits);
          }
        }
        call = `reload(${a.call.args[0]},${hex(ps.off)},${hex(ps.len)},${a.call.args[3]})`;
      } else {
        const p = where(a.ref);
        if (!p) { fail(`no part “${a.ref}” in the project`); continue; }
        const bad = anchorRangeProblem(a, p);
        if (bad) { fail(bad); continue; }
        // an explicit +offset (even +0x0) marks a sub-range read: it keeps its own length.
        // a bare ref reads the whole part, so it follows the part when it is resized.
        const len = a.ranged ? constExpr(a.call.args[2]).value : p.len;
        call = `reload(${a.call.args[0]},${hex(p.off + a.sub)},${hex(len)},"${p.cart}")`;
      }
      if (text.slice(a.call.s, a.call.e) !== call) {
        const line = lines[a.line];
        const at = a.call.s - (text.lastIndexOf('\n', a.call.s - 1) + 1);
        changes.push({ line: a.line + 1, ref: id, before: line.trim(), after: (line.slice(0, at) + call + line.slice(at + a.call.e - a.call.s)).trim() });
        edits.push({ s: a.call.s, e: a.call.e, text: call });
      }
    }
    let out = text;
    for (const ed of edits.sort((x, y) => y.s - x.s)) out = out.slice(0, ed.s) + ed.text + out.slice(ed.e);
    return { text: out, changes, errors };
  }

  /**
   * Why an anchored reload() cannot be rewritten without changing what the fx does, or null.
   * The builder owns the source, length and cart name of an anchored call, so they must be
   * literal: a computed one (e.g. frame*0x200) would be replaced by a fixed value.
   */
  function anchorCallProblem(a) {
    if (a.problem) return a.problem;
    if (!a.call || a.call.args.length < 4) return 'no reload(dest,src,len,cart) on this line';
    const s = constExpr(a.call.args[1]);
    if (s.why) return `the source ${a.call.args[1]} ${s.why}; an anchored reload() needs a literal source`;
    const l = constExpr(a.call.args[2]);
    if (l.why) return `the length ${a.call.args[2]} ${l.why}; an anchored reload() needs a literal length`;
    if (!a.set && literalCart(a.call.args[3]) == null) return `the cart name ${a.call.args[3]} is not a literal "name.p8"`;
    if (a.set && a.list?.why) return `the cart list ${a.call.args[3]} cannot be rewritten: ${a.list.why}`;
    return null;
  }

  /**
   * Why an anchor's byte range does not fit its part, or null. part: {len (stored bytes), lz}.
   * A bare anchor reads the whole stored part. A ranged one (+offset, even +0) reads its own
   * length from that offset: for raw parts it must lie inside the part; for LZ parts only the
   * complete stream can be unpacked, so a range must be +0 with exactly the stored length.
   */
  function anchorRangeProblem(a, part) {
    if (!a.ranged || !part) return null;
    const len = constExpr(a.call?.args[2]).value;
    if (len == null) return null; // reported by anchorCallProblem
    if (part.lz) {
      if (a.sub === 0 && len === part.len) return null;
      return `${a.ref} is LZ-packed: unlz() needs the whole stream (${hex(part.len)} bytes from +0), not ${hex(len)} bytes from +${hex(a.sub)}. Use a bare --@data ${a.ref} or store the part raw`;
    }
    if (a.sub >= part.len) return `${a.ref}+${hex(a.sub)} starts past the end of the part (${hex(part.len)} bytes)`;
    if (len <= 0) return `${a.ref}+${hex(a.sub)} reads ${len} bytes; the length must be positive`;
    if (a.sub + len > part.len) return `${a.ref}+${hex(a.sub)} reads ${hex(len)} bytes, but only ${hex(part.len - a.sub)} remain in the part (${hex(part.len)} bytes)`;
    return null;
  }

  /** renames an asset in the real anchor comments of `text` (never in strings or long comments) */
  function renameInText(text, from, to) {
    let out = text;
    for (const a of findAnchors(text).filter((x) => x.name === from).reverse()) out = out.slice(0, a.nameAt) + to + out.slice(a.nameAt + from.length);
    return out;
  }

  /**
   * Conservative constant evaluation for project mutation (adoption and anchor rewrites).
   * Unlike the preview evaluator (V.evalExpr, unknown names = 0), anything that is not literal
   * integer arithmetic is unresolved: names, calls, strings, fractions, overflow past PICO-8's
   * 16-bit integer range and unsupported operators. -> {value} | {why}
   */
  function constExpr(expr) {
    const src = String(expr ?? '').trim();
    if (!src) return { why: 'is empty' };
    const toks = [];
    const re = /\s*(?:(0x[\da-f]*\.?[\da-f]*|0b[01]*\.?[01]*|\d+\.?\d*|\.\d+)|([A-Za-z_]\w*(?:\s*[.:]\s*[A-Za-z_]\w*)*)|(>>>|<<|>>|\^\^|[-+*/\\%&|()])|(\S))/giy;
    for (let m; re.lastIndex < src.length && (m = re.exec(src));) {
      if (m[1]) toks.push({ num: /^0[xb]\.?$/i.test(m[1]) ? NaN : C.parseNum(m[1]) });
      else if (m[2]) toks.push({ name: m[2].replace(/\s+/g, '') });
      else if (m[3]) toks.push({ op: m[3] });
      else return { why: `uses “${m[4]}”, which is not literal integer arithmetic` };
    }
    let i = 0;
    const fail = (why) => { throw new Error(why); };
    const int = (v) => (Number.isInteger(v) && v >= -0x8000 && v <= 0x7fff ? v : fail(`is not an integer in PICO-8's range (${src})`));
    const BIN = [['|'], ['^^'], ['&'], ['<<', '>>', '>>>'], ['+', '-'], ['*', '/', '\\', '%']];
    const apply = (op, a, b) => {
      switch (op) {
        case '|': return a | b;
        case '^^': return a ^ b;
        case '&': return a & b;
        case '<<': return b >= 0 && b < 16 ? a * 2 ** b : fail(`shifts by ${b}`);
        case '>>': return b >= 0 && b < 16 ? a / 2 ** b : fail(`shifts by ${b}`);
        case '>>>': return a >= 0 && b >= 0 && b < 16 ? a / 2 ** b : fail(`shifts by ${b}`);
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b ? a / b : fail('divides by zero');
        case '\\': return b ? Math.floor(a / b) : fail('divides by zero');
        case '%': return b > 0 ? a - Math.floor(a / b) * b : fail(`takes % ${b}`);
        default: return fail(`uses the operator “${op}”`);
      }
    };
    const unary = () => {
      const tk = toks[i];
      if (!tk) fail('ends early');
      if (tk.op === '-') { i++; return int(-unary()); }
      if (tk.op === '(') {
        i++;
        const v = binary(0);
        if (toks[i]?.op !== ')') fail('has unbalanced parentheses');
        i++;
        return v;
      }
      if ('num' in tk) { i++; return int(tk.num); }
      if (tk.name) fail(toks[i + 1]?.op === '(' ? `calls ${tk.name}()` : `depends on “${tk.name}”`);
      return fail(`uses “${tk.op}” unexpectedly`);
    };
    const binary = (level) => {
      if (level === BIN.length) return unary();
      let v = binary(level + 1);
      while (toks[i]?.op && BIN[level].includes(toks[i].op)) { const op = toks[i++].op; v = int(apply(op, v, binary(level + 1))); }
      return v;
    };
    try {
      const value = binary(0);
      if (i < toks.length) { const tk = toks[i]; fail(tk.name ? `depends on “${tk.name}”` : `uses “${tk.op ?? tk.num}” unexpectedly`); }
      return { value };
    } catch (e) {
      return { why: e.message };
    }
  }

  /**
   * The reload() source range of a data cart, if it is safe to adopt or rewrite: literal source and
   * length inside the 0x4300-byte data area. -> {src, len} | {why}
   */
  function constRange(srcExpr, lenExpr) {
    const s = constExpr(srcExpr);
    if (s.why) return { why: `source ${srcExpr} ${s.why}` };
    const l = constExpr(lenExpr);
    if (l.why) return { why: `length ${lenExpr} ${l.why}` };
    if (s.value < 0 || s.value >= CART) return { why: `source ${hex(s.value)} is outside the data area 0x0000..0x42ff` };
    if (l.value <= 0) return { why: `length ${l.value} is not positive` };
    if (s.value + l.value > CART) return { why: `${hex(s.value)} + ${hex(l.value)} reads past the end of the data area (0x4300)` };
    return { src: s.value, len: l.value };
  }

  const literalCart = (expr) => /^(["'])([^"']+)\1$/.exec(String(expr ?? '').trim())?.[2] ?? null;

  // ------------------------------------------------------------------ //
  // Adopting an existing demo                                          //
  // ------------------------------------------------------------------ //

  const isMusic = (n) => /^(m\d+|p\d+|patterns\d*|samples_\d+)\.p8$/i.test(n);
  const isTracks = (n) => /^(tracks|rt)\.p8$/i.test(n);

  const fxBaseOf = (file) => { const b = safeName(file).replace(/^s?fx_/, ''); return /^\d/.test(b) ? `fx${b}` : b.replace(/^_+/, ''); };

  /**
   * Typed regions inside a part's bytes (from the Data Carts analysis of the source cart):
   * [{name, off, len, kind: img|pal|hex, w, pal}]; img = 4-bit image (w px wide), pal = palette /
   * fade table (row 0 = screen palette), hex = other data.
   */
  function segmentsOf(cart, carts, src, len) {
    const out = [];
    for (const s of V.sections(cart, carts)) {
      const a = Math.max(s.start, src);
      const b = Math.min(s.start + s.len, src + len);
      if (b - a < 16) continue;
      const seg = { name: s.label, off: a - src, len: b - a, kind: s.kind, fx: s.fx || null };
      if (s.kind === 'img') seg.w = 128;
      if (s.kind !== 'hex') {
        const pi = V.sectionPalettes(s, cart, carts);
        const auto = pi.screen.find((p) => p.key === pi.auto.screen);
        if (auto) seg.pal = auto.colors;
      }
      if (!out.some((o) => o.off === seg.off && o.len === seg.len)) out.push(seg);
    }
    out.sort((x, y) => x.off - y.off);
    // nothing found: the whole part as one data segment
    return out.length ? out : [{ name: 'data', off: 0, len, kind: 'hex', fx: null }];
  }

  /** whether code offset `off` (a line end) lies inside a token: a long string / comment, or an unterminated quoted string */
  function lineEndOpen(ctx, off) {
    return ctx.toks.some((tk) => {
      if (tk.t === 'ws' || tk.s >= off) return false;
      if (tk.e > off) return true;
      const q = ctx.code[tk.s];
      if (tk.e !== off || tk.t !== 'string' || (q !== '"' && q !== "'")) return false;
      let i = tk.s + 1;
      while (i < tk.e && ctx.code[i] !== q) i += ctx.code[i] === '\\' ? 2 : 1;
      return i >= tk.e;
    });
  }

  /**
   * carts: Map(lower name -> {name, text, rom, lua, luaAt, used, reads}) as Data Carts builds it.
   * Every reload() of a data cart becomes an anchor and its bytes a part:
   *   literal cart name  -> one part (ranges inside a bigger one become sub-anchors asset.part+off)
   *   list[i] cart name  -> a cart set (one part per cart in the literal list), anchor asset[]
   * Music carts, tracks, computed names and reads whose source/length is not literal integer
   * arithmetic inside the data area stay as they are (reported in `skipped`). Carts such a call
   * still reads (or, for an unresolvable name, every source cart) are `keptCarts`, never `adoptedCarts`.
   * A line that already has an anchor is left alone; a malformed one is also reported in `skipped`.
   * -> {project, assets, edits: [{file, line, before, after}], skipped, sourceCarts, adoptedCarts, keptCarts}
   */
  function adopt(carts, { prefix = 'd' } = {}) {
    const ranges = new Map(); // cart -> [{src, len, uses: [{file, line, text}]}]
    const sets = [];          // [{fx, list, carts, src, len, line, text}]
    const skipped = [];       // [{file, line, why, carts?}]: left unchanged; `carts` stay in place
    // the carts a cart-name argument may read, as far as the code proves it; null = cannot tell which
    const mayRead = (ctx, arg, at) => {
      const t = cartTargets(ctx, arg.from, arg.to, at);
      if (t.why) return null;
      const want = new Set(t.names.flatMap((n) => { const b = baseName(n); return [b, `${b}.p8`]; }));
      return [...carts.values()].filter((c) => want.has(c.name.toLowerCase())).map((c) => c.name);
    };
    for (const fx of carts.values()) {
      if (!fx.text) continue;
      const ctx = luaContext(fx.text);
      const lines = fx.text.split('\n');
      const starts = [];
      lines.reduce((o, l) => { starts.push(o); return o + l.length + 1; }, 0);
      const anchors = findAnchors(fx.text, ctx);
      const calls = realCalls(ctx, 'reload');
      for (const call of calls) {
        const i = call.line;
        const line = lines[i];
        const skip = (why, cs) => skipped.push({ file: fx.name, line: i + 1, why: `${why} (left as it is)`, carts: cs });
        const may = () => (call.args.length >= 4 ? mayRead(ctx, call.args[3], call.s) : []);
        const anchor = anchors.find((a) => a.line >= call.line && a.line <= call.endLine);
        if (anchor) {
          // a malformed or ambiguous anchor is never anchored a second time; what its call reads stays in place
          if (anchor.error || anchor.problem) skip(anchor.error || anchor.problem, may());
          continue;
        }
        if (call.args.length < 4) continue;
        if (calls.some((c) => c !== call && c.line <= call.endLine && c.endLine >= call.line)) { skip(`more than one reload() on line ${i + 1}, an anchor could not tell them apart`, may()); continue; }
        if (call.line !== call.endLine) { skip(`the reload() spans several lines (${call.line + 1}–${call.endLine + 1}), an anchor needs it on one line`, may()); continue; }
        if (lineEndOpen(ctx, starts[i] + line.length - ctx.at)) { skip('the line ends inside a string or long comment, an anchor cannot be added after it', may()); continue; }
        const args = call.args.map((a) => a.text);
        const range = constRange(args[1], args[2]);
        const cartName = literalCart(args[3]);
        if (cartName == null) {
          const arg = call.args[3];
          const indexed = NAME.has(ctx.sig[arg.from]?.t) && ctx.src(ctx.sig[arg.from + 1]) === '[';
          const ll = indexed ? cartList(ctx, arg.from, arg.to, call.s) : null;
          const okList = ll && !ll.why && ll.carts.every((c) => carts.has(c.toLowerCase()) && !isMusic(c) && !isTracks(c));
          if (okList && !range.why) { sets.push({ fx: fx.name, list: ll.name, carts: ll.carts, src: range.src, len: range.len, line: i, text: line }); continue; }
          // the carts this call may read stay where they are
          const why = !ll ? `cart name ${args[3]} is computed` : ll.why ? `cart list ${args[3]}: ${ll.why}` : !okList ? 'cart list with music, tracks or missing carts' : range.why;
          skip(why, mayRead(ctx, arg, call.s));
          continue;
        }
        const cn = cartName.toLowerCase();
        if (isMusic(cn) || isTracks(cn)) continue;
        if (!carts.get(cn)) { skipped.push({ file: fx.name, line: i + 1, why: `${cartName} not found` }); continue; }
        if (range.why) { skip(range.why, [carts.get(cn).name]); continue; }
        const r = { src: range.src, len: range.len, uses: [{ file: fx.name, line: i, text: line }] };
        if (!ranges.has(cn)) ranges.set(cn, []);
        const list = ranges.get(cn);
        const same = list.find((x) => x.src === r.src && x.len === r.len);
        if (same) same.uses.push(...r.uses); else list.push(r);
      }
    }
    const assets = [];
    const names = new Set();
    const uniq = (base) => { let n = safeName(base); for (let k = 2; names.has(n); k++) n = `${safeName(base)}_${k}`; names.add(n); return n; };
    const edits = [];
    const refOf = new Map(); // range -> {ref, sub}
    for (const [cn, list] of ranges) {
      const cart = carts.get(cn);
      const secs = V.sections(cart, carts);
      // biggest first, so contained ranges find their container
      list.sort((a, b) => b.len - a.len || a.src - b.src);
      for (const r of list) {
        const host = list.find((h) => h !== r && refOf.has(h) && r.src >= h.src && r.src + r.len <= h.src + h.len);
        if (host) { refOf.set(r, { ref: refOf.get(host).ref, sub: r.src - host.src, partial: r.len < host.len }); continue; }
        const sec = secs.find((s) => s.start === r.src && s.len === r.len);
        const fxBase = fxBaseOf(r.uses[0].file);
        const name = uniq(`${fxBase}_${sec && sec.store?.name ? sec.store.name : cn.replace(/\.p8$/, '')}`);
        const segments = segmentsOf(cart, carts, r.src, r.len);
        const kind = segments.length === 1 ? segments[0].kind : 'mixed';
        const type = kind === 'img' ? 'image' : kind === 'pal' ? 'fades' : 'table';
        const part = type === 'image' ? 'img' : type === 'fades' ? 'fades' : 'bin';
        const meta = { from: `${cart.name} ${hex(r.src)}`, segments: { [part]: segments } };
        if (type === 'image') { meta.w = 128; meta.h = Math.ceil(r.len / 64); }
        if (segments[0].pal) meta.pal = segments[0].pal;
        assets.push({ format: FORMAT, name, type, meta, parts: { [part]: { bytes: cart.rom.slice(r.src, r.src + r.len), lz: false, group: null } } });
        refOf.set(r, { ref: `${name}.${part}`, sub: 0 });
      }
      for (const r of list) {
        const { ref, sub, partial } = refOf.get(r);
        for (const u of r.uses) edits.push({ file: u.file, line: u.line + 1, before: u.text, after: `${u.text.replace(/\s+$/, '')} --@data ${ref}${sub || partial ? `+${hex(sub)}` : ''}` });
      }
    }
    // cart sets: one part per listed cart (c1, c2, ...), all read at the same offset
    for (const st of sets) {
      const name = uniq(`${fxBaseOf(st.fx)}_${st.list}`);
      const parts = {};
      const segments = {};
      st.carts.forEach((cn, k) => {
        const cart = carts.get(cn.toLowerCase());
        parts[`c${k + 1}`] = { bytes: cart.rom.slice(st.src, st.src + st.len), lz: false, group: null };
        segments[`c${k + 1}`] = segmentsOf(cart, carts, st.src, st.len).map((g) => ({ ...g, from: cart.name }));
      });
      assets.push({ format: FORMAT, name, type: 'cartset', meta: { from: `${st.fx}: ${st.list}`, list: st.list, carts: st.carts, segments }, parts });
      edits.push({ file: st.fx, line: st.line + 1, before: st.text, after: `${st.text.replace(/\s+$/, '')} --@data ${name}[]` });
    }
    const used = [...ranges.keys(), ...sets.flatMap((s) => s.carts.map((c) => c.toLowerCase()))];
    // a cart that a skipped call still reads (or might read) is not taken over: it stays in place
    const unknownTarget = skipped.some((s) => s.carts === null);
    const kept = new Set(skipped.flatMap((s) => s.carts || []).map((n) => n.toLowerCase()));
    const adopted = new Set(used.filter((k) => !unknownTarget && !kept.has(k)));
    const keptCarts = [...new Set([...kept, ...used.filter((k) => !adopted.has(k))])].filter((k) => carts.has(k)).map((k) => carts.get(k).name);
    const project = { format: FORMAT, prefix, carts: [], unmanaged: [...carts.values()].filter((c) => isMusic(c.name) || isTracks(c.name)).map((c) => c.name) };
    return { project, assets, edits, skipped, sourceCarts: [...new Set(used)].map((k) => carts.get(k).name), adoptedCarts: [...adopted].map((k) => carts.get(k).name), keptCarts };
  }

  /** the bytes of an image segment -> {w, h, pixels (slot per pixel)} */
  function segmentImage(asset, partId, seg) {
    const b = asset.parts[partId].bytes.subarray(seg.off, seg.off + seg.len);
    const w = seg.w || 128;
    // a last partial row is shown whole (its missing pixels as 0)
    const h = Math.ceil((b.length * 2) / w);
    const pixels = new Uint8Array(w * h);
    for (let i = 0; i < b.length; i++) { pixels[i * 2] = b[i] & 15; pixels[i * 2 + 1] = b[i] >> 4; }
    return { w, h, pixels };
  }

  /** writes `bytes` into a segment (same length) -> error text or null */
  function setSegment(asset, partId, seg, bytes) {
    if (bytes.length !== seg.len) return `${seg.name} holds ${seg.len} bytes, the replacement has ${bytes.length}`;
    asset.parts[partId].bytes.set(bytes, seg.off);
    return null;
  }

  /** library image (slot pixels) -> 4-bit bytes (cut to `len`: a segment's last partial row) */
  function imageBytes(pixels, w, h, len = (w * h) >> 1) {
    const out = new Uint8Array(Math.min(len, (w * h) >> 1));
    for (let i = 0; i < out.length; i++) out[i] = (pixels[i * 2] & 15) | ((pixels[i * 2 + 1] & 15) << 4);
    return out;
  }

  // ------------------------------------------------------------------ //
  // Parts and packing                                                  //
  // ------------------------------------------------------------------ //

  /** every part of every asset -> [{ref, asset, id, bytes (stored: raw or LZ), raw, lz, group, set}] */
  function partsOf(assets) {
    const out = [];
    for (const a of assets) {
      for (const [id, p] of Object.entries(a.parts)) {
        const lz = Boolean(p.lz) && a.type !== 'cartset';
        const stored = lz ? Uint8Array.from(C.lzEncode(p.bytes)) : p.bytes;
        out.push({ ref: `${a.name}.${id}`, asset: a, id, bytes: stored, raw: p.bytes.length, lz, group: p.group || null, set: a.type === 'cartset' ? a.name : null });
      }
    }
    return out;
  }

  /**
   * Best-fit decreasing into carts of 0x4300 bytes, fewest carts first.
   * Cart-set parts come first, each at offset 0 of its own cart (one reload() line reads them
   * all at the same offset); other parts may fill the rest of those carts. Parts with the same
   * group stay together. -> {carts: [{name, items: [{ref, off}]}], errors}
   */
  function autoPack(parts, { prefix = 'd', taken = new Set() } = {}) {
    const bins = [];
    const errors = [];
    for (const p of parts.filter((x) => x.set)) {
      if (p.bytes.length > CART) { errors.push(`${p.ref}: ${p.bytes.length} bytes do not fit into one cart`); continue; }
      bins.push({ used: p.bytes.length, items: [{ ref: p.ref, off: 0 }] });
    }
    const blocks = [];
    const byGroup = new Map();
    for (const p of parts.filter((x) => !x.set)) {
      if (p.group) {
        if (!byGroup.has(p.group)) { const b = { parts: [], size: 0 }; byGroup.set(p.group, b); blocks.push(b); }
        const b = byGroup.get(p.group);
        b.parts.push(p);
        b.size += p.bytes.length;
      } else blocks.push({ parts: [p], size: p.bytes.length });
    }
    // biggest first; equal sizes by name, so the same project always packs the same way
    blocks.sort((a, b) => b.size - a.size || a.parts[0].ref.localeCompare(b.parts[0].ref));
    for (const b of blocks) {
      if (b.size > CART) { errors.push(`${b.parts.map((p) => p.ref).join(' + ')}: ${b.size} bytes do not fit into one cart (${CART})`); continue; }
      let best = null;
      for (const bin of bins) if (CART - bin.used >= b.size && (!best || bin.used > best.used)) best = bin;
      if (!best) { best = { used: 0, items: [] }; bins.push(best); }
      for (const p of b.parts) { best.items.push({ ref: p.ref, off: best.used }); best.used += p.bytes.length; }
    }
    const names = [];
    for (let i = 0; names.length < bins.length; i++) { const n = `${prefix}${i}.p8`; if (!taken.has(n.toLowerCase())) names.push(n); }
    return { carts: bins.map((b, i) => ({ name: names[i], items: b.items })), errors };
  }

  /** layout -> {where: ref -> {cart, off, len, lz}, whereSet: name -> {off, len, carts}} */
  function placements(layout, parts) {
    const byRef = new Map(parts.map((p) => [p.ref, p]));
    const where = new Map();
    for (const c of layout) for (const it of c.items) where.set(it.ref, { cart: c.name, off: it.off, len: byRef.get(it.ref)?.bytes.length ?? 0, lz: !!byRef.get(it.ref)?.lz });
    const sets = new Map();
    for (const p of parts.filter((x) => x.set)) {
      if (!sets.has(p.set)) sets.set(p.set, []);
      sets.get(p.set).push(p);
    }
    const whereSet = new Map();
    for (const [name, ps] of sets) {
      const at = ps.map((p) => where.get(p.ref));
      if (at.some((x) => !x)) continue;
      whereSet.set(name, { off: at[0].off, len: Math.max(...ps.map((p) => p.bytes.length)), carts: at.map((x) => x.cart), sameOffset: at.every((x) => x.off === at[0].off) });
    }
    return { where, whereSet };
  }

  /** layout -> {name: .p8 text}; the manifest goes into the cart's (comment-only) code */
  function buildCarts(layout, parts) {
    const byRef = new Map(parts.map((p) => [p.ref, p]));
    const out = {};
    for (const c of layout) {
      const rom = C.defaultRom();
      const lines = [`-- data cart written by the pico-8 dev suite (project format ${FORMAT}). do not edit:`, '-- the sources are in assets/, the layout in demo/suite.json'];
      for (const it of c.items) {
        const p = byRef.get(it.ref);
        if (!p) continue;
        rom.set(p.bytes, it.off);
        lines.push(`-- ${hex(it.off)} ${hex(p.bytes.length)} ${p.lz ? `lz ${p.raw}` : 'raw'} ${it.ref}`);
      }
      out[c.name] = C.writeP8({ rom, lua: lines.join('\n') });
    }
    return out;
  }

  /** reads the written carts back: every part must come out byte for byte (LZ: after unpacking) */
  function verifyCarts(texts, layout, parts) {
    const byRef = new Map(parts.map((p) => [p.ref, p]));
    const errors = [];
    for (const c of layout) {
      const rom = C.parseP8(texts[c.name]).rom;
      for (const it of c.items) {
        const p = byRef.get(it.ref);
        const got = rom.subarray(it.off, it.off + p.bytes.length);
        if (got.some((v, i) => v !== p.bytes[i])) { errors.push(`${c.name}: ${it.ref} differs after writing`); continue; }
        if (p.lz) {
          const d = C.lzDecode(rom, it.off).data;
          const raw = p.asset.parts[p.id].bytes;
          if (d.length !== raw.length || d.some((v, i) => v !== raw[i])) errors.push(`${c.name}: ${it.ref} does not unpack correctly`);
        }
      }
    }
    return errors;
  }

  /**
   * Checks anchors against the parts: missing parts / sets, parts nobody anchors, LZ form,
   * cart sets that are not at one offset. files: [{name, text}] -> {anchors, errors, warnings}
   */
  function checkAnchors(files, parts, layout = null) {
    const byRef = new Map(parts.map((p) => [p.ref, p]));
    const setNames = new Set(parts.filter((p) => p.set).map((p) => p.set));
    const anchors = [];
    const errors = [];
    const warnings = [];
    const used = new Set();
    for (const f of files) {
      for (const a of findAnchors(f.text)) {
        anchors.push({ file: f.name, ...a, line: a.line + 1 });
        const at = `${f.name}:${a.line + 1}`;
        if (a.error) {
          errors.push(`${at} ${a.error}`);
          for (const p of parts) if (p.ref === a.ref || (a.set && p.set === a.set)) used.add(p.ref);
          continue;
        }
        const problem = anchorCallProblem(a);
        if (problem) errors.push(`${at} ${problem}`);
        if (a.set) {
          if (!setNames.has(a.set)) { errors.push(`${at} anchors the cart set “${a.set}[]”, which is not in the project`); continue; }
          for (const p of parts) if (p.set === a.set) used.add(p.ref);
          continue;
        }
        used.add(a.ref);
        const p = byRef.get(a.ref);
        if (!p) { errors.push(`${at} anchors “${a.ref}”, which is not in the project`); continue; }
        const bad = anchorRangeProblem(a, { len: p.bytes.length, lz: p.lz });
        if (bad) errors.push(`${at} ${bad}`);
        if (p.lz && !a.lz) errors.push(`${at} ${a.ref} is LZ-packed, but the line has no unlz()`);
        if (!p.lz && a.lz) errors.push(`${at} ${a.ref} is not LZ-packed, but the line calls unlz()`);
      }
    }
    for (const p of parts) if (!used.has(p.ref)) warnings.push(`${p.ref} (${p.bytes.length} bytes) is packed, but no --@data anchor uses it`);
    if (layout) {
      for (const [name, ws] of placements(layout, parts).whereSet) if (!ws.sameOffset) errors.push(`cart set ${name}[]: its parts must sit at the same offset in their carts (one reload() line reads them all)`);
    }
    return { anchors, errors, warnings };
  }


  // ------------------------------------------------------------------ //
  // Retiring carts: only what the final sources no longer reference     //
  // ------------------------------------------------------------------ //

  const baseName = (p) => p.replace(/\\/g, '/').split('/').pop().toLowerCase();
  // the cart argument of the calls that name other carts (run() takes a parameter, not a cart)
  const CART_ARG = { reload: 3, cstore: 3, load: 0 };
  /**
   * The calls of reload / cstore / load in executable Lua that may name a cart -> [{at (code offset of
   * the name), text, from, to (sig indexes of the cart argument; to < from = none: the running cart) | why}].
   * Calls are name(args), name"str", name'str', name[==[str]==] and name{table}; obj.load / obj:load
   * and function definitions are not the API. Any other use of the name (local f=load) is a why.
   */
  function cartCalls(ctx) {
    const { sig, src, code } = ctx;
    const out = [];
    sig.forEach((tk, k) => {
      const name = src(tk);
      if (!(name in CART_ARG) || !['api', 'ident'].includes(tk.t)) return;
      const prev = src(sig[k - 1]);
      const next = sig[k + 1];
      if (prev === '.' || prev === ':' || prev === 'function' || prev === 'local' || src(next) === '=') return;
      const ref = (end, more) => out.push({ at: tk.s, text: code.slice(tk.s, end).replace(/\s+/g, ' '), ...more });
      if (src(next) === '(') {
        const call = callAt(ctx, k);
        if (!call) { ref(next.e, { why: 'the call is not closed' }); return; }
        const arg = call.args[CART_ARG[name]];
        ref(sig[call.close].e, arg ? { from: arg.from, to: arg.to } : { from: 0, to: -1 });
      } else if (next?.t === 'string') {
        // name"x" passes one argument: only load's cart comes first
        if (CART_ARG[name] > 0) return;
        ref(next.e, { from: k + 1, to: k + 1 });
      } else if (src(next) === '{') {
        if (CART_ARG[name] === 0) ref(next.e, { why: 'load is called with a table, the cart name cannot be resolved' });
      } else ref(tk.e, { why: `${name} is used without a call here, the cart it may name cannot be traced` });
    });
    return out;
  }

  /**
   * Which candidate carts can go: the ones no remaining source references.
   * candidates: cart names that are about to be unused by the project (old data carts, adopted carts)
   * files:      [{name, text}] the final texts of the folder (fx carts after their rewrite, .lua files, ...)
   * Sources are every file that is not a candidate plus every candidate that has to stay. A reference
   * that cannot be resolved (computed name, uncallable use of load, unreadable #include) keeps all candidates.
   * -> {retire: [names], kept: [{cart, by}], unresolved: [{file, line, call, why}]}
   */
  function retirement(candidates, files) {
    const cand = new Map(candidates.map((n) => [n.toLowerCase(), n]));
    const byName = new Map(files.map((f) => [baseName(f.name), f]));
    const kept = new Map();
    const unresolved = [];
    const scanned = new Set();
    const queue = files.filter((f) => !cand.has(baseName(f.name)));
    const keep = (lc, by) => {
      if (!cand.has(lc) || kept.has(lc)) return;
      kept.set(lc, { cart: cand.get(lc), by });
      if (byName.has(lc)) queue.push(byName.get(lc));
    };
    while (queue.length) {
      const f = queue.shift();
      if (scanned.has(f.name)) continue;
      scanned.add(f.name);
      const ctx = luaContext(f.text);
      for (const inc of K.includes(ctx.code, ctx.toks)) {
        const lc = baseName(inc.path);
        const line = ctx.firstLine + inc.line + 1;
        if (cand.has(lc)) keep(lc, `${f.name}:${line} #include ${inc.raw}`);
        else if (!/[\\/]/.test(inc.path) && byName.has(lc)) queue.push(byName.get(lc));
        else unresolved.push({ file: f.name, line, call: `#include ${inc.raw}`, why: `the included ${inc.raw} cannot be read here, its references are unknown` });
      }
      for (const c of cartCalls(ctx)) {
        const where = { file: f.name, line: ctx.lineOf(c.at) + 1, call: c.text };
        if (c.why) { unresolved.push({ ...where, why: c.why }); continue; }
        // only what the code proves: a computed name, a changed table or an unknown fragment keeps every candidate
        const target = cartTargets(ctx, c.from, c.to, c.at);
        if (target.why) { unresolved.push({ ...where, why: target.why }); continue; }
        const by = `${f.name}:${where.line} ${c.text}`;
        for (const n of target.names) {
          const b = baseName(n);
          keep(b, by);
          keep(`${b}.p8`, by);
        }
      }
    }
    if (unresolved.length) for (const lc of cand.keys()) if (!kept.has(lc)) kept.set(lc, { cart: cand.get(lc), by: 'unresolved references' });
    return { retire: [...cand.keys()].filter((lc) => !kept.has(lc)).map((lc) => cand.get(lc)), kept: [...kept.values()], unresolved };
  }

  // ------------------------------------------------------------------ //
  // Recoverable multi-file writes (File System Access handles)         //
  // ------------------------------------------------------------------ //

  const JOURNAL = 'suite.journal.json';
  const JOURNAL_FORMAT = 2;
  const LOCK_NAME = 'pico8-suite.cartbuilder.write';

  class WriteError extends Error {
    constructor(msg, props) { super(msg); this.name = 'WriteError'; Object.assign(this, props); }
  }

  const notFound = (e) => e?.name === 'NotFoundError';
  async function readOrNull(dir, name) {
    if (!dir) return null;
    let h;
    try { h = await dir.getFileHandle(name); } catch (e) { if (notFound(e)) return null; throw e; }
    // removed between the two calls (another tab): absent as well
    try { return await (await h.getFile()).text(); } catch (e) { if (notFound(e)) return null; throw e; }
  }
  /** writes (or with text null removes) one file, then reads it back */
  async function put(dir, name, text) {
    if (text === null) {
      try { await dir.removeEntry(name); } catch (e) { if (!notFound(e)) throw e; }
    } else {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      try { await w.write(text); } catch (e) { try { await w.abort(); } catch { /* already failed */ } throw e; }
      await w.close();
    }
    if ((await readOrNull(dir, name)) !== text) throw new Error(`${name} reads back different from what was written`);
  }
  /** dirs: {key: handle | async (create) => handle}; a missing directory resolves to null unless create */
  function dirResolver(dirs) {
    const cache = new Map();
    return async (key, create = false) => {
      if (cache.has(key)) return cache.get(key);
      const d = dirs[key];
      let h = null;
      if (typeof d === 'function') { try { h = await d(create); } catch (e) { if (create || !notFound(e)) throw e; } } else h = d || null;
      if (h) cache.set(key, h);
      return h;
    };
  }

  /** which revision a file holds: length + two 32-bit FNV-style hashes (not a security hash); null = absent */
  function digest(text) {
    if (text === null || text === undefined) return null;
    let a = 0x811c9dc5;
    let b = 0x9747b28c;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
    }
    return `${text.length}:${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
  }

  const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  /**
   * Exclusive ownership of project writes and recovery. lock.run(fn) runs fn while holding the lock,
   * or rejects at once with WriteError stage 'busy' (it never queues: a waiting write was computed
   * from a state that may be gone). Within one page a synchronous flag decides; across tabs of the
   * origin the Web Locks API (navigator.locks) does, when the browser has it. Without Web Locks only
   * this page is serialized, and the journal ownership checks in transact() are the best-effort
   * fallback against another tab.
   */
  function createLock({ locks = globalThis.navigator?.locks, name = LOCK_NAME } = {}) {
    let held = false;
    const busy = () => new WriteError('Another Cart Builder write or recovery is in progress (in this tab or another one). Nothing was written; try again when it has finished.', { stage: 'busy', file: null, restored: true, journalKept: false });
    return {
      crossTab: typeof locks?.request === 'function',
      get held() { return held; },
      async run(fn) {
        if (held) throw busy();
        held = true;
        try {
          if (typeof locks?.request !== 'function') return await fn();
          return await locks.request(name, { ifAvailable: true }, (lock) => (lock ? fn() : Promise.reject(busy())));
        } finally { held = false; }
      },
    };
  }
  const pageLock = createLock();

  /** {ours, present}: is the journal on disk this transaction's (same id)? */
  /**
   * is the journal on disk exactly one this transaction wrote (texts: every version it wrote or tried to)?
   * Exact text, not just the id: a recovery that took the journal over marks it with its own id.
   */
  async function journalOwner(jdir, texts) {
    let text;
    try { text = await readOrNull(jdir, JOURNAL); } catch (error) { return { ours: false, present: true, error }; }
    if (text === null) return { ours: false, present: false };
    return { ours: texts.has(text), present: true };
  }
  /** removes the journal only while it is still this transaction's -> true if a journal is left */
  async function dropJournal(jdir, texts) {
    const j = await journalOwner(jdir, texts);
    if (!j.ours) return j.present;
    try { await put(jdir, JOURNAL, null); return false; } catch { return true; }
  }

  /**
   * Writes several files so that a failure part-way leaves the folder as it was.
   *   writes: [{dir, name, text | null (remove), stage}] in order; the last one (the manifest) commits
   *   retire: [{from, to, name}] moved only after the commit: copied, read back, then removed
   *   checks: [{dir, name, expect}] files the result depends on; with writes[].expect they must still read
   *           as expected (null: absent), otherwise nothing is written (WriteError stage 'conflict')
   * The whole call holds the project lock (createLock); a second writer or a recovery meanwhile gets
   * WriteError stage 'busy' and touches nothing. Every target is read first (preflight), the original
   * contents and a digest of the new ones go into a journal next to the manifest, each write is read
   * back, and any failure restores the originals. The journal moves writing -> committed; if the
   * 'committed' marker cannot be confirmed, it moves to 'rolling-back' before anything is restored, so
   * recovery can never mistake a half-restored folder for a commit. If that marker cannot be written
   * either, nothing is restored (every file still holds the new contents). Whenever the folder cannot
   * be left coherent, the journal stays for recover(). Only this transaction's own journal is removed.
   * -> {retired, retireErrors, journalKept} or throws WriteError {stage, file, restored, journalKept}
   */
  async function transact(dirs, plan, opts = {}) {
    return (opts.lock || pageLock).run(() => transactLocked(dirs, plan, opts));
  }

  async function transactLocked(dirs, { writes, retire = [], checks = [] }, { journalDir = 'demo', now = () => new Date().toISOString(), id = newId() } = {}) {
    const dir = dirResolver(dirs);
    const label = (w) => `${w.dir}/${w.name}`;
    const jdir = await dir(journalDir);
    const jlabel = `${journalDir}/${JOURNAL}`;
    const before = [];
    const conflicts = [];
    try {
      if ((await readOrNull(jdir, JOURNAL)) !== null) throw new Error(`an earlier write left ${JOURNAL}; reopen the project to recover it first`);
      for (const w of writes) {
        before.push(await readOrNull(await dir(w.dir), w.name));
        if ('expect' in w && before[before.length - 1] !== w.expect) conflicts.push(label(w));
      }
      for (const c of checks) if ((await readOrNull(await dir(c.dir), c.name)) !== c.expect) conflicts.push(label(c));
    } catch (e) {
      throw new WriteError(`Preflight failed, nothing was written: ${e.message}`, { stage: 'preflight', file: label(writes[before.length] || { dir: journalDir, name: JOURNAL }), restored: true, journalKept: false, cause: e });
    }
    if (conflicts.length) throw new WriteError(`Changed on disk since the project was read: ${conflicts.join(', ')}. Nothing was written.`, { stage: 'conflict', file: conflicts[0], conflicts, restored: true, journalKept: false });
    const journal = { format: JOURNAL_FORMAT, id, started: now(), state: 'writing', writes: writes.map((w, i) => ({ dir: w.dir, name: w.name, before: before[i], after: digest(w.text) })), retire };
    const mine = new Set(); // every journal text this transaction wrote or tried to write
    const putJournal = (state) => { const text = JSON.stringify({ ...journal, state }); mine.add(text); return put(jdir, JOURNAL, text); };
    const lostMsg = `${jlabel} is no longer this write's journal (another tab removed or took it over, e.g. to recover it)`;
    /**
     * the journal is not ours any more. Present (another tab's marker): touch nothing, that tab decides.
     * Gone while this write's journal still said 'writing' / 'rolling-back': whoever removed it restored
     * the originals first, so a file this write changed afterwards (it still holds the new contents)
     * goes back to its original from memory. undo = false once 'committed' may be on disk.
     */
    const lost = async (done, present, cause, undo = true) => {
      const back = [];
      const problems = [];
      if (!present && undo) {
        for (const [k, w] of journal.writes.slice(0, done).entries()) {
          try {
            const now = await readOrNull(await dir(w.dir), w.name);
            if (now === w.before || digest(now) !== w.after) continue;
            await put(await dir(w.dir, w.before !== null), w.name, w.before);
            back.push(label(writes[k]));
          } catch (e) { problems.push(`${label(writes[k])}: ${e.message}`); }
        }
      }
      const what = problems.length ? `could not restore ${problems.join('; ')}` : back.length ? `restored ${back.join(', ')} (written after the journal was removed)` : 'restored nothing';
      return new WriteError(`${lostMsg}. This write stopped after ${done} of ${writes.length} files and ${what}; it does not undo what the other tab did. Reopen the project to check the folder.`, { stage: 'ownership', file: jlabel, restored: !problems.length && !present && undo, journalKept: present, cause });
    };
    /** moves the journal to `state`, but only while it is still this transaction's */
    const mark = async (state) => {
      if (!(await journalOwner(jdir, mine)).ours) throw new Error(lostMsg);
      await putJournal(state);
    };
    try { await putJournal('writing'); } catch (e) {
      const journalKept = await dropJournal(jdir, mine);
      throw new WriteError(`Could not write the recovery journal, nothing was written: ${e.message}${journalKept ? `. ${jlabel} is still there (not removed: it may belong to another write); reopen the project to check it.` : ''}`, { stage: 'journal', file: jlabel, restored: true, journalKept, cause: e });
    }
    /** restores the first n targets; the journal goes only when all of them are back */
    const rollback = async (e, failed, n) => {
      const owner = await journalOwner(jdir, mine);
      if (!owner.ours && !owner.error) return lost(n, owner.present, e);
      const problems = await restore(dir, journal.writes.slice(0, n));
      const journalKept = problems.length ? true : await dropJournal(jdir, mine);
      return new WriteError(problems.length
        ? `Writing ${label(failed)} failed (${e.message}) and ${problems.length} files could not be restored: ${problems.join('; ')}. ${jlabel} keeps the original contents; reopen the project to restore them.`
        : `Writing ${label(failed)} failed (${e.message}). All files were restored to their state before the write.`,
      { stage: failed.stage || 'commit', file: label(failed), restored: !problems.length, journalKept, cause: e });
    };
    let i = 0;
    try {
      for (; i < writes.length; i++) {
        // without Web Locks another tab may recover this journal meanwhile: stop as soon as it is not ours
        const owner = await journalOwner(jdir, mine);
        if (owner.error) throw owner.error;
        if (!owner.ours) throw await lost(i, owner.present);
        await put(await dir(writes[i].dir, true), writes[i].name, writes[i].text);
      }
    } catch (e) {
      if (e instanceof WriteError) throw e;
      throw await rollback(e, writes[i], i + 1); // the journal says 'writing': recovery would restore too
    }
    try {
      await mark('committed');
    } catch (e) {
      // the 'committed' marker may have reached the disk: record the rollback decision first (#31)
      try { await mark('rolling-back'); } catch (e2) {
        const owner = await journalOwner(jdir, mine);
        if (!owner.ours && !owner.error) throw await lost(writes.length, owner.present, e, false);
        throw new WriteError(`Committing ${jlabel} failed (${e.message}), and the journal could not record a rollback (${e2.message}). Every file holds the new contents; nothing was restored. ${jlabel} stays; reopen the project to finish or undo this write.`, { stage: 'commit', file: jlabel, restored: false, journalKept: true, cause: e });
      }
      throw await rollback(e, { dir: journalDir, name: JOURNAL, stage: 'commit' }, writes.length);
    }
    const { retired, errors: retireErrors } = await retireAll(dir, retire);
    return { retired, retireErrors, journalKept: await dropJournal(jdir, mine) };
  }

  async function restore(dir, entries) {
    const problems = [];
    for (const w of entries.slice().reverse()) {
      try { await put(await dir(w.dir, w.before !== null), w.name, w.before); } catch (e) {
        if (w.before === null && !(await dir(w.dir))) continue; // the directory never existed
        problems.push(`${w.dir}/${w.name}: ${e.message}`);
      }
    }
    return problems;
  }

  /** after the commit: copy, read back, remove the original. A failure leaves the original in place. */
  async function retireAll(dir, retire) {
    const retired = [];
    const errors = [];
    for (const r of retire) {
      try {
        const from = await dir(r.from);
        const text = await readOrNull(from, r.name);
        if (text === null) continue;
        const to = await dir(r.to, true);
        if ((await readOrNull(to, r.name)) !== text) await put(to, r.name, text);
        await from.removeEntry(r.name);
        retired.push(r.name);
      } catch (e) { errors.push(`${r.name}: ${e.message}`); }
    }
    return { retired, errors };
  }

  /** undoes retireAll(): a cart that is only in `to` goes back to `from` -> problems */
  async function unretireAll(dir, retire) {
    const problems = [];
    for (const r of retire) {
      try {
        const to = await dir(r.to);
        const text = await readOrNull(to, r.name);
        if (text === null) continue;
        const from = await dir(r.from, true);
        const there = await readOrNull(from, r.name);
        if (there !== null && there !== text) throw new Error(`${r.from}/${r.name} exists with other contents`);
        if (there === null) await put(from, r.name, text);
        await put(to, r.name, null);
      } catch (e) { problems.push(`${r.from}/${r.name}: ${e.message}`); }
    }
    return problems;
  }

  /**
   * An interrupted transact() left its journal. Holds the same lock as transact() and decides from
   * what the files hold now, not from the marker alone:
   *   'committed' and every file holds the new contents -> finish the retirement      (outcome 'new')
   *   every file holds its original contents              -> nothing to restore/retire (outcome 'old')
   *   'writing' / 'rolling-back' otherwise                -> restore the originals     (outcome 'old')
   *   'committed' but neither revision (mixed)            -> touch nothing, report     (outcome 'unresolved')
   *   an empty journal (created, never closed)            -> no file was touched       (outcome 'old')
   * Restoring a mixed committed folder (only after confirmRollback) also moves retired carts back.
   * confirmRollback({state, reason: 'rollback' | 'mixed', files}) -> bool is asked before restoring;
   * without it a rollback proceeds and a mixed folder is left alone. Declining -> outcome 'declined'.
   * The journal is removed only when the folder verifiably holds one revision and the journal is still
   * the one read here; otherwise it stays with the originals (outcome 'unresolved', problems).
   * -> null (no journal) | {state, outcome: 'new'|'old'|'declined'|'unresolved'|'busy', problems, retired, mixed}
   */
  async function recover(dirs, opts = {}) {
    try {
      return await (opts.lock || pageLock).run(() => recoverLocked(dirs, opts));
    } catch (e) {
      if (e instanceof WriteError && e.stage === 'busy') return { state: 'busy', outcome: 'busy', problems: [e.message], retired: [], mixed: [] };
      throw e;
    }
  }

  async function recoverLocked(dirs, { journalDir = 'demo', confirmRollback = null } = {}) {
    const dir = dirResolver(dirs);
    const jdir = await dir(journalDir);
    let jtext = await readOrNull(jdir, JOURNAL);
    if (jtext === null) return null;
    const out = (state, outcome, more = {}) => ({ state, outcome, problems: [], retired: [], mixed: [], ...more });
    // created but never closed: transact() changes no file before its journal reads back complete
    if (jtext === '') {
      try { await put(jdir, JOURNAL, null); } catch (e) { return out('empty', 'unresolved', { problems: [`${JOURNAL} could not be removed: ${e.message}`] }); }
      return out('empty', 'old');
    }
    let j;
    try { j = JSON.parse(jtext); } catch (e) { return out('unreadable', 'unresolved', { problems: [`${JOURNAL}: ${e.message}`] }); }
    const writes = Array.isArray(j.writes) ? j.writes : [];
    const label = (w) => `${w.dir}/${w.name}`;
    const current = [];
    try { for (const w of writes) current.push(await readOrNull(await dir(w.dir), w.name)); } catch (e) {
      return out(j.state, 'unresolved', { problems: [`${label(writes[current.length])} cannot be read (${e.message}); nothing was changed`] });
    }
    const isNew = (w, k) => typeof w.after !== 'undefined' && digest(current[k]) === w.after;
    const allOld = writes.every((w, k) => current[k] === w.before);
    const allNew = writes.every(isNew);
    const mixed = writes.filter((w, k) => current[k] !== w.before && !isNew(w, k)).map(label);
    let outcome;
    let problems = [];
    let retired = [];
    if (j.state === 'committed' && allNew) {
      ({ retired, errors: problems } = await retireAll(dir, j.retire || []));
      outcome = 'new';
    } else if (allOld) {
      outcome = 'old';
    } else {
      if (!['writing', 'rolling-back', 'committed'].includes(j.state)) return out(String(j.state), 'unresolved', { problems: [`${JOURNAL} has the unknown state “${j.state}”; nothing was changed`], mixed });
      const reason = j.state === 'committed' ? 'mixed' : 'rollback';
      const ok = confirmRollback ? await confirmRollback({ state: j.state, reason, files: mixed }) : reason === 'rollback';
      if (!ok) {
        return reason === 'mixed'
          ? out(j.state, confirmRollback ? 'declined' : 'unresolved', { problems: confirmRollback ? [] : [`the write was committed, but these files hold neither its new nor their original contents: ${mixed.join(', ')}. Nothing was changed`], mixed })
          : out(j.state, 'declined', { mixed });
      }
      if (j.state !== 'rolling-back') {
        // its own id: a writer still running in a tab without Web Locks sees the journal is no longer its own
        const next = JSON.stringify({ ...j, state: 'rolling-back', recovery: newId() });
        try {
          if ((await readOrNull(jdir, JOURNAL)) !== jtext) throw new Error('it changed during the recovery');
          await put(jdir, JOURNAL, next);
        } catch (e) { return out(j.state, 'unresolved', { problems: [`${JOURNAL} could not record the rollback (${e.message}); nothing was restored`], mixed }); }
        jtext = next;
      }
      problems = await restore(dir, writes);
      // a committed write may already have retired carts: the old revision needs them back
      if (j.state === 'committed') problems.push(...await unretireAll(dir, j.retire || []));
      outcome = problems.length ? 'unresolved' : 'old';
    }
    if (!problems.length) {
      try {
        if ((await readOrNull(jdir, JOURNAL)) !== jtext) throw new Error('it changed during the recovery');
        await put(jdir, JOURNAL, null);
      } catch (e) { problems.push(`${JOURNAL} could not be removed: ${e.message}`); }
    }
    return out(j.state, outcome, { problems, retired, mixed });
  }

  return {
    FORMAT, CART, TYPES, hex, safeName, assetToJson, assetFromJson, findAnchors, rewriteAnchors, renameInText,
    constExpr, constRange, retirement, JOURNAL, WriteError, createLock, digest, transact, recover, adopt, segmentsOf, segmentImage, setSegment, imageBytes, partsOf, autoPack, placements, buildCarts, verifyCarts, checkAnchors, isMusic, isTracks,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Project;
