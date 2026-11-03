// Validated derived artifacts. Never writes files, changes editor state or runs source.
'use strict';
const P8MinifierExport = (() => {
  const C = typeof P8MinifierCore !== 'undefined' ? P8MinifierCore : require('./minifier-core.js');
  const K = typeof P8Code !== 'undefined' ? P8Code : require('./code-core.js');
  const normalized = (text) => text.replace(/\r\n?/g, '\n');
  const codeBody = (text) => normalized(text).replace(/\n$/, '');
  const fail = (message, code = 'E_EXPORT_INVALID') => { throw C.error(code, message); };
  const sameFiles = (a, b) => a.length === b.length && a.every((f, i) => f.path === b[i].path && f.text === b[i].text);
  function luaText(text) {
    if (typeof text !== 'string' || text.includes('\0') || [...text].some((c) => c.codePointAt(0) >= 0xd800 && c.codePointAt(0) <= 0xdfff)) fail('Generated Lua is not valid UTF-8 source text.');
    const tokens = K.lex(text);
    if (K.includes(text, tokens).length) fail('Generated Lua still contains unresolved #include directives.');
    for (const token of tokens) {
      if (token.t === 'error') fail('Generated Lua contains an invalid token or unterminated literal.');
      if (text[token.s] === '#' && !text.slice(text.lastIndexOf('\n', token.s - 1) + 1, token.s).trim() && /^#[A-Za-z_]/.test(text.slice(token.s))) fail('Generated Lua contains an unsupported preprocessor directive.');
    }
    return text;
  }
  function cartInput(text) {
    return C.prepareInput({ kind: 'p8', entryPath: 'verify.p8', files: [{ path: 'verify.p8', text }] }, { allowEmpty: true });
  }
  function sameRom(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]); }
  function verifyCart(original, candidate, lua) {
    const before = cartInput(original), after = cartInput(candidate);
    if (before.original.cart.header !== after.original.cart.header || before.original.cart.nonLua !== after.original.cart.nonLua) fail('Cartridge header or non-Lua sections changed. Download is blocked; keep the original cartridge.', 'E_EXPORT_PRESERVATION');
    if (after.lua !== codeBody(lua)) fail('Cartridge Lua does not match the optimized result.', 'E_EXPORT_PRESERVATION');
    // Independent of Code.splitCart/intake: the Suite's ROM codec decodes gfx/map/flags/music/SFX.
    const Cart = typeof P8Cart !== 'undefined' ? P8Cart : require('./cart-core.js');
    const a = Cart.parseP8(original), b = Cart.parseP8(candidate);
    if (a.version !== b.version || !sameRom(a.rom, b.rom) || JSON.stringify(a.label) !== JSON.stringify(b.label) || JSON.stringify([...a.present]) !== JSON.stringify([...b.present])) fail('Independent cartridge validation found changed assets or version.', 'E_EXPORT_PRESERVATION');
    return candidate;
  }
  function build(state, input) {
    if (!C.canExport(state)) fail('A current successful result is required. Optimize the current source again.', 'E_EXPORT_STALE');
    const result = state.result, job = result.job;
    if (!input || input.sourceRevision !== state.sourceRevision || input.source.entryPath !== job.entryPath || input.source.kind !== job.kind || !sameFiles(input.source.files, job.files) || !sameFiles(state.source.files, job.files)) fail('Result and original source snapshot do not match. Optimize again.', 'E_EXPORT_SOURCE');
    const original = C.prepareInput(state.source);
    if (input.original.text !== original.original.text) fail('The retained original source does not match this job.', 'E_EXPORT_SOURCE');
    const lua = luaText(result.lua), warnings = [];
    for (const file of job.files) {
      const code = file.path.toLowerCase().endsWith('.p8') ? K.splitCart(file.text).lua : file.text;
      if (K.lex(code).some((t) => t.t === 'comment' && /(?:@data\b|\b(?:keep|preserve)(?:[-:]|\b)|^--\s*@)/.test(code.slice(t.s, t.e)))) warnings.push(`Source-only directives or keep/preserve hints in ${file.path} may be removed or changed. Keep the original editable project.`);
    }
    let cart = null;
    if (job.kind === 'p8') {
      // The engine serializes assets canonically. Check its decoded ROM, then carry only its Lua
      // into the untouched original envelope so empty/unknown sections and CRLF survive exactly.
      if (typeof result.cartText !== 'string') fail('The engine returned no complete cartridge.');
      const engineInput = cartInput(result.cartText);
      if (engineInput.lua !== codeBody(lua)) fail('Engine cartridge and optimized Lua disagree.', 'E_EXPORT_PRESERVATION');
      const Cart = typeof P8Cart !== 'undefined' ? P8Cart : require('./cart-core.js');
      const a = Cart.parseP8(original.original.text), b = Cart.parseP8(result.cartText);
      if (a.version !== b.version || !sameRom(a.rom, b.rom)) fail('The engine changed cartridge assets or version. Export is blocked.', 'E_EXPORT_PRESERVATION');
      const { header, nonLua } = original.original.cart;
      const newline = header.endsWith('\r\n') ? '\r\n' : header.endsWith('\r') ? '\r' : '\n';
      let body = normalized(lua); if (body && !body.endsWith('\n')) body += '\n';
      const text = verifyCart(original.original.text, header + body.replace(/\n/g, newline) + nonLua, lua);
      cart = Object.freeze({ text, filename: C.outputFilename(job.entryPath, 'p8'), type: 'text/plain;charset=utf-8' });
    }
    return Object.freeze({ lua: Object.freeze({ text: lua, filename: C.outputFilename(job.entryPath, 'lua'), type: 'text/plain;charset=utf-8' }), cart, warnings: Object.freeze(warnings), buildCopy: true });
  }
  function inspect(state, input) {
    try { return Object.freeze({ ok: true, artifacts: build(state, input) }); }
    catch (err) { return Object.freeze({ ok: false, code: err.code || 'E_EXPORT_INVALID', reason: err.code ? err.message : 'Output validation failed. Optimize again before exporting.' }); }
  }
  return { build, inspect, verifyCart };
})();
if (typeof module !== 'undefined') module.exports = P8MinifierExport;
