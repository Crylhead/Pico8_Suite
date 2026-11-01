// js/code-core.js
// Code Editor model: a PICO-8 Lua lexer (PICO-8's extra operators, number formats and
// shorthands), the API with signatures, code tabs (-->8), an outline of the functions, and
// reading / writing the __lua__ section of a cart without touching the other sections.
// No DOM; runs in Node for tests.

'use strict';

const P8Code = (() => {
  const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
  const CONSTANTS = new Set(['true', 'false', 'nil']);
  const CALLBACKS = new Set(['_init', '_update', '_update60', '_draw']);

  /** PICO-8 API (0.2.x): name -> signature ([optional] arguments) and a short description. */
  const API = {};
  const def = (group, list) => {
    for (const [sig, doc] of list) {
      const name = sig.slice(0, sig.indexOf('('));
      API[name] = { sig, doc, group };
    }
  };
  def('graphics', [
    ['camera([x,] [y])', 'offset all drawing'], ['circ(x, y, [r,] [col])', 'circle outline'], ['circfill(x, y, [r,] [col])', 'filled circle'],
    ['clip([x, y, w, h,] [clip_previous])', 'clipping rectangle'], ['cls([col])', 'clear the screen'], ['color([col])', 'draw color'],
    ['cursor([x,] [y,] [col])', 'print cursor'], ['fget(n, [f])', 'sprite flags'], ['fillp([p])', 'fill pattern (+0x0.8 transparent, +0x0.4 secondary palette)'],
    ['fset(n, [f,] v)', 'set sprite flags'], ['line(x0, y0, [x1, y1,] [col])', 'line'], ['oval(x0, y0, x1, y1, [col])', 'ellipse outline'],
    ['ovalfill(x0, y0, x1, y1, [col])', 'filled ellipse'], ['pal(c0, c1, [p])', 'remap colors (p: 0 draw, 1 screen, 2 secondary)'],
    ['palt(c, [t])', 'transparency'], ['pget(x, y)', 'pixel color'], ['print(str, [x, y,] [col])', 'print text'], ['pset(x, y, [col])', 'set pixel'],
    ['rect(x0, y0, x1, y1, [col])', 'rectangle outline'], ['rectfill(x0, y0, x1, y1, [col])', 'filled rectangle'], ['sget(x, y)', 'sprite sheet pixel'],
    ['spr(n, x, y, [w, h,] [flip_x,] [flip_y])', 'draw sprite'], ['sset(x, y, [col])', 'set sprite sheet pixel'],
    ['sspr(sx, sy, sw, sh, dx, dy, [dw, dh,] [flip_x,] [flip_y])', 'stretch sprite sheet area'],
    ['tline(x0, y0, x1, y1, mx, my, [mdx, mdy,] [layers])', 'textured line from the map'],
  ]);
  def('tables', [
    ['add(tbl, val, [i])', 'append (or insert at i)'], ['all(tbl)', 'iterator over values'], ['count(tbl, [val])', 'number of items'],
    ['del(tbl, val)', 'remove first val'], ['deli(tbl, [i])', 'remove item i'], ['foreach(tbl, f)', 'call f for each value'],
    ['ipairs(tbl)', 'index iterator'], ['pairs(tbl)', 'key iterator'], ['pack(...)', 'arguments to a table'], ['unpack(tbl, [i,] [j])', 'table to values'],
    ['next(tbl, [key])', 'next key'], ['select(i, ...)', 'arguments from i'], ['rawget(tbl, key)', 'get without metamethods'],
    ['rawset(tbl, key, val)', 'set without metamethods'], ['rawequal(a, b)', 'compare without metamethods'], ['rawlen(tbl)', 'length without metamethods'],
    ['setmetatable(tbl, m)', 'set metatable'], ['getmetatable(tbl)', 'get metatable'], ['inext(tbl, i)', 'ipairs step'],
  ]);
  def('input', [['btn([b,] [pl])', 'button held'], ['btnp([b,] [pl])', 'button pressed (with repeat)']]);
  def('sound', [['sfx(n, [channel,] [offset,] [length])', 'play sound effect'], ['music(n, [fade_len,] [channel_mask])', 'play music']]);
  def('map', [
    ['map(tile_x, tile_y, [sx, sy,] [tile_w, tile_h,] [layers])', 'draw the map'], ['mget(x, y)', 'map cell'], ['mset(x, y, v)', 'set map cell'],
  ]);
  def('memory', [
    ['peek(addr, [n])', 'read bytes'], ['poke(addr, [value, ...])', 'write bytes'], ['peek2(addr, [n])', 'read 16-bit'], ['poke2(addr, [value, ...])', 'write 16-bit'],
    ['peek4(addr, [n])', 'read 32-bit fixed point'], ['poke4(addr, [value, ...])', 'write 32-bit fixed point'], ['memcpy(dest, src, len)', 'copy memory'],
    ['memset(dest, val, len)', 'fill memory'], ['reload(dest, src, len, [filename])', 'copy cart rom to memory'], ['cstore(dest, src, len, [filename])', 'copy memory to cart rom'],
    ['serial(channel, address, length)', 'serial i/o'],
  ]);
  def('math', [
    ['abs(x)', 'absolute value'], ['atan2(dx, dy)', 'angle 0..1'], ['band(a, b)', 'bitwise and'], ['bor(a, b)', 'bitwise or'], ['bxor(a, b)', 'bitwise xor'],
    ['bnot(a)', 'bitwise not'], ['shl(a, n)', 'shift left'], ['shr(a, n)', 'arithmetic shift right'], ['lshr(a, n)', 'logical shift right'],
    ['rotl(a, n)', 'rotate left'], ['rotr(a, n)', 'rotate right'], ['ceil(x)', 'round up'], ['cos(x)', 'cosine (x in turns)'], ['flr(x)', 'round down'],
    ['max(x, y)', 'larger'], ['mid(x, y, z)', 'middle value (clamp)'], ['min(x, y)', 'smaller'], ['rnd([x])', 'random 0..x (or item of a table)'],
    ['sgn(x)', 'sign'], ['sin(x)', 'sine (x in turns, inverted y)'], ['sqrt(x)', 'square root'], ['srand(x)', 'random seed'],
  ]);
  def('strings', [
    ['tostr(val, [format_flags])', 'to string (flags: 1 hex, 2 raw)'], ['tonum(val, [format_flags])', 'to number'], ['chr(val, ...)', 'P8SCII characters'],
    ['ord(str, [index,] [num_results])', 'P8SCII codes'], ['sub(str, pos0, [pos1])', 'substring'], ['split(str, [separator,] [convert_numbers])', 'split to a table'],
    ['type(val)', 'type name'],
  ]);
  def('system', [
    ['cartdata(id)', 'persistent data id'], ['dget(index)', 'read persistent value'], ['dset(index, value)', 'write persistent value'],
    ['cocreate(f)', 'new coroutine'], ['coresume(c, [p0, ...])', 'run coroutine'], ['costatus(c)', 'coroutine status'], ['yield([...])', 'pause coroutine'],
    ['load(filename, [breadcrumb,] [param])', 'load and run a cart'], ['run([param])', 'restart'], ['stop([message])', 'stop'], ['resume()', 'resume'],
    ['reboot()', 'reboot'], ['extcmd(cmd, ...)', 'system command'], ['menuitem(index, [label,] [callback])', 'pause menu item'], ['stat(x)', 'system status'],
    ['time()', 'seconds since start'], ['t()', 'seconds since start'], ['printh(str, [filename,] [overwrite])', 'print to the host console'],
    ['assert(condition, [message])', 'stop when false'], ['flip()', 'show the frame'], ['trace()', 'stack trace'],
    ['setmetatable(tbl, m)', 'set metatable'], ['error(message)', 'raise an error'], ['pcall(f, ...)', 'protected call'],
  ]);
  for (const [name, doc] of [['_init', 'called once at start'], ['_update', 'called 30 times a second'], ['_update60', 'called 60 times a second'], ['_draw', 'called every frame']]) {
    API[name] = { sig: `${name}()`, doc, group: 'callbacks' };
  }
  const API_NAMES = Object.keys(API).sort();

  // ------------------------------------------------------------------ //
  // Lexer                                                              //
  // ------------------------------------------------------------------ //
  //
  // Token types: comment, tabsep (-->8), string, number, keyword, constant, api, callback,
  // self, ident, op, bracket, glyph, ws, error.
  // PICO-8 additions: \ (integer division) ^^ (xor) >>> <<> >>< != += -= *= /= \= %= ^= ..= |= &=
  // ^^= <<= >>= >>>= <<>= >><=, @ % $ (peek shorthands), ? (print shorthand), 0b binary, hex
  // and binary fractions, P8SCII glyphs (emoji in .p8 text).

  const OPS = ['>>>=', '<<>=', '>><=', '...', '>>>', '<<>', '>><', '^^=', '<<=', '>>=', '..=', '==', '~=', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '\\=', '%=', '^=', '|=', '&=', '..', '^^', '<<', '>>', '::',
    '+', '-', '*', '/', '\\', '%', '^', '#', '&', '|', '~', '<', '>', '=', ';', ':', ',', '.', '@', '$', '?'];
  const BRACKETS = '()[]{}';

  /** level of a long bracket at s[i] ("[[", "[==[") or -1 */
  function longOpen(s, i) {
    if (s[i] !== '[') return -1;
    let j = i + 1;
    while (s[j] === '=') j++;
    return s[j] === '[' ? j - i - 1 : -1;
  }

  /**
   * text -> [{t: type, s: start, e: end}] (end exclusive). Never fails: unknown characters are
   * 'error' tokens, unterminated strings / comments run to the end of the line / text.
   */
  function lex(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    const push = (t, s, e) => out.push({ t, s, e });
    while (i < n) {
      const c = text[i];
      const s = i;
      // whitespace (newlines included)
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
        push('ws', s, i);
        continue;
      }
      // comments
      if (c === '-' && text[i + 1] === '-') {
        const lv = longOpen(text, i + 2);
        if (lv >= 0) {
          const close = `]${'='.repeat(lv)}]`;
          const e = text.indexOf(close, i + 4 + lv);
          i = e < 0 ? n : e + close.length;
          push('comment', s, i);
          continue;
        }
        let e = text.indexOf('\n', i);
        if (e < 0) e = n;
        const lineStart = text.lastIndexOf('\n', i - 1) + 1;
        const isTab = /^-->8\s*$/.test(text.slice(lineStart, e).replace(/\r$/, '')) && lineStart === i;
        i = e;
        push(isTab ? 'tabsep' : 'comment', s, i);
        continue;
      }
      // long strings
      const lv = longOpen(text, i);
      if (lv >= 0) {
        const close = `]${'='.repeat(lv)}]`;
        const e = text.indexOf(close, i + 2 + lv);
        i = e < 0 ? n : e + close.length;
        push('string', s, i);
        continue;
      }
      // quoted strings (escapes; an unterminated one ends at the line end)
      if (c === '"' || c === "'") {
        i++;
        while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
        if (text[i] === c) i++;
        push('string', s, Math.min(i, n));
        continue;
      }
      // numbers: 0x hex(.frac), 0b bin(.frac), decimal(.frac)(e±exp)
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        if (c === '0' && /[xX]/.test(text[i + 1] || '')) {
          i += 2;
          while (i < n && /[0-9a-fA-F.]/.test(text[i])) i++;
        } else if (c === '0' && /[bB]/.test(text[i + 1] || '')) {
          i += 2;
          while (i < n && /[01.]/.test(text[i])) i++;
        } else {
          while (i < n && /[0-9.]/.test(text[i])) {
            if (text[i] === '.' && text[i + 1] === '.') break; // 1..2 is concatenation
            i++;
          }
          if (/[eE]/.test(text[i] || '') && /[-+0-9]/.test(text[i + 1] || '')) { i += 2; while (i < n && /[0-9]/.test(text[i])) i++; }
        }
        push('number', s, i);
        continue;
      }
      // names
      if (/[A-Za-z_]/.test(c)) {
        while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
        const w = text.slice(s, i);
        // a field (a.print, a:draw) is not the global function
        let p = s - 1;
        while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p--;
        const field = p >= 0 && (text[p] === '.' && text[p - 1] !== '.' || text[p] === ':');
        const t = CONSTANTS.has(w) ? 'constant' : KEYWORDS.has(w) ? 'keyword' : w === 'self' ? 'self' : field ? 'ident' : CALLBACKS.has(w) ? 'callback' : API[w] ? 'api' : 'ident';
        push(t, s, i);
        continue;
      }
      // #include file.lua (a whole line, PICO-8 preprocessor)
      if (c === '#' && text.startsWith('#include', i) && /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i))) {
        let e = text.indexOf('\n', i);
        if (e < 0) e = n;
        i = e;
        push('include', s, i);
        continue;
      }
      if (BRACKETS.includes(c)) { i++; push('bracket', s, i); continue; }
      const op = OPS.find((o) => text.startsWith(o, i));
      if (op) { i += op.length; push('op', s, i); continue; }
      // P8SCII glyphs (emoji, with an optional variation selector) and other characters
      const cp = text.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      while (i < n && /[\ufe0f\u200d]/.test(text[i])) i++;
      push(cp > 127 ? 'glyph' : 'error', s, i);
    }
    return out;
  }

  /** Partner offsets of brackets: Map(offset -> partner offset) (unmatched ones are missing). */
  function bracketPairs(tokens, text) {
    const pairs = new Map();
    const stack = [];
    const open = { ')': '(', ']': '[', '}': '{' };
    for (const tk of tokens) {
      if (tk.t !== 'bracket') continue;
      const ch = text[tk.s];
      if ('([{'.includes(ch)) stack.push(tk.s);
      else {
        const top = stack[stack.length - 1];
        if (top != null && text[top] === open[ch]) { stack.pop(); pairs.set(top, tk.s); pairs.set(tk.s, top); }
      }
    }
    return pairs;
  }

  // ------------------------------------------------------------------ //
  // Structure: code tabs, outline, block keywords                      //
  // ------------------------------------------------------------------ //

  /** Code tabs (separated by -->8 lines) -> [{index, line (first line), label}] */
  function codeTabs(text) {
    const lines = text.split('\n');
    const tabs = [{ index: 0, line: 0 }];
    lines.forEach((l, i) => { if (/^-->8\s*$/.test(l)) tabs.push({ index: tabs.length, line: i + 1 }); });
    for (const t of tabs) {
      // the first comment of a tab names it (as many carts do)
      const first = lines.slice(t.line, t.line + 3).find((l) => l.trim());
      const m = first && /^\s*--\s*(.+)$/.exec(first);
      t.label = m && !/^-->8/.test(first) ? m[1].trim().slice(0, 24) : '';
    }
    return tabs;
  }

  /** Functions: [{name, line, args, local}] in source order. */
  function outline(text) {
    const out = [];
    const lines = text.split('\n');
    const reDecl = /^\s*(local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(([^)]*)\)/;
    const reAssign = /^\s*(local\s+)?([A-Za-z_][\w.]*)\s*=\s*function\s*\(([^)]*)\)/;
    const reField = /^\s*([A-Za-z_]\w*)\s*=\s*function\s*\(([^)]*)\)/;
    let inLong = false;
    lines.forEach((l, i) => {
      // skip long comments roughly (an outline does not need a full parse)
      if (inLong) { if (l.includes(']]')) inLong = false; return; }
      if (/--\[=*\[/.test(l) && !/\]=*\]/.test(l.slice(l.search(/--\[=*\[/) + 4))) { inLong = true; return; }
      let m = reDecl.exec(l);
      if (m) { out.push({ name: m[2], line: i, args: m[3].trim(), local: Boolean(m[1]) }); return; }
      m = reAssign.exec(l) || null;
      if (m) { out.push({ name: m[2], line: i, args: m[3].trim(), local: Boolean(m[1]) }); return; }
      m = reField.exec(l);
      if (m) out.push({ name: m[1], line: i, args: m[2].trim(), local: false });
    });
    return out;
  }

  /**
   * #include lines -> [{line, path, tab}]: path as written (relative to the including cart's
   * folder), tab = the code tab of a .p8 ("file.p8:1") or null.
   */
  function includes(text) {
    const out = [];
    text.split('\n').forEach((l, i) => {
      const m = /^\s*#include\s+(.+?)\s*$/.exec(l);
      if (!m) return;
      const raw = m[1].replace(/^["']+|["']+$/g, '').trim();
      const t = /^(.*\.p8):(\d+)$/i.exec(raw);
      out.push({ line: i, path: t ? t[1] : raw, tab: t ? Number(t[2]) : null });
    });
    return out;
  }

  /** a/b/../c.lua -> a/c.lua (forward slashes, no leading ./) */
  function joinPath(dir, rel) {
    const parts = (dir ? `${dir}/${rel}` : rel).replace(/\\/g, '/').split('/');
    const out = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') out.pop(); else out.push(p);
    }
    return out.join('/');
  }

  /** the code an #include pulls in: a .lua file whole, a .p8 its __lua__ (or one of its tabs) */
  function includedCode(fileText, path, tab = null) {
    if (!/\.p8$/i.test(path)) return fileText.replace(/\r\n?/g, '\n');
    const lua = splitCart(fileText).lua;
    if (tab == null) return lua;
    return lua.split(/^-->8[ \t]*$/m)[tab] ?? '';
  }

  /** Names declared in the code (locals, globals, functions, parameters) for completion. */
  function identifiers(tokens, text) {
    const names = new Set();
    for (const tk of tokens) if (tk.t === 'ident') names.add(text.slice(tk.s, tk.e));
    return names;
  }

  /**
   * Indentation for the line after `line`: one level more after then / do / repeat / else /
   * function(..) / an open bracket that is not closed on the line.
   */
  function opensBlock(line) {
    const code = line.replace(/--.*$/, '').replace(/"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/g, '""').trim();
    if (!code) return false;
    if (/\b(then|do|repeat|else)$/.test(code)) return true;
    if (/\bfunction\b[^)]*\([^)]*\)$/.test(code) && !/\bend\b/.test(code.slice(code.lastIndexOf('function')))) return true;
    let depth = 0;
    for (const ch of code) { if ('({['.includes(ch)) depth++; else if (')}]'.includes(ch)) depth--; }
    if (depth > 0) return true;
    // an if / for / while / function opened and not closed on this line
    const opens = (code.match(/\b(if|for|while|function)\b/g) || []).length;
    const closes = (code.match(/\bend\b/g) || []).length;
    return opens > closes && /\b(then|do)\b|\)\s*$/.test(code) && !/\bend\b\s*$/.test(code);
  }

  /** a line that starts with one of these is outdented when typed */
  const DEDENT = /^\s*(end|else|elseif|until)\b|^\s*[)}\]]/;

  /**
   * The call around `pos`: {name, arg} (arg = index of the argument the caret is in) or null.
   * Looks back at most 400 characters, skips strings.
   */
  function callAt(text, pos) {
    let depth = 0;
    let arg = 0;
    const from = Math.max(0, pos - 400);
    for (let i = pos - 1; i >= from; i--) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        // skip back over the string
        let j = i - 1;
        while (j >= from && !(text[j] === ch && text[j - 1] !== '\\')) j--;
        i = j;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') depth++;
      else if (ch === '(' || ch === '[' || ch === '{') {
        if (depth === 0) {
          if (ch !== '(') return null;
          const m = /([A-Za-z_][\w.:]*)\s*$/.exec(text.slice(Math.max(0, i - 60), i));
          return m ? { name: m[1], arg, open: i } : null;
        }
        depth--;
      } else if (ch === ',' && depth === 0) arg++;
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // Carts: the __lua__ section in, the cart back out                   //
  // ------------------------------------------------------------------ //

  /**
   * .p8 text -> {head, lua, tail, crlf, sections: [names after __lua__]}: head ends with the
   * __lua__ line, tail starts with the next section marker. A text without __lua__ (a .lua
   * file) is all code.
   */
  function splitCart(text) {
    const crlf = /\r\n/.test(text);
    const t = text.replace(/\r\n?/g, '\n');
    const m = /^__lua__[ \t]*$/m.exec(t);
    if (!m) return { head: null, lua: t, tail: '', crlf, sections: [] };
    const start = m.index + m[0].length + 1;
    const rest = t.slice(start);
    const next = /^__[a-z0-9_]+__[ \t]*$/m.exec(rest);
    const lua = next ? rest.slice(0, next.index) : rest;
    const tail = next ? rest.slice(next.index) : '';
    const sections = [...tail.matchAll(/^__([a-z0-9_]+)__[ \t]*$/gm)].map((x) => x[1]);
    return { head: t.slice(0, start), lua: lua.replace(/\n$/, ''), tail, crlf, sections };
  }

  /** the cart (or .lua file) with new code; the other sections stay byte for byte */
  function joinCart(parts, lua) {
    let out = parts.head == null ? lua : `${parts.head}${lua.replace(/\n*$/, '\n')}${parts.tail}`;
    if (parts.head == null && !out.endsWith('\n')) out += '\n';
    return parts.crlf ? out.replace(/\n/g, '\r\n') : out;
  }

  const NEW_CART = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n';

  return { KEYWORDS, API, API_NAMES, CALLBACKS, lex, bracketPairs, codeTabs, outline, includes, joinPath, includedCode, identifiers, opensBlock, DEDENT, callAt, splitCart, joinCart, NEW_CART };
})();

if (typeof module !== 'undefined') module.exports = P8Code;
