// Read-only dependency snapshots. Parsing/resolution reuse the Suite lexer and Audit model.
'use strict';
const P8MinifierProject = (() => {
  const K = typeof P8Code !== 'undefined' ? P8Code : require('./code-core.js');
  const A = typeof P8Audit !== 'undefined' ? P8Audit : require('./audit-core.js');
  const C = typeof P8MinifierCore !== 'undefined' ? P8MinifierCore : require('./minifier-core.js');
  const freeze = (value) => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  async function resolve(raw, { names = [], read, live = () => true } = {}) {
    const source = C.sourceSnapshot(raw), files = new Map(source.files.map((f) => [f.path, f.text]));
    const index = new Map(), notes = [], edges = [], active = [];
    const fail = (code, message, file, line) => { throw C.error(code, message, [{ severity: 'error', code, message, ...(file ? { file } : {}), ...(line ? { line } : {}) }]); };
    const check = () => { if (!live()) fail('E_STALE', 'Code Editor or input changed while reading includes. Choose Minify again.'); };
    for (const name of new Set([...names, ...files.keys()])) {
      const key = name.toLowerCase(); if (!index.has(key)) index.set(key, []); index.get(key).push(name);
    }
    const exists = A.makeFs(new Map([...index.values()].flat().map((name) => [name, null])));
    async function visit(path, tab = null) {
      check();
      if ((index.get(path.toLowerCase()) || []).length > 1) fail('E_INCLUDE_AMBIGUOUS', `Ambiguous source path: ${path}`, path);
      const id = path + (tab === null ? '' : ':' + tab), chain = [...active, id].join(' → ');
      if (active.includes(id)) fail('E_INCLUDE_CYCLE', `Include cycle: ${chain}`, path);
      if (active.some((p) => p.split(':')[0] === path)) fail('E_INCLUDE_SEMANTICS', `Shrinko8 preprocesses whole carts before selecting tabs; recursive tab source is unsafe: ${chain}`, path);
      if (active.length >= 50 || edges.length >= 1000) fail('E_INCLUDE_LIMIT', `Include expansion limit reached: ${chain}`, path);
      if (!files.has(path)) {
        let text;
        try { text = await read?.(path); } catch (err) { if (err.code === 'E_STALE') throw err; fail('E_INCLUDE_READ', `Cannot read ${path}: ${chain}. Reconnect the source folder in Code Editor and retry.`, path); }
        check();
        if (typeof text !== 'string') fail('E_INCLUDE_READ', `Cannot read include: ${chain}. Open its folder in Code Editor and retry.`, path);
        files.set(path, text);
      }
      const text = files.get(path), kind = C.inputKind(path);
      let prepared;
      try { prepared = C.prepareInput({ kind, entryPath: path, files: [{ path, text }] }); }
      catch (err) { if (err.code !== 'E_EMPTY' || path === source.entryPath) throw err; prepared = { lua: kind === 'p8' ? K.splitCart(text).lua : text }; }
      const whole = kind === 'p8' ? prepared.lua : text;
      if (tab !== null && (kind !== 'p8' || tab > 9 || !/^\d$/.test(String(tab)) || tab >= whole.split(/^-->8[ \t]*$/m).length)) fail('E_INCLUDE_TAB', `Unsupported or missing code tab: ${chain}. Supported tab numbers are 0–9.`, path);
      if (tab !== null && (K.includes(whole).length || whole.split('\n').some((l) => /^-->8/.test(l) && l !== '-->8') || whole.startsWith('-->8') || whole.endsWith('-->8') || /\n-->8\n-->8\n/.test(whole))) fail('E_INCLUDE_SEMANTICS', `Tab boundaries or includes in ${path} differ between Suite and pinned Shrinko8. Use a separate .lua dependency: ${chain}`, path);
      const lua = tab === null ? whole : K.includedCode(text, path, tab), tokens = K.lex(lua), includes = K.includes(lua, tokens);
      for (const tk of tokens) {
        const body = lua.slice(tk.s, tk.e), line = lua.slice(0, tk.s).split('\n').length;
        if (tk.t === 'comment' && /^--(?:\[(=*)\[)?\s*[@$]/.test(body)) {
          if (/^--(?:\[(=*)\[)?\s*\$/.test(body)) fail('E_TRANSFORM_UNSUPPORTED', `Compiler/preprocessor hint is unsupported at ${path}:${line}.`, path, line);
          notes.push({ severity: 'warning', code: 'W_BUILD_DIRECTIVE', message: `Source-only project directive at ${path}:${line}; generated output is a build copy and may remove it. Keep the original project source.`, file: path, line });
        }
        if ((body === '#' || tk.t === 'include') && !lua.slice(lua.lastIndexOf('\n', tk.s - 1) + 1, tk.s).trim() && /^#[A-Za-z_]/.test(lua.slice(tk.s)) && !includes.some((inc) => inc.s === tk.s)) fail('E_DIRECTIVE_UNSUPPORTED', `Unsupported preprocessor directive at ${path}:${line}.`, path, line);
      }
      active.push(id);
      for (const inc of includes) {
        const line = inc.line + 1, written = lua.slice(inc.s + '#include'.length, inc.e).trim();
        if (written !== inc.raw || /[\\\x00-\x1f"']/.test(inc.path) || inc.path.startsWith('/') || inc.path.includes(':') || !/\.(lua|p8)$/i.test(inc.path)) fail('E_INCLUDE_PATH', `Unsupported include path “${written}” at ${path}:${line}. Use an unquoted relative .lua/.p8 path with forward slashes. Chain: ${chain}`, path, line);
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        const exact = A.normPath(dir ? dir + '/' + inc.path : inc.path);
        if (exact === '..' || exact.startsWith('../')) fail('E_INCLUDE_PATH', `Include escapes the authorized folder: ${chain} → ${inc.raw}`, path, line);
        const matches = index.get(exact.toLowerCase()) || [];
        if (matches.length > 1) fail('E_INCLUDE_AMBIGUOUS', `Ambiguous include ${inc.raw}: ${matches.join(', ')}. Chain: ${chain}`, path, line);
        const target = A.resolveInclude(exists, dir, inc.path);
        if (!target) fail('E_INCLUDE_MISSING', `Missing include: ${chain} → ${inc.raw}. Open its project folder in Code Editor, then retry.`, path, line);
        if (target !== exact) fail('E_INCLUDE_SEMANTICS', `Suite resolves ${inc.raw} to ${target}, but Shrinko8 requires the exact relative path ${exact}. Chain: ${chain}`, path, line);
        edges.push({ from: path, line, target, tab: inc.tab });
        await visit(target, inc.tab);
      }
      active.pop();
    }
    await visit(source.entryPath); check();
    return freeze({ source: C.sourceSnapshot({ ...source, files: [...files].map(([path, text]) => ({ path, text })) }), edges, diagnostics: notes, buildCopy: edges.length > 0 || notes.length > 0 });
  }
  return { resolve };
})();
if (typeof module !== 'undefined') module.exports = P8MinifierProject;
