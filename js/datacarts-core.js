// js/datacarts-core.js
// Data Carts analysis (pure logic, no DOM): which sections of a data cart the fx code
// uses, and the palettes those sections are shown with.
//
// The fx code is read, not run. It follows the patterns PICO-8 demos use:
//   reload(dest,src,len,"cart.p8")      -> which cart bytes land where in memory
//   name = mem_store(addr,len)          -> a section, cut out of the loaded memory
//   memread_init(name[,pos]) + memread_table8(16) / memread_table32() ...
//                                       -> tables read out of a section
//   pal(tbl,1) / pal(i,t[expr],1)       -> screen palette (tables, split"..", fade loops)
//   pal(memread_table8(16),2) + spr()   -> secondary (fade) palette for what is drawn next
//   mem_restore(addr,name) + poke(0x5f54,..) -> which section a draw call shows

'use strict';

const P8DataView = (() => {
  const C = typeof P8Cart !== 'undefined' ? P8Cart : require('./cart-core.js');
  const ROM = C.ROM_SIZE;
  const VALID = new Set([...Array(16).keys(), ...Array.from({ length: 16 }, (_, i) => 128 + i)]);
  const STD = Array.from({ length: 16 }, (_, i) => i);
  const hex4 = (n) => `0x${(n >>> 0).toString(16).padStart(4, '0')}`;

  // ------------------------------------------------------------------ //
  // Small Lua readers                                                  //
  // ------------------------------------------------------------------ //

  const stripComments = (lua) => lua.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const lineAt = (src, i) => src.slice(0, i).split('\n').length;
  const last = (name) => name.split(/[.:]/).pop();

  /** top-level arguments of the call whose '(' is at s[i] -> {args, end} */
  function callArgs(s, i) {
    const args = [];
    let depth = 0;
    let cur = '';
    let str = null;
    for (let j = i + 1; j < s.length; j++) {
      const ch = s[j];
      if (str) { cur += ch; if (ch === str) str = null; continue; }
      if (ch === '"' || ch === "'") { str = ch; cur += ch; continue; }
      if ('({['.includes(ch)) depth++;
      if (')}]'.includes(ch)) {
        if (depth === 0) { args.push(cur.trim()); return { args, end: j }; }
        depth--;
      }
      if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; } else cur += ch;
    }
    return null;
  }

  /** Lua value at s[i]: number, string, split"a,b" (1-based Map), {..} (Map). -> {v, i} */
  function parseValue(s, i) {
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    ws();
    const sm = /^split\s*\(?\s*(["'])([^"']*)\1\s*\)?/.exec(s.slice(i, i + 4000));
    if (sm) {
      const m = new Map();
      sm[2].split(',').forEach((t, k) => m.set(k + 1, C.parseNum(t.trim()) ?? t));
      return { v: m, i: i + sm[0].length };
    }
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      const j = s.indexOf(q, i + 1);
      return { v: s.slice(i + 1, j), i: j + 1 };
    }
    if (s[i] === '{') {
      const m = new Map();
      let pos = 1;
      i++;
      for (;;) {
        ws();
        if (i >= s.length) return { v: m, i };
        if (s[i] === '}') return { v: m, i: i + 1 };
        let key = null;
        if (s[i] === '[') {
          const j = s.indexOf(']', i);
          key = C.parseNum(s.slice(i + 1, j).trim());
          i = j + 1; ws(); if (s[i] === '=') i++;
        } else {
          const km = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(s.slice(i, i + 80));
          if (km) { key = km[1]; i += km[0].length; }
        }
        const r = parseValue(s, i);
        i = r.i;
        m.set(key ?? pos++, r.v);
        ws();
        if (s[i] === ',' || s[i] === ';') i++;
        else if (s[i] !== '}') {
          // unknown expression: skip to the next separator at this depth
          let d = 0;
          while (i < s.length && !(d === 0 && (s[i] === ',' || s[i] === ';' || s[i] === '}'))) { if ('({['.includes(s[i])) d++; if (')}]'.includes(s[i])) d--; i++; }
          if (s[i] === ',' || s[i] === ';') i++;
        }
      }
    }
    const nm = /^-?(0x[\da-f.]+|0b[01.]+|\d+\.?\d*|\.\d+)/i.exec(s.slice(i, i + 40));
    if (nm) return { v: C.parseNum(nm[0]), i: i + nm[0].length };
    return { v: undefined, i };
  }

  /** Evaluates a small integer expression; `vars` maps names, every other variable = 0 (no fade/offset). */
  function evalExpr(expr, vars = {}, depth = 0) {
    if (expr == null || depth > 4) return null;
    const toks = String(expr).match(/0x[\da-f.]+|\d+\.?\d*|[A-Za-z_][\w.]*|<<|>>|[-+*/\\&|()%,]/gi);
    if (!toks || toks.join('') !== String(expr).replace(/\s+/g, '')) return null;
    const ops = { or: '||', and: '&&', not: '!' };
    const js = toks.map((t) => {
      if (t in ops) return ops[t];
      if (/^[A-Za-z_]/.test(t)) {
        if (t in vars) { const { [t]: v, ...rest } = vars; return `(${evalExpr(v, rest, depth + 1) ?? 0})`; }
        return ['mid', 'min', 'max', 'flr'].includes(t) ? `F.${t}` : '0';
      }
      if (t === '\\') return '/*idiv*/';
      return /^[\d.]|^0x/i.test(t) ? String(C.parseNum(t)) : t;
    }).join(' ').replace(/(\S+) \/\*idiv\*\/ (\S+)/g, 'Math.floor($1/$2)');
    const F = { mid: (a, b, c) => [a, b, c].sort((x, y) => x - y)[1], min: Math.min, max: Math.max, flr: Math.floor };
    try { const r = Function('F', `return (${js})`)(F); return Number.isFinite(r) ? Math.floor(r) : null; } catch { return null; }
  }

  /** pal(tbl,1) semantics: key k recolors slot k. A bare number list = slots 0..15. */
  function palFromMap(m) {
    if (!(m instanceof Map) || !m.size) return null;
    const out = STD.map((i) => (m.has(i) ? m.get(i) : i));
    return out.every((v) => VALID.has(v)) ? out : null;
  }
  function parseLuaPal(text) {
    const t = text.trim();
    const m = t.startsWith('{') || t.startsWith('split') ? parseValue(t, 0).v : new Map(t.split(/[\s,]+/).filter(Boolean).map((v, i) => [i, C.parseNum(v)]));
    return palFromMap(m);
  }

  // ------------------------------------------------------------------ //
  // Per fx cart: loads, stores, named tables                           //
  // ------------------------------------------------------------------ //

  function analyzeFx(fx, carts) {
    if (fx.an) return fx.an;
    const raw = fx.lua;
    const src = stripComments(raw);
    const names = [...carts.values()].map((c) => c.name);
    const loads = [];
    for (const m of src.matchAll(/\breload\s*\(/g)) {
      const a = callArgs(src, m.index + m[0].length - 1);
      if (!a || a.args.length < 4) continue;
      const t = C.reloadTarget(a.args[3], src);
      if (!t) continue;
      loads.push({ pos: m.index, dest: evalExpr(a.args[0]), src: evalExpr(a.args[1]), len: evalExpr(a.args[2]), carts: names.filter(t.match).map((n) => n.toLowerCase()) });
    }
    const rawLines = raw.split('\n');
    const stores = [];
    for (const m of src.matchAll(/\bmem_store\s*\(/g)) {
      const a = callArgs(src, m.index + m[0].length - 1);
      if (!a) continue;
      const addr = evalExpr(a.args[0]);
      const len = evalExpr(a.args[1]);
      if (addr == null || !len) continue;
      const before = src.slice(Math.max(0, src.lastIndexOf('\n', m.index) + 1), m.index);
      const as = /([\w.]+)\s*=\s*$/.exec(before);
      const line = lineAt(src, m.index);
      const cm = /--\s*(.+)$/.exec(rawLines[line - 1] || '');
      stores.push({ pos: m.index, line, addr, len: len < 0 ? len + 0x10000 : len, name: as ? last(as[1]) : null, note: cm ? cm[1].trim() : null });
    }
    // origin of every store: the last load before it that covers each part of it
    for (const s of stores) {
      s.pieces = [];
      const ld = loads.filter((l) => l.pos < s.pos && l.dest != null && l.len);
      for (let a = s.addr; a < s.addr + s.len;) {
        const l = [...ld].reverse().find((x) => a >= x.dest && a < x.dest + x.len);
        if (!l) { a++; continue; }
        const end = Math.min(s.addr + s.len, l.dest + l.len);
        s.pieces.push({ mem: a, len: end - a, carts: l.carts, off: l.src + (a - l.dest) });
        a = end;
      }
    }
    const tables = new Map();
    for (const m of src.matchAll(/([A-Za-z_][\w.]*)\s*=\s*(?=\{|split\b)/g)) {
      const r = parseValue(src, m.index + m[0].length);
      if (r.v instanceof Map) tables.set(last(m[1]), r.v);
    }
    // numeric field defaults of the fx object (fade2= 16,): `this.fade2` in expressions
    const fields = {};
    for (const m of src.matchAll(/^[ 	]*([A-Za-z_]\w*)\s*=\s*(-?(?:0x[\da-f.]+|\d+\.?\d*|\.\d+))\s*,/gim)) fields[`this.${m[1]}`] ??= m[2];
    fx.an = { src, loads, stores, tables, fields };
    return fx.an;
  }

  const storeByName = (an, name) => [...an.stores].reverse().find((s) => s.name === last(name));

  /** cart bytes behind store offset `o` (for cart `want` when the load matches several carts) */
  function storeOrigin(s, o, carts, want) {
    const p = s.pieces.find((x) => s.addr + o >= x.mem && s.addr + o < x.mem + x.len);
    if (!p) return null;
    const cn = want && p.carts.includes(want) ? want : p.carts[0];
    const c = carts.get(cn);
    return c ? { cart: c, off: p.off + (s.addr + o - p.mem) } : null;
  }

  /** follows memread_init(X,pos) .. reads .. up to `pos`; -> {store, off (in store), prefixed} */
  function traceRead(an, pos, carts, want) {
    const src = an.src;
    const inits = [...src.slice(0, pos).matchAll(/\bmemread_init\s*\(/g)];
    const init = inits[inits.length - 1];
    if (!init) return null;
    const a = callArgs(src, init.index + init[0].length - 1);
    const st = a && storeByName(an, a.args[0]);
    if (!st) return null;
    const locals = { ...an.fields, ...localsBefore(src, init.index) };
    let off = a.args[1] ? evalExpr(a.args[1], locals) : 0;
    if (off == null) return null;
    const byte = (o) => { const r = storeOrigin(st, o, carts, want); return r ? r.cart.rom[r.off] : 0; };
    // the reads between the init and `pos`
    for (const m of src.slice(a.end, pos).matchAll(/\b(memread_table8|memread_table32|mem_read2|mem_read)\s*\(([^()]*)\)/g)) {
      const n = m[2].trim() ? evalExpr(m[2]) : null;
      if (m[1] === 'mem_read') off += 1;
      else if (m[1] === 'mem_read2') off += 2;
      else {
        const size = m[1] === 'memread_table8' ? 1 : 4;
        const cnt = n ?? (byte(off) | (byte(off + 1) << 8));
        off += (n == null ? 2 : 0) + cnt * size;
      }
    }
    return { store: st, off, raw: init };
  }

  /** `local x = expr` lines before `pos`, as {x: expr}, inner names substituted once */
  function localsBefore(src, pos) {
    const out = {};
    const fnStart = src.lastIndexOf('function', pos);
    for (const m of src.slice(Math.max(0, fnStart), pos).matchAll(/\blocal\s+([A-Za-z_]\w*)\s*=\s*([^\n]+)/g)) out[m[1]] = m[2].trim();
    return out;
  }

  // ------------------------------------------------------------------ //
  // Palettes an fx sets                                                //
  // ------------------------------------------------------------------ //

  /**
   * -> {screen: [{label, colors, line, traced}], fades: [{label, store, base, rows, row, line, drawsFrom}], fromData: bool}
   * screen  = pal(..,1) candidates; fades = pal(memread_table8(16),2) rows of a fade table.
   */
  function fxPalettes(fxName, carts, want) {
    const fx = carts.get(fxName.toLowerCase());
    if (!fx) return { screen: [], fades: [], fromData: false };
    const an = analyzeFx(fx, carts);
    const { src, tables } = an;
    const screen = [];
    const fades = [];
    let fromData = false;
    const lbl = (line, how) => `${fx.name}:${line + (fx.luaAt || 0)} · ${how}`;
    const resolveTable = (expr, pos) => {
      // name, this.name, or a local alias of one (local p = this.palettes[this.pal])
      expr = expr.trim();
      const ix = /^([\w.]+)\[(.+)\]$/.exec(expr);
      if (ix) {
        const base = resolveTable(ix[1], pos);
        if (!base) return null;
        return { many: [...base.one.entries()].filter(([, v]) => v instanceof Map).map(([k, v]) => ({ key: k, map: v })), name: `${last(ix[1])}[…]` };
      }
      if (/^[A-Za-z_][\w.]*$/.test(expr)) {
        if (tables.has(last(expr))) return { one: tables.get(last(expr)), name: last(expr) };
        const loc = localsBefore(src, pos)[expr];
        if (loc && loc !== expr) return resolveTable(loc, pos);
      }
      return null;
    };
    const byteRow = (st, off, n = 16) => {
      const r = storeOrigin(st, off, carts, want);
      return r ? Array.from(r.cart.rom.subarray(r.off, r.off + n)) : null;
    };

    for (const m of src.matchAll(/\bpal\s*\(/g)) {
      const call = callArgs(src, m.index + m[0].length - 1);
      if (!call) continue;
      const a = call.args;
      const which = a[a.length - 1];
      const line = lineAt(src, m.index);
      if (a.length === 2 && which === '2' && /^memread_table8\s*\(\s*16\s*\)$/.test(a[0])) {
        const t = traceRead(an, m.index, carts, want);
        if (!t) continue;
        const ia = callArgs(src, t.raw.index + t.raw[0].length - 1);
        fades.push({ label: lbl(line, `${t.store.name || 'table'} row ${t.off >> 4}`), store: t.store, rows: t.store.len >> 4, row: t.off >> 4, line, drawsFrom: drawSource(an, call.end), expr: ia?.args[1] || '0' });
        continue;
      }
      if (which !== '1') continue;
      if (a.length === 2) {
        // pal(memread_table8(16),1) or pal(x,1) with x = memread_table8(..)
        // readPos: where that memread_table8( call starts; no count argument = 2-byte count first
        let readPos = /^memread_table8\s*\(/.test(a[0]) ? m.index + m[0].length : null;
        if (readPos == null && /^[\w.]+$/.test(a[0])) {
          const as = [...src.matchAll(new RegExp(`\\b${last(a[0])}\\s*=\\s*memread_table8\\s*\\(`, 'g'))].pop();
          if (as) readPos = as.index + as[0].lastIndexOf('memread_table8');
        }
        if (readPos != null) {
          fromData = true;
          const t = traceRead(an, readPos, carts, want);
          const open = src.indexOf('(', readPos);
          const pre = callArgs(src, open)?.args[0] === '' ? 2 : 0;
          const row = t && byteRow(t.store, t.off + pre);
          if (row && row.every((v) => VALID.has(v))) screen.push({ label: lbl(line, `${t.store.name || 'table'} @${hex4(t.off + pre)}`), colors: row, line, traced: true });
          continue;
        }
        if (a[0].includes('(')) { fromData ||= src.includes('memread_table8'); continue; } // helper like this:getpal(..)
        if (a[0].startsWith('{') || a[0].startsWith('split')) {
          const p = palFromMap(parseValue(a[0], 0).v);
          if (p) screen.push({ label: lbl(line, 'table'), colors: p, line });
          continue;
        }
        const t = resolveTable(a[0], m.index);
        if (t?.one) { const p = palFromMap(t.one); if (p) screen.push({ label: lbl(line, t.name), colors: p, line }); }
        if (t?.many) for (const e of t.many) { const p = palFromMap(e.map); if (p) screen.push({ label: lbl(line, `${t.name.replace('…', e.key)}`), colors: p, line }); }
      } else if (a.length === 3 && /^[A-Za-z_]\w*$/.test(a[0])) {
        const v = a[0];
        const loops = [...src.slice(0, m.index).matchAll(new RegExp(`\\bfor\\s+${v}\\s*=\\s*([^,]+),([^\\s]+?)\\s*do`, 'g'))];
        const lp = loops[loops.length - 1];
        const lo = lp ? evalExpr(lp[1].trim()) : 0;
        const hi = lp ? evalExpr(lp[2].trim()) : 15;
        if (lo == null || hi == null) continue;
        const locals = { ...an.fields, ...localsBefore(src, m.index) };
        const ordm = /^ord\s*\(\s*([\w.]+)\s*,\s*(.+)\)$/.exec(a[1]);
        if (ordm) {
          // pal(i, ord(shades, idx+i), 1): bytes of a stored table (ord is 1-based)
          fromData = true;
          const st = storeByName(an, ordm[1]);
          if (!st) continue;
          const at = (base) => {
            const colors = STD.slice();
            for (let i = Math.max(0, lo); i <= Math.min(15, hi); i++) {
              const k = evalExpr(ordm[2], { ...locals, [v]: i });
              const b = k == null ? null : byteRow(st, k - 1 + base, 1)?.[0];
              if (b == null || !VALID.has(b)) return null;
              colors[i] = b;
            }
            return colors;
          };
          let colors = at(0);
          let how = `${st.name} bytes`;
          if (!colors || new Set(colors).size < 6) {
            // the rest values give a faded-out row: take the most colorful row of the table
            let best = null;
            for (let b = 0; b + 16 <= st.len; b += 16) { const c = at(b); if (c && (!best || new Set(c).size > new Set(best.c).size)) best = { c, b }; }
            if (best) { colors = best.c; how = `${st.name} @${hex4(best.b)}, most colorful row`; }
          }
          if (colors) screen.push({ label: lbl(line, how), colors, line, traced: true });
          continue;
        }
        const ix = /^([\w.]+)\[(.+)\]$/.exec(a[1]);
        if (!ix) continue;
        const t = resolveTable(ix[1], m.index);
        const maps = t?.one ? [{ key: null, map: t.one }] : t?.many || [];
        for (const e of maps) {
          const colors = STD.slice();
          let ok = true;
          for (let i = Math.max(0, lo); i <= Math.min(15, hi); i++) {
            const k = evalExpr(ix[2], { ...locals, [v]: i });
            const c = k == null ? null : (e.map.get(k) ?? 0); // pal(i,nil) shows color 0
            if (c == null || !VALID.has(c)) { ok = false; break; }
            colors[i] = c;
          }
          if (ok) screen.push({ label: lbl(line, `${e.key == null ? t.name : `${last(ix[1])}[${e.key}]`}${/[+-]/.test(ix[2]) ? ', default fade' : ''}`), colors, line });
        }
      }
    }
    return { screen, fades, fromData };
  }

  /** memory address the next draw call after `pos` reads its sprites from */
  function drawSource(an, pos) {
    const rest = an.src.slice(pos);
    const d = /\b(spr|sspr|map|tline)\s*\(/.exec(rest);
    if (!d) return null;
    const pk = [...rest.slice(0, d.index).matchAll(/poke\s*\(\s*0x5f54\s*,\s*([^,)]+)/g)].pop();
    const page = pk ? evalExpr(pk[1]) : 0;
    return page == null ? null : (page & 0xff) << 8;
  }

  /** the store a draw from memory `addr` shows: mem_restore(addr, x) or a store loaded straight there */
  function storeAt(an, addr) {
    for (const m of an.src.matchAll(/\bmem_restore\s*\(/g)) {
      const a = callArgs(an.src, m.index + m[0].length - 1);
      if (a && evalExpr(a.args[0]) === addr) { const s = storeByName(an, a.args[1]); if (s) return s; }
    }
    return an.stores.find((s) => s.addr === addr) || null;
  }

  // ------------------------------------------------------------------ //
  // Sections of a data cart                                            //
  // ------------------------------------------------------------------ //

  /**
   * A cart reading its own data: when it runs, 0x0000-0x42ff already holds its __gfx__, __map__,
   * __gff__, __music__ and __sfx__, so sget(), mget(), map(), @0x2000 or memcpy(.., 0x1000, ..)
   * read them without any reload().
   * -> { gfx|map|gff|music|sfx: { how: ['sget() line 72', ..], values, width } }
   *    values: read as numbers (sget / mget / fget / peek / memcpy), not only drawn;
   *    width: row length guessed from the address arithmetic (<<6, *64 -> 64)
   */
  function ownReads(cart) {
    const out = {};
    const regionAt = (a) => C.REGIONS.find((r) => a >= r.start && a < r.end);
    const add = (id, how, line, values, width) => {
      const reg = C.REGIONS.find((r) => r.id === id);
      if (!reg || !cart.used.subarray(reg.start, reg.end).some((v) => v)) return;
      const r = (out[id] ||= { how: [], values: false, width: null });
      const label = `${how} line ${line}`;
      if (r.how.length < 8 && !r.how.some((h) => h.startsWith(`${how} `))) r.how.push(label);
      if (values) r.values = true;
      if (width && !r.width) r.width = width;
    };
    const lines = (cart.lua || '').split('\n');
    lines.forEach((raw, i) => {
      // code only: no comments, no string contents
      const l = raw.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""').replace(/--.*$/, '');
      if (!l.trim()) return;
      const ln = i + 1 + (cart.luaAt || 0);
      const call = (name) => new RegExp(`(?<![\\w.:])${name}\\s*\\(`).test(l);
      if (call('sget')) add('gfx', 'sget()', ln, true);
      if (call('spr')) add('gfx', 'spr()', ln, false);
      if (call('sspr')) add('gfx', 'sspr()', ln, false);
      if (call('mget')) add('map', 'mget()', ln, true);
      if (call('map')) { add('map', 'map()', ln, false); add('gfx', 'map()', ln, false); }
      if (call('tline')) { add('map', 'tline()', ln, false); add('gfx', 'tline()', ln, false); }
      if (call('fget')) add('gff', 'fget()', ln, true);
      if (call('sfx')) add('sfx', 'sfx()', ln, false);
      if (call('music')) { add('music', 'music()', ln, false); add('sfx', 'music()', ln, false); }
      // memory reads with a literal address inside the cart area
      const stride = (() => { const m = /<<\s*([5-8])\b/.exec(l) || /\*\s*(32|64|128|256)\b/.exec(l); return m ? (m[1].length === 1 ? 1 << Number(m[1]) : Number(m[1])) : null; })();
      const lit = (s) => { const v = /^0x/i.test(s) ? parseInt(s, 16) : Number(s); return Number.isFinite(v) ? v : null; };
      for (const m of l.matchAll(/(?:@|\$|(?<![\w.:])peek[24]?\s*\()\s*\(?\s*(0x[0-9a-f]+|\d+)/gi)) {
        const a = lit(m[1]), reg = a != null && regionAt(a);
        if (reg) add(reg.id, `${m[0].trim().startsWith('@') ? '@' : m[0].trim().startsWith('$') ? '$' : 'peek'}${hex4(a)}`, ln, true, stride);
      }
      const mc = /(?<![\w.:])memcpy\s*\(\s*[^,]+,\s*\(?\s*(0x[0-9a-f]+|\d+)/i.exec(l);
      if (mc) { const a = lit(mc[1]), reg = a != null && regionAt(a); if (reg) add(reg.id, `memcpy from ${hex4(a)}`, ln, true, stride); }
    });
    return out;
  }

  /**
   * -> [{id, start, len, label, fx, kind: 'img'|'pal'|'hex', store}]
   * One section per mem_store() piece that comes from this cart, plus the reloaded parts
   * no store cuts out (used straight from memory), plus content nobody reads.
   */
  function sections(cart, carts) {
    const out = [];
    const want = cart.name.toLowerCase();
    const fxNames = [...new Set(cart.reads.map((r) => r.from))];
    for (const fxName of fxNames) {
      const fx = carts.get(fxName.toLowerCase());
      if (!fx) continue;
      const an = analyzeFx(fx, carts);
      const covered = new Uint8Array(ROM);
      for (const s of an.stores) {
        for (const p of s.pieces) {
          if (!p.carts.includes(want)) continue;
          const len = Math.min(p.len, ROM - p.off);
          if (len <= 0) continue;
          covered.fill(1, p.off, p.off + len);
          const label = s.name || s.note || `mem_store line ${s.line + (fx.luaAt || 0)}`;
          // a big store whose tables are read from an offset: image part + table part
          const inits = s.name ? [...an.src.matchAll(new RegExp(`memread_init\\s*\\(\\s*[\\w.]*\\b${s.name}\\b\\s*(?:,([^)]*))?\\)`, 'g'))].map((x) => (x[1] ? evalExpr(x[1]) : 0)) : [];
          const split = inits.length && inits.every((o) => o != null && o > 0) ? Math.min(...inits) : 0;
          if (split && split < len && p.mem === s.addr) {
            out.push({ start: p.off, len: split, fx: fx.name, store: s, label, kind: 'img' });
            out.push({ start: p.off + split, len: len - split, fx: fx.name, store: s, label: `${label} tables (memread from ${hex4(split)})`, kind: 'hex' });
          } else out.push({ start: p.off, len, fx: fx.name, store: s, label });
        }
      }
      for (const l of an.loads.filter((x) => x.carts.includes(want) && x.src != null && x.len)) {
        // parts of the reload no store cuts out: used straight from memory (sget, map, ..)
        const end = Math.min(ROM, l.src + l.len);
        const storesHere = covered.subarray(l.src, end).some((v) => v);
        let a = l.src;
        while (a < end) {
          if (covered[a]) { a++; continue; }
          let b = a;
          while (b < end && !covered[b]) b++;
          // next to stores, only bigger leftovers count (small gaps are padding)
          if ((b - a >= 0x400 || (!storesHere && b - a >= 64)) && cart.used.subarray(a, b).some((v) => v)) out.push({ start: a, len: b - a, fx: fx.name, store: null, label: storesHere ? 'reloaded, not stored (used in place?)' : 'reloaded, used in place' });
          a = b;
        }
      }
    }
    // regions the cart's own code reads (sget, mget, @0x2000, ..)
    const own = cart.own || ownReads(cart);
    for (const reg of C.REGIONS) {
      const o = own[reg.id];
      if (!o || out.some((s) => s.start <= reg.start && s.start + s.len >= reg.end)) continue;
      out.push({ start: reg.start, len: Math.min(reg.end, ROM) - reg.start, fx: cart.name, own: o, store: null, label: `${reg.name}, read by its own code (${o.how.map((h) => h.replace(/ line \d+$/, '')).join(', ')})` });
    }
    // content no fx reads: runs of used bytes outside every read range, per region
    const read = new Uint8Array(ROM);
    for (const s of out) read.fill(1, s.start, s.start + s.len);
    for (const r of cart.reads) read.fill(1, r.src, r.src + r.len);
    for (const reg of C.REGIONS) {
      const end = Math.min(reg.end, ROM);
      if (own[reg.id]) continue;
      if (!cart.reads.length) {
        // nobody reloads this cart: show its regions whole
        if (cart.used.subarray(reg.start, end).filter((v) => v).length >= 64) out.push({ start: reg.start, len: end - reg.start, fx: null, store: null, label: reg.name });
        continue;
      }
      let a = reg.start;
      while (a < end) {
        if (read[a] || !cart.used[a]) { a++; continue; }
        let b = a;
        let gap = 0;
        while (b < end && gap < 64) { if (read[b]) break; gap = cart.used[b] ? 0 : gap + 1; b++; }
        b -= gap;
        // whole 64-byte rows (one 128 px image line each)
        const s0 = Math.max(reg.start, a & ~63);
        const s1 = Math.min(end, (b + 63) & ~63);
        if (b - a >= 64) out.push({ start: s0, len: s1 - s0, fx: null, store: null, label: `${reg.name}, not read by any fx` });
        a = b + 1;
      }
    }
    // dedupe (same range from several stores/fx), keep the first label
    const seen = new Map();
    for (const s of out) {
      const k = `${s.start}:${s.len}`;
      if (seen.has(k)) { const o = seen.get(k); if (s.fx && o.fx && !o.alsoFx?.includes(s.fx) && o.fx !== s.fx) (o.alsoFx ||= []).push(s.fx); continue; }
      seen.set(k, s);
    }
    const list = [...seen.values()].sort((x, y) => x.start - y.start || y.len - x.len);
    for (const s of list) {
      s.id = `${s.start}:${s.len}`;
      s.kind ||= kindOf(s, cart, carts);
    }
    return list;
  }

  function kindOf(s, cart, carts) {
    const b = cart.rom.subarray(s.start, s.start + Math.min(16, s.len));
    const palLike = s.len % 16 === 0 && s.len <= 0x1000 && b.length === 16 && Array.from(b).every((v) => VALID.has(v));
    if (s.store && s.fx) {
      const an = analyzeFx(carts.get(s.fx.toLowerCase()), carts);
      const readByMemread = new RegExp(`memread_init\\s*\\(\\s*[\\w.]*\\b${s.store.name}\\b`).test(an.src);
      if (palLike) return 'pal';
      if (readByMemread) return 'hex'; // tables (an image part before a memread offset is split off already)
    }
    if (palLike && s.len <= 0x400) return 'pal';
    return s.len >= 0x400 ? 'img' : 'hex';
  }

  /** fx whose name matches an unreferenced cart (spr_tower.p8 <-> fx_tower.p8) */
  function nameMatchFx(cart, carts) {
    const base = cart.name.replace(/\.p8$/i, '').replace(/^(spr|dat|gfx|data|img)_/i, '').toLowerCase();
    const f = carts.get(`fx_${base}.p8`);
    return f ? f.name : null;
  }

  /**
   * Draw calls colored through the secondary palette at run time: poke(0x5f60..0x5f6f, ..),
   * pal(x,2) with a computed table, fillp(..+0x0.4) (tline / spr use it). The pixel values are
   * then lookups (materials, shades), and no screen palette shows them as the fx does.
   * -> [{line, text}]
   */
  function secondaryUse(fx) {
    if (!fx?.lua) return [];
    const out = [];
    fx.lua.split('\n').forEach((raw, i) => {
      const l = raw.replace(/--.*$/, '');
      if (/\bpoke[24]?\s*\(\s*0x5f6[0-9a-f]\b/i.test(l) || /\bpal\s*\((?!\s*memread_table8)[^()]*(\([^()]*\)[^()]*)*,\s*2\s*\)/.test(l) || /\bfillp\s*\([^)]*(\+|\|)\s*0x0\.4\b/i.test(l)) {
        out.push({ line: i + 1 + (fx.luaAt || 0), text: raw.trim() });
      }
    });
    return out;
  }

  /**
   * Palettes for one section -> {screen: [{key,label,colors}], fades: [{key,label,cart,base,rows,row}],
   * secondary: [{fx, line, text}], auto: {screen, fade}}
   */
  function sectionPalettes(sec, cart, carts) {
    const want = cart.name.toLowerCase();
    const fxs = [sec.fx, ...(sec.alsoFx || [])].filter(Boolean);
    if (!fxs.length) { const n = nameMatchFx(cart, carts); if (n) fxs.push(n); }
    // a self-contained fx (no other cart reloads it): its own code draws its __gfx__ / __map__
    if (!fxs.length && /\b(spr|sspr|map|tline|sget|mget|pal)\s*\(/.test(cart.lua || '')) fxs.push(cart.name);
    const screen = [];
    const fades = [];
    let auto = null;
    let autoFade = null;
    for (const f of fxs) {
      const p = fxPalettes(f, carts, want);
      for (const s of p.screen) screen.push({ key: `s:${s.label}`, label: s.label + (sec.fx ? '' : f === cart.name ? " (this cart's code)" : ' (name match)'), colors: s.colors, traced: s.traced, fx: f });
      for (const d of p.fades) {
        const o = storeOrigin(d.store, 0, carts, want);
        if (!o) continue;
        const fk = { key: `f:${d.label}`, label: d.label, cart: o.cart.name.toLowerCase(), base: o.off, rows: d.rows, row: d.row, fx: f };
        fades.push(fk);
        // the fade row used for what is drawn from this section
        const shown = d.drawsFrom != null && storeAt(analyzeFx(carts.get(f.toLowerCase()), carts), d.drawsFrom);
        // (row 0 is the screen palette itself: an unknown fade value evaluated to 0)
        if (shown && sec.store && shown === sec.store && d.row > 0) autoFade ||= fk;
      }
      if (p.fromData && !p.screen.some((s) => s.traced)) {
        // palette read by a helper: the small palette-like tables this fx stores
        const an = analyzeFx(carts.get(f.toLowerCase()), carts);
        const st = an.stores.filter((s) => s.len % 16 === 0 && s.len <= 0x1000).sort((x, y) => x.len - y.len);
        for (const s of st) {
          const o = storeOrigin(s, 0, carts, want);
          const row = o && Array.from(o.cart.rom.subarray(o.off, o.off + 16));
          if (row && row.length === 16 && row.every((v) => VALID.has(v)) && new Set(row).size >= 4) screen.push({ key: `s:${f}:${s.name || s.line}`, label: `${f} · ${s.name || s.note || 'table'} (${o.cart.name} ${hex4(o.off)})`, colors: row, traced: true, fx: f });
        }
      }
    }
    // tables stored in this cart with memread_table8()'s 2-byte count
    for (let i = 0; i + 18 <= ROM && screen.length < 24; i++) {
      if (cart.rom[i] !== 16 || cart.rom[i + 1] !== 0) continue;
      const v = Array.from(cart.rom.subarray(i + 2, i + 18));
      if (v.every((x) => VALID.has(x)) && new Set(v).size >= 6) { screen.push({ key: `d:${i + 2}`, label: `${hex4(i + 2)} · 16-entry table in ${cart.name}`, colors: v, data: true }); i += 17; }
    }
    auto = screen.find((s) => s.traced && fxs.includes(s.fx) && s.fx === sec.fx) || screen.find((s) => s.fx === sec.fx) || screen.find((s) => !s.data) || null;
    if (!auto && fxs.some((f) => fxPalettes(f, carts, want).fromData)) auto = screen.find((s) => s.data) || null;
    const secondary = fxs.flatMap((f) => secondaryUse(carts.get(f.toLowerCase())).map((u) => ({ ...u, fx: f })));
    return { screen, fades, secondary, auto: { screen: auto?.key || null, fade: autoFade?.key || null } };
  }

  // ------------------------------------------------------------------ //
  // Layered images (color image + layer mask, fx_skull style)          //
  // ------------------------------------------------------------------ //
  //
  // The fx builds layer l+1 from the color image by drawing the mask over it with
  // the shade table's row 1 as draw palette for mask values 1..l (palt), which
  // turns those pixels into color 0; layers above the first draw color 0 transparent.

  const EMPTY = 255; // Pixel Studio's "no pixel"

  const decode4 = (b) => { const px = new Uint8Array(b.length * 2); for (let i = 0; i < b.length; i++) { px[i * 2] = b[i] & 15; px[i * 2 + 1] = b[i] >> 4; } return px; };

  /** -> {image, mask, table, layers, maxMask, fx, counted} or null */
  function layerInfo(cart, carts, secs) {
    const mask = secs.find((s) => s.kind === 'img' && /mask/i.test(s.label));
    const image = mask && secs.find((s) => s.kind === 'img' && s !== mask && s.fx === mask.fx && s.len === mask.len);
    if (!image) return null;
    const fx = carts.get(mask.fx.toLowerCase());
    const an = analyzeFx(fx, carts);
    const table = secs.find((s) => s.kind === 'pal' && s.fx === mask.fx) || null;
    const m = decode4(cart.rom.subarray(mask.start, mask.start + mask.len));
    const maxMask = m.reduce((a, v) => Math.max(a, v), 0);
    // layer count from the code: `local layers = expr` in a loop over a list of cart names
    let layers = null;
    const lm = /\blocal\s+layers\s*=\s*([^\n]+)/.exec(an.src);
    if (lm) {
      const loop = /\bfor\s+([A-Za-z_]\w*)\s*=\s*1\s*,\s*#([A-Za-z_]\w*)\s*do/.exec(an.src);
      const list = loop && an.tables.get(loop[2]);
      const idx = list && [...list.entries()].find(([, v]) => typeof v === 'string' && v.toLowerCase() === cart.name.toLowerCase())?.[0];
      layers = evalExpr(lm[1].trim(), idx != null ? { [loop[1]]: String(idx) } : {});
    }
    const counted = layers != null && layers > 0;
    return { image, mask, table, fx: fx.name, maxMask, counted, layers: counted ? Math.min(16, layers) : Math.min(16, maxMask + 1) };
  }

  /**
   * -> [Uint8Array(w*h)] bottom first; EMPTY = transparent (Pixel Studio cels).
   * split=false: as the fx has them (lower layers keep the pixels under the upper ones);
   * split=true: every pixel only on its top layer.
   */
  function buildLayers(cart, info, count = info.layers, split = false) {
    const img = decode4(cart.rom.subarray(info.image.start, info.image.start + info.image.len));
    const mask = decode4(cart.rom.subarray(info.mask.start, info.mask.start + info.mask.len));
    const row = info.table ? cart.rom.subarray(info.table.start + 16, info.table.start + 32) : new Uint8Array(16);
    const out = [img.slice()];
    const scr = img.slice();
    for (let i = 1; i < count; i++) {
      for (let p = 0; p < scr.length; p++) { const v = mask[p]; if (v >= 1 && v <= i) scr[p] = row[v] & 15; }
      out.push(Uint8Array.from(scr, (v) => (v === 0 ? EMPTY : v)));
    }
    if (split) for (let l = 0; l < out.length - 1; l++) for (let p = 0; p < img.length; p++) if (out[l + 1][p] !== EMPTY) out[l][p] = EMPTY;
    return out;
  }

  /**
   * A palette / fade table section (row 0 = screen palette, rows 1.. = pal(..,2) rows of packed
   * color pairs) -> Palette & Fades fades {dark, bright, normalRow, from}.
   * The "no fade" row (low nibble = own slot) is step 0; the rows on each side of it are
   * spread over the 32 steps of that direction (darker rows below it count as 'dark').
   * Integer fade levels show the low nibble, so coverage is 0 (Palette & Fades: hi where bayer < cov).
   */
  function fadeFromTable(cart, sec) {
    const rows = Math.floor(sec.len / 16);
    if (rows < 3) return null;
    const row = (r) => Array.from(cart.rom.subarray(sec.start + r * 16, sec.start + r * 16 + 16));
    let best = 1;
    let bestScore = -1;
    for (let r = 1; r < rows; r++) {
      const score = row(r).filter((v, c) => (v & 15) === c).length;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    const side = (dir) => {
      // at most 16 rows per side: the tables are built as normal row +-16 (33 rows);
      // longer tables hold a second ramp after that
      const k = Math.min(16, dir < 0 ? best - 1 : rows - 1 - best);
      if (k < 1) return null;
      const order = Array.from({ length: 32 }, (_, st) => best + dir * Math.round((st * k) / 31));
      return { tables: order.map(row), coverage: new Array(32).fill(0), rows: [order[0], order[31]] };
    };
    // which side is darker: compare the average brightness index of the end rows' screen colors
    const lum = (r) => row(r).reduce((a, v) => a + (v & 15), 0);
    let lo = side(-1);
    let hi = side(1);
    if (lo && hi && lum(lo.rows[1]) > lum(hi.rows[1])) [lo, hi] = [hi, lo];
    if (!lo && hi && lum(hi.rows[1]) < lum(best)) [lo, hi] = [hi, null];
    return { dark: lo, bright: hi, normalRow: best, from: `${cart.name} ${hex4(sec.start)}` };
  }

  /** colors for slots 0..15 after an optional fade row: screen[ row[c] & 15 ] */
  function effectiveColors(screen, fade, carts) {
    if (!fade) return screen.slice();
    const c = carts.get(fade.cart);
    if (!c) return screen.slice();
    const o = fade.base + fade.row * 16;
    return STD.map((i) => screen[(c.rom[o + i] ?? i) & 15]);
  }

  return { VALID, STD, EMPTY, hex4, ownReads, secondaryUse, callArgs, parseValue, evalExpr, palFromMap, parseLuaPal, analyzeFx, fxPalettes, sections, sectionPalettes, effectiveColors, nameMatchFx, layerInfo, buildLayers, fadeFromTable };
})();

if (typeof module !== 'undefined') module.exports = P8DataView;
