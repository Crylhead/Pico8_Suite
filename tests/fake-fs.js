// In-memory stand-in for the File System Access API (directory/file handles) with fault injection.
// Writes commit on close() like the real API's swap files; abort() discards them.
// Works in Node (module.exports) and in a browser page (window.FakeFS).
(function (root) {
  const err = (name, msg) => Object.assign(new Error(msg), { name });

  function makeFs(tree = {}) {
    const fs = { faults: [], log: [] };
    // fault(op, path) -> Error to throw, or null. ops: read, write, close, remove, mkdir
    fs.fail = (fn) => { fs.faults.push(fn); return fs; };
    fs.clearFaults = () => { fs.faults = []; };
    const check = (op, path) => {
      fs.log.push(`${op} ${path}`);
      for (const f of fs.faults) { const e = f(op, path); if (e) throw (e === true ? err('NotAllowedError', `${op} ${path} denied`) : e); }
    };

    function dir(name, path, entries) {
      const self = {
        kind: 'directory', name, entries_: entries,
        async getDirectoryHandle(n, { create = false } = {}) {
          let e = entries.get(n);
          if (!e) {
            if (!create) throw err('NotFoundError', `${path}${n}/ not found`);
            check('mkdir', `${path}${n}/`);
            e = dir(n, `${path}${n}/`, new Map());
            entries.set(n, e);
          }
          if (e.kind !== 'directory') throw err('TypeMismatchError', `${path}${n} is a file`);
          return e;
        },
        async getFileHandle(n, { create = false } = {}) {
          let e = entries.get(n);
          if (!e) {
            if (!create) throw err('NotFoundError', `${path}${n} not found`);
            check('write', `${path}${n}`);
            e = file(n, `${path}${n}`, '');
            entries.set(n, e);
          }
          if (e.kind !== 'file') throw err('TypeMismatchError', `${path}${n} is a directory`);
          return e;
        },
        async removeEntry(n) {
          if (!entries.has(n)) throw err('NotFoundError', `${path}${n} not found`);
          check('remove', `${path}${n}`);
          entries.delete(n);
        },
        async *entries() { for (const [n, e] of [...entries]) yield [n, e]; },
        async *values() { for (const e of [...entries.values()]) yield e; },
        async queryPermission() { return 'granted'; },
        async requestPermission() { return 'granted'; },
      };
      return self;
    }

    function file(name, path, data) {
      const self = {
        kind: 'file', name, data, mtime: 0,
        async getFile() {
          check('read', path);
          const d = self.data;
          return { name, lastModified: self.mtime, size: d.length, text: async () => d };
        },
        async createWritable() {
          check('write', path);
          let buf = '';
          let done = false;
          return {
            async write(d) { if (done) throw err('TypeError', 'closed'); check('write', path); buf += typeof d === 'string' ? d : String(d.data ?? d); },
            async close() { check('close', path); done = true; self.data = buf; self.mtime++; },
            async abort() { done = true; },
          };
        },
      };
      return self;
    }

    function build(name, path, obj) {
      const m = new Map();
      for (const [k, v] of Object.entries(obj)) m.set(k, typeof v === 'string' ? file(k, `${path}${k}`, v) : build(k, `${path}${k}/`, v));
      return dir(name, path, m);
    }
    fs.root = build('project', '', tree);
    /** plain snapshot {path: text} of every file */
    fs.snapshot = () => {
      const out = {};
      const walk = (d, p) => { for (const [n, e] of d.entries_) { if (e.kind === 'file') out[`${p}${n}`] = e.data; else walk(e, `${p}${n}/`); } };
      walk(fs.root, '');
      return out;
    };
    /** edits a file behind the app's back (an "external" change) */
    fs.put = (path, text) => {
      const segs = path.split('/');
      let d = fs.root;
      for (const s of segs.slice(0, -1)) { if (!d.entries_.has(s)) d.entries_.set(s, dir(s, '', new Map())); d = d.entries_.get(s); }
      const n = segs[segs.length - 1];
      const e = d.entries_.get(n);
      if (e) { e.data = text; e.mtime++; } else d.entries_.set(n, file(n, path, text));
    };
    return fs;
  }

  const api = { makeFs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FakeFS = api;
})(typeof window !== 'undefined' ? window : globalThis);
