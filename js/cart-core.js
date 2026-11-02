// js/cart-core.js
// Exact .p8 <-> cart ROM conversion for the data area 0x0000-0x42ff (what reload() can read),
// plus the byte-LZ codec used for packed data carts. No DOM; runs in Node for tests.
//
// ROM layout:  0x0000 gfx (8 KB, lower half shared with map rows 32-63)
//              0x2000 map (4 KB)   0x3000 gff (256 B)   0x3100 music (256 B)   0x3200 sfx (64 x 68 B)

'use strict';

const P8Cart = (() => {
  const ROM_SIZE = 0x4300;
  const REGIONS = [
    { id: 'gfx', name: 'Sprite sheet (__gfx__)', start: 0x0000, end: 0x2000 },
    { id: 'map', name: 'Map (__map__)', start: 0x2000, end: 0x3000 },
    { id: 'gff', name: 'Sprite flags (__gff__)', start: 0x3000, end: 0x3100 },
    { id: 'music', name: 'Music (__music__)', start: 0x3100, end: 0x3200 },
    { id: 'sfx', name: 'Sound effects (__sfx__)', start: 0x3200, end: 0x4300 },
  ];

  /** What PICO-8 puts in memory for missing __music__ / __sfx__ lines (measured in 0.2.7). */
  function defaultRom() {
    const rom = new Uint8Array(ROM_SIZE);
    for (let i = 0; i < 64; i++) rom.set([0x41, 0x42, 0x43, 0x44], 0x3100 + i * 4);
    for (let i = 0; i < 64; i++) rom[0x3200 + i * 68 + 65] = i === 0 ? 1 : 16;
    return rom;
  }
  const DEFAULT_ROM = defaultRom();

  const hexv = (c) => {
    const v = parseInt(c, 16);
    return Number.isNaN(v) ? 0 : v;
  };
  const h2 = (b) => (b & 255).toString(16).padStart(2, '0');

  /** Splits a .p8 text into {header, sections: {name: [lines]}, order: [names]}. */
  function splitSections(text) {
    const sections = {};
    const order = [];
    const header = [];
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const m = /^__([a-z0-9_]+)__\s*$/i.exec(raw);
      if (m) {
        cur = m[1].toLowerCase();
        sections[cur] = [];
        order.push(cur);
        continue;
      }
      if (cur) sections[cur].push(raw); else header.push(raw);
    }
    return { header, sections, order };
  }

  /** .p8 text -> {rom: Uint8Array(0x4300), lua, sections, present: Set} */
  function parseP8(text) {
    const { header, sections, order } = splitSections(text);
    const rom = defaultRom();
    const lines = (n) => (sections[n] || []).map((l) => l.trim()).filter((l) => l.length);

    // gfx: 128 rows x 128 hex digits, one digit per pixel, left pixel = low nibble
    lines('gfx').slice(0, 128).forEach((l, y) => {
      for (let x = 0; x < 128 && x < l.length; x += 2) rom[y * 64 + (x >> 1)] = hexv(l[x]) | (hexv(l[x + 1] || '0') << 4);
    });
    // map: 32 rows x 256 hex digits, plain bytes
    lines('map').slice(0, 32).forEach((l, y) => {
      for (let x = 0; x < 256 && x + 1 < l.length; x += 2) rom[0x2000 + y * 128 + (x >> 1)] = hexv(l[x]) * 16 + hexv(l[x + 1]);
    });
    // gff: 2 rows x 256 hex digits
    lines('gff').slice(0, 2).forEach((l, y) => {
      for (let x = 0; x < 256 && x + 1 < l.length; x += 2) rom[0x3000 + y * 128 + (x >> 1)] = hexv(l[x]) * 16 + hexv(l[x + 1]);
    });
    // music: "FF AABBCCDD" - flag bit n goes to bit 7 of channel byte n
    lines('music').slice(0, 64).forEach((l, i) => {
      const [f, ch = ''] = l.split(/\s+/);
      const flags = parseInt(f, 16) || 0;
      for (let c = 0; c < 4; c++) rom[0x3100 + i * 4 + c] = ((hexv(ch[c * 2]) * 16 + hexv(ch[c * 2 + 1])) & 0x7f) | (((flags >> c) & 1) << 7);
    });
    // sfx: 8 hex header (mode, speed, loop start, loop end) + 32 notes x 5 hex (pitch 2, wave 1, vol 1, fx 1)
    lines('sfx').slice(0, 64).forEach((l, i) => {
      const base = 0x3200 + i * 68;
      rom.fill(0, base, base + 68);
      for (let k = 0; k < 4; k++) rom[base + 64 + k] = hexv(l[k * 2]) * 16 + hexv(l[k * 2 + 1]);
      for (let n = 0; n < 32; n++) {
        const o = 8 + n * 5;
        if (o + 5 > l.length) break;
        const pitch = (hexv(l[o]) * 16 + hexv(l[o + 1])) & 63;
        const wave = hexv(l[o + 2]);
        const vol = hexv(l[o + 3]) & 7;
        const fx = hexv(l[o + 4]) & 7;
        const v = pitch | ((wave & 7) << 6) | (vol << 9) | (fx << 12) | ((wave >> 3) << 15);
        rom[base + n * 2] = v & 255;
        rom[base + n * 2 + 1] = v >> 8;
      }
    });

    const versionLine = header.find((l) => /^version\s+\d+/.test(l));
    return {
      rom,
      lua: (sections.lua || []).join('\n'),
      label: sections.label || null,
      version: versionLine ? Number(versionLine.split(/\s+/)[1]) : null,
      present: new Set(order),
      sections,
    };
  }

  // Writing ------------------------------------------------------------- //

  function gfxText(rom) {
    const out = [];
    for (let y = 0; y < 128; y++) {
      let l = '';
      for (let x = 0; x < 64; x++) { const b = rom[y * 64 + x]; l += (b & 15).toString(16) + (b >> 4).toString(16); }
      out.push(l);
    }
    return out;
  }
  const bytesText = (rom, start, rows, len) => Array.from({ length: rows }, (_, y) => Array.from(rom.subarray(start + y * len, start + (y + 1) * len), h2).join(''));
  function musicText(rom) {
    return Array.from({ length: 64 }, (_, i) => {
      let flags = 0;
      let ch = '';
      for (let c = 0; c < 4; c++) { const b = rom[0x3100 + i * 4 + c]; flags |= (b >> 7) << c; ch += h2(b & 0x7f); }
      return `${h2(flags)} ${ch}`;
    });
  }
  function sfxText(rom) {
    return Array.from({ length: 64 }, (_, i) => {
      const base = 0x3200 + i * 68;
      let l = '';
      for (let k = 0; k < 4; k++) l += h2(rom[base + 64 + k]);
      for (let n = 0; n < 32; n++) {
        const v = rom[base + n * 2] | (rom[base + n * 2 + 1] << 8);
        l += h2(v & 63) + (((v >> 6) & 7) | ((v >> 15) << 3)).toString(16) + ((v >> 9) & 7).toString(16) + ((v >> 12) & 7).toString(16);
      }
      return l;
    });
  }

  const isZero = (rom, a, b) => { for (let i = a; i < b; i++) if (rom[i]) return false; return true; };
  const isDefault = (rom, a, b) => { for (let i = a; i < b; i++) if (rom[i] !== DEFAULT_ROM[i]) return false; return true; };
  /** Rows without trailing all-zero rows (PICO-8 does the same when saving). */
  const trimRows = (rows, zero) => { let n = rows.length; while (n > 0 && rows[n - 1] === zero) n--; return rows.slice(0, n); };

  /**
   * ROM -> .p8 text. gfx / map / gff: left out when zero, trailing zero rows trimmed (PICO-8 loads
   * zeros there). sfx / music: missing lines load as defaults, not zeros, so they are written
   * in full unless they equal the defaults. lua: code text ('' for pure data carts).
   */
  function writeP8({ rom, lua = '', version = 42, label = null }) {
    const parts = [`pico-8 cartridge // http://www.pico-8.com\nversion ${version}\n__lua__\n${lua.replace(/\n+$/, '')}\n`];
    const add = (name, rows) => { if (rows.length) parts.push(`__${name}__\n${rows.join('\n')}\n`); };
    if (!isZero(rom, 0, 0x2000)) add('gfx', trimRows(gfxText(rom), '0'.repeat(128)));
    if (label) add('label', label);
    if (!isZero(rom, 0x3000, 0x3100)) add('gff', trimRows(bytesText(rom, 0x3000, 2, 128), '0'.repeat(256)));
    if (!isZero(rom, 0x2000, 0x3000)) add('map', trimRows(bytesText(rom, 0x2000, 32, 128), '0'.repeat(256)));
    if (!isDefault(rom, 0x3200, 0x4300)) add('sfx', sfxText(rom));
    if (!isDefault(rom, 0x3100, 0x3200)) add('music', musicText(rom));
    return parts.join('');
  }

  /** Simple order-independent checks used by tests and the inspector. */
  function checksum(rom, start = 0, end = rom.length) {
    let h = 0;
    for (let i = start; i < end; i++) h = (Math.imul(h, 31) + rom[i]) >>> 0;
    return h;
  }

  // Byte LZ ------------------------------------------------------------ //
  //
  // [len lo, len hi] then tokens:
  //   0..127   literal run of n+1 bytes (copied with memcpy)
  //   128..255 match of n-125 (3..130) bytes from <16-bit offset> back in the output;
  //            matches never overlap their source, so memcpy() is always correct.
  // Lua decoder (60 tokens, measured in PICO-8 0.2.7):  see LZ_LUA. Background: docs/COMPRESSION.md

  const LZ_LUA = `function unlz(s,d)
 local e=d+%s s+=2
 while d<e do
  local b=@s s+=1
  if b<128 then b+=1 memcpy(d,s,b) s+=b
  else b-=125 memcpy(d,d-%s,b) s+=2 end
  d+=b
 end
end`;

  /**
   * Optimal parse: the cheapest token sequence for the whole block, not the first long match.
   * Same format and decoder as before; about 1% smaller and a little faster to unpack.
   */
  function lzEncode(src, { chain = 1024 } = {}) {
    const n = src.length;
    if (n > 0xffff) throw new Error('LZ blocks are limited to 65535 bytes.');
    // cost[i] = fewest bytes for src[0..i); a literal run of L costs L + 1, a match 3
    const cost = new Float64Array(n + 1).fill(Infinity);
    const from = new Int32Array(n + 1);
    const off = new Int32Array(n + 1); // 0 = literal run
    cost[0] = 0;
    const head = new Map();
    const prev = new Int32Array(n).fill(-1);
    const key = (i) => src[i] | (src[i + 1] << 8) | (src[i + 2] << 16);
    for (let i = 0; i < n; i++) {
      const c0 = cost[i];
      for (let L = 1; L <= 128 && i + L <= n; L++) {
        if (c0 + L + 1 < cost[i + L]) { cost[i + L] = c0 + L + 1; from[i + L] = i; off[i + L] = 0; }
      }
      if (i + 2 >= n) continue;
      const k = key(i);
      let j = head.has(k) ? head.get(k) : -1;
      let best = 2;
      for (let c = chain; j >= 0 && c-- && best < 130; j = prev[j]) {
        const o = i - j;
        if (o > 0xffff) break;
        // matches never overlap their source, so memcpy() in unlz() is always correct
        const max = Math.min(130, n - i, o);
        if (max <= best || src[j + best] !== src[i + best]) continue;
        let l = 0;
        while (l < max && src[j + l] === src[i + l]) l++;
        // the nearest source reaching each length wins (all matches cost the same 3 bytes)
        for (let m = best + 1; m <= l; m++) if (c0 + 3 < cost[i + m]) { cost[i + m] = c0 + 3; from[i + m] = i; off[i + m] = o; }
        if (l > best) best = l;
      }
      prev[i] = head.has(k) ? head.get(k) : -1;
      head.set(k, i);
    }
    const toks = [];
    for (let p = n; p > 0; p = from[p]) toks.push(p);
    const out = [n & 255, n >> 8];
    let p = 0;
    for (let t = toks.length - 1; t >= 0; t--) {
      const e = toks[t];
      const len = e - p;
      if (off[e]) out.push(len + 125, off[e] & 255, off[e] >> 8);
      else { out.push(len - 1); for (let q = p; q < e; q++) out.push(src[q]); }
      p = e;
    }
    return Uint8Array.from(out);
  }

  function lzDecode(c, at = 0) {
    const n = c[at] | (c[at + 1] << 8);
    const out = new Uint8Array(n);
    let s = at + 2;
    let d = 0;
    while (d < n) {
      const b = c[s++];
      if (b < 128) {
        out.set(c.subarray(s, s + b + 1), d);
        s += b + 1;
        d += b + 1;
      } else {
        const len = b - 125;
        const off = c[s] | (c[s + 1] << 8);
        s += 2;
        out.copyWithin(d, d - off, d - off + len);
        d += len;
      }
    }
    return { data: out, end: s };
  }

  // reload() analysis ---------------------------------------------------- //

  /** PICO-8 number literal (dec, 0x hex with fraction, 0b binary) -> number, else null. */
  function parseNum(t) {
    t = t.trim();
    let m = /^-?0x([0-9a-f]*)(?:\.([0-9a-f]*))?$/i.exec(t);
    if (m) {
      const v = parseInt(m[1] || '0', 16) + (m[2] ? parseInt(m[2], 16) / 16 ** m[2].length : 0);
      return t.startsWith('-') ? -v : v;
    }
    m = /^-?0b([01]+)$/i.exec(t);
    if (m) return (t.startsWith('-') ? -1 : 1) * parseInt(m[1], 2);
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return null;
  }

  /** Splits a call's argument text at top-level commas. */
  function splitArgs(s) {
    const out = [];
    let depth = 0;
    let q = null;
    let cur = '';
    for (const ch of s) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      if (ch === ')' || ch === '}' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  /**
   * reload(dest, src, len, file) calls in Lua code (comments removed by the caller or not;
   * lines starting with -- are skipped). Numbers that are not literals come back as null,
   * file is null unless it is a string literal.
   */
  function findReloads(code) {
    const out = [];
    code.split(/\r?\n/).forEach((line, li) => {
      const clean = line.replace(/--.*$/, '');
      const re = /\breload\s*\(/g;
      let m;
      while ((m = re.exec(clean))) {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (i < clean.length && depth) { if (clean[i] === '(') depth++; else if (clean[i] === ')') depth--; i++; }
        const args = splitArgs(clean.slice(start, i - 1));
        const fileArg = args[3]?.trim();
        const fm = fileArg && /^["'](.*)["']$/.exec(fileArg);
        out.push({
          line: li + 1,
          text: clean.slice(m.index, i).trim(),
          dest: args.length ? parseNum(args[0]) : 0,
          src: args.length > 1 ? parseNum(args[1]) : 0,
          len: args.length > 2 ? parseNum(args[2]) : 0x4300,
          file: fm ? fm[1] : (fileArg ? null : ''),   // '' = the running cart itself
          fileExpr: fileArg || '',
        });
      }
    });
    return out;
  }

  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Which cart file(s) a reload's file argument can mean.
   * Returns {match(name) -> bool, label, inferred} or null for the running cart / unknown.
   *   "a.p8"            exact
   *   "m"..i..".p8"     pattern m<number>.p8
   *   filename          resolved from `filename= ...` in the same code
   *   names[i]          resolved from `names= {"a.p8", ...}` in the same code
   * This is an approximate PREVIEW (Data Carts analysis): it guesses numeric fragments and trusts an
   * initial table literal. Never base a destructive decision (retiring, adopting, rewriting) on it;
   * Cart Builder proves targets from the lexed code instead (project-core.js cartTargets).
   */
  function reloadTarget(expr, code, depth = 0) {
    expr = (expr || '').trim();
    if (!expr || depth > 3) return null;
    const lit = /^["']([^"']*)["']$/.exec(expr);
    if (lit) { const n = lit[1].toLowerCase(); return { match: (f) => f.toLowerCase() === n, label: lit[1], inferred: depth > 0 }; }
    if (expr.includes('..')) {
      const parts = expr.split('..').map((p) => p.trim());
      // the non-literal parts are counters in practice ("m"..i..".p8")
      const rx = parts.map((p) => { const m = /^["']([^"']*)["']$/.exec(p); return m ? reEsc(m[1]) : '\\d+'; }).join('');
      const re = new RegExp(`^${rx}$`, 'i');
      return { match: (f) => re.test(f), label: parts.map((p) => { const m = /^["']([^"']*)["']$/.exec(p); return m ? m[1] : '*'; }).join(''), inferred: true };
    }
    const idx = /^([A-Za-z_]\w*)\s*\[/.exec(expr);
    if (idx) {
      const tm = new RegExp(`\\b${idx[1]}\\s*=\\s*\\{([^}]*)\\}`).exec(code);
      const names = tm ? [...tm[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1].toLowerCase()) : [];
      if (names.length) return { match: (f) => names.includes(f.toLowerCase()), label: `${idx[1]}[…] = ${names.join(', ')}`, inferred: true };
      return null;
    }
    if (/^[A-Za-z_]\w*$/.test(expr)) {
      const am = new RegExp(`\\b${expr}\\s*=\\s*([^\\n]+)`).exec(code);
      return am ? reloadTarget(am[1].replace(/\s+--.*$/, '').trim(), code, depth + 1) : null;
    }
    return null;
  }

  /** Bytes that differ from what PICO-8 loads for an empty cart. */
  function usedMask(rom) {
    const m = new Uint8Array(ROM_SIZE);
    for (let i = 0; i < ROM_SIZE; i++) m[i] = rom[i] !== DEFAULT_ROM[i] ? 1 : 0;
    return m;
  }

  return { ROM_SIZE, REGIONS, DEFAULT_ROM, defaultRom, splitSections, parseNum, findReloads, reloadTarget, usedMask, parseP8, writeP8, checksum, LZ_LUA, lzEncode, lzDecode };
})();

if (typeof module !== 'undefined') module.exports = P8Cart;
