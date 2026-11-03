const Core = require('../js/minifier-core.js');
exports.source = (text = 'cls()', entryPath = 'demo.lua') => ({ kind: 'lua', entryPath, files: [{ path: entryPath, text }] });
exports.engine = () => ({ shrinko8Version: '1.2.7f', shrinko8Commit: 'fixture-pin', pyodideVersion: '314.0.7', pythonVersion: '3.14.2',
  capabilities: { lua: true, p8: true, png: false, includes: false, profiles: ['minimal'], targets: ['tokens'] } });
exports.result = (before = 4, after = 3) => ({ ok: true, lua: 'cls()', cartText: null, flags: [...Core.FLAGS], diagnostics: [],
  metrics: { original: { tokens: before, characters: 8, compressedBytes: null, compressedReason: 'Not emitted by engine.' }, optimized: { tokens: after, characters: 5, compressedBytes: 12 } } });
