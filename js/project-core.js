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

  // --@data asset.part[+offset]   one part
  // --@data asset[]               a cart set: reload(dest,src,len,list[i]) over the carts in `list`
  const ANCHOR = /--@data\s+(?:([A-Za-z_]\w*)\[\]|([A-Za-z_]\w*\.[A-Za-z_]\w*)(?:\s*\+\s*(0x[\da-f]+|\d+))?)/i;

  /** reload() call on a line -> {start, end, args} (start/end index the line) */
  function reloadCall(line) {
    const m = /\breload\s*\(/.exec(line.replace(/--.*$/, (c) => ' '.repeat(c.length)));
    if (!m) return null;
    const a = V.callArgs(line, m.index + m[0].length - 1);
    return a ? { start: m.index, end: a.end + 1, args: a.args } : null;
  }

  /** anchors in one cart's text -> [{line (0-based), ref | set, sub, call, lz}] */
  function findAnchors(text) {
    const out = [];
    text.split('\n').forEach((line, i) => {
      const am = ANCHOR.exec(line);
      if (!am) return;
      const call = reloadCall(line);
      out.push({ line: i, set: am[1] || null, ref: am[2] || null, sub: am[3] ? C.parseNum(am[3]) : 0, ranged: !!am[3], call, lz: /\bunlz\s*\(/.test(line), text: line.trim() });
    });
    return out;
  }

  /** the list literal a cart-set reload indexes: `name = {"a.p8", ...}` -> {name, start, end} in text */
  function listLiteral(text, expr) {
    const m = /^([A-Za-z_]\w*)\s*\[/.exec((expr || '').trim());
    if (!m) return null;
    const re = new RegExp(`\\b${m[1]}\\s*=\\s*\\{`, 'g');
    const lm = re.exec(text);
    if (!lm) return null;
    const close = text.indexOf('}', lm.index + lm[0].length);
    if (close < 0) return null;
    const body = text.slice(lm.index + lm[0].length, close);
    return { name: m[1], start: lm.index + lm[0].length, end: close, carts: [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]) };
  }

  /**
   * Rewrites src / len / cart of every anchored reload() in `text` (and, for cart sets, the
   * cart names in the list literal). where(ref) -> {cart, off, len, lz}; whereSet(name) -> {off, len, carts}.
   * -> {text, changes: [..], errors: [..]}
   */
  function rewriteAnchors(text, where, whereSet = () => null) {
    const lines = text.split('\n');
    const changes = [];
    const errors = [];
    const lists = [];
    for (const a of findAnchors(text)) {
      const id = a.set ? `${a.set}[]` : a.ref;
      const problem = anchorCallProblem(a);
      if (problem) { errors.push({ line: a.line + 1, ref: id, msg: problem }); continue; }
      let call;
      if (a.set) {
        const ps = whereSet(a.set);
        if (!ps) { errors.push({ line: a.line + 1, ref: id, msg: `no cart set “${a.set}” in the project` }); continue; }
        call = `reload(${a.call.args[0]},${hex(ps.off)},${hex(ps.len)},${a.call.args[3]})`;
        lists.push({ expr: a.call.args[3], carts: ps.carts, line: a.line + 1, ref: id });
      } else {
        const p = where(a.ref);
        if (!p) { errors.push({ line: a.line + 1, ref: id, msg: `no part “${a.ref}” in the project` }); continue; }
        const bad = anchorRangeProblem(a, p);
        if (bad) { errors.push({ line: a.line + 1, ref: id, msg: bad }); continue; }
        // an explicit +offset (even +0x0) marks a sub-range read: it keeps its own length.
        // a bare ref reads the whole part, so it follows the part when it is resized.
        const len = a.ranged ? constExpr(a.call.args[2]).value : p.len;
        call = `reload(${a.call.args[0]},${hex(p.off + a.sub)},${hex(len)},"${p.cart}")`;
      }
      const line = lines[a.line];
      const next = line.slice(0, a.call.start) + call + line.slice(a.call.end);
      if (next !== line) { changes.push({ line: a.line + 1, ref: id, before: line.trim(), after: next.trim() }); lines[a.line] = next; }
    }
    let out = lines.join('\n');
    for (const l of lists) {
      const lit = listLiteral(out, l.expr);
      if (!lit) { errors.push({ line: l.line, ref: l.ref, msg: `the cart list ${l.expr} is not a literal {"a.p8",...} in this cart` }); continue; }
      const body = l.carts.map((c) => `"${c}"`).join(', ');
      if (out.slice(lit.start, lit.end).trim() !== body) {
        changes.push({ line: lineOf(out, lit.start), ref: l.ref, before: `${lit.name}={${out.slice(lit.start, lit.end).trim()}}`, after: `${lit.name}={${body}}` });
        out = out.slice(0, lit.start) + body + out.slice(lit.end);
      }
    }
    return { text: out, changes, errors };
  }
  const lineOf = (text, i) => text.slice(0, i).split('\n').length;

  /**
   * Why an anchored reload() cannot be rewritten without changing what the fx does, or null.
   * The builder owns the source, length and cart name of an anchored call, so they must be
   * literal: a computed one (e.g. frame*0x200) would be replaced by a fixed value.
   */
  function anchorCallProblem(a) {
    if (!a.call || a.call.args.length < 4) return 'no reload(dest,src,len,cart) on this line';
    const s = constExpr(a.call.args[1]);
    if (s.why) return `the source ${a.call.args[1]} ${s.why}; an anchored reload() needs a literal source`;
    const l = constExpr(a.call.args[2]);
    if (l.why) return `the length ${a.call.args[2]} ${l.why}; an anchored reload() needs a literal length`;
    if (!a.set && literalCart(a.call.args[3]) == null) return `the cart name ${a.call.args[3]} is not a literal "name.p8"`;
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

  /** renames an asset in the anchor comments of `text` */
  function renameInText(text, from, to) {
    return text.replace(new RegExp(`(--@data\\s+)${from}(\\.|\\[\\])`, 'g'), `$1${to}$2`);
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

  /**
   * carts: Map(lower name -> {name, text, rom, lua, luaAt, used, reads}) as Data Carts builds it.
   * Every reload() of a data cart becomes an anchor and its bytes a part:
   *   literal cart name  -> one part (ranges inside a bigger one become sub-anchors asset.part+off)
   *   list[i] cart name  -> a cart set (one part per cart in the literal list), anchor asset[]
   * Music carts, tracks, computed names and reads whose source/length is not literal integer
   * arithmetic inside the data area stay as they are (reported in `skipped`). Carts such a call
   * still reads (or, for an unresolvable name, every source cart) are `keptCarts`, never `adoptedCarts`.
   * -> {project, assets, edits: [{file, line, before, after}], skipped, sourceCarts, adoptedCarts, keptCarts}
   */
  function adopt(carts, { prefix = 'd' } = {}) {
    const ranges = new Map(); // cart -> [{src, len, uses: [{file, line, text}]}]
    const sets = [];          // [{fx, list, carts, src, len, line, text}]
    const skipped = [];       // [{file, line, why, carts?}]: left unchanged; `carts` stay in place
    for (const fx of carts.values()) {
      if (!fx.text) continue;
      const lines = fx.text.split('\n');
      lines.forEach((line, i) => {
        if (ANCHOR.test(line)) return;
        const call = reloadCall(line);
        if (!call || call.args.length < 4) return;
        const range = constRange(call.args[1], call.args[2]);
        const cartName = literalCart(call.args[3]);
        if (cartName == null) {
          const ll = listLiteral(fx.text, call.args[3]);
          const okList = ll && ll.carts.length && ll.carts.every((c) => carts.has(c.toLowerCase()) && !isMusic(c) && !isTracks(c));
          if (okList && !range.why) { sets.push({ fx: fx.name, list: ll.name, carts: ll.carts, src: range.src, len: range.len, line: i, text: line }); return; }
          // the carts this call may read stay where they are; null = cannot tell which
          const target = C.reloadTarget(call.args[3], fx.text);
          const may = target ? [...carts.values()].filter((c) => target.match(c.name)).map((c) => c.name) : null;
          const why = !ll ? `cart name ${call.args[3]} is computed` : !okList ? 'cart list with music, tracks or missing carts' : range.why;
          skipped.push({ file: fx.name, line: i + 1, why: `${why} (left as it is)`, carts: may });
          return;
        }
        const cn = cartName.toLowerCase();
        if (isMusic(cn) || isTracks(cn)) return;
        if (!carts.get(cn)) { skipped.push({ file: fx.name, line: i + 1, why: `${cartName} not found` }); return; }
        if (range.why) { skipped.push({ file: fx.name, line: i + 1, why: `${range.why} (left as it is)`, carts: [carts.get(cn).name] }); return; }
        const r = { src: range.src, len: range.len, uses: [{ file: fx.name, line: i, text: line }] };
        if (!ranges.has(cn)) ranges.set(cn, []);
        const list = ranges.get(cn);
        const same = list.find((x) => x.src === r.src && x.len === r.len);
        if (same) same.uses.push(...r.uses); else list.push(r);
      });
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

  return {
    FORMAT, CART, TYPES, hex, safeName, assetToJson, assetFromJson, findAnchors, rewriteAnchors, renameInText, listLiteral,
    constExpr, constRange, adopt, segmentsOf, segmentImage, setSegment, imageBytes, partsOf, autoPack, placements, buildCarts, verifyCarts, checkAnchors, isMusic, isTracks,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Project;
