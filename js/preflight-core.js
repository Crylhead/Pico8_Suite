// js/preflight-core.js
// Cart Packer preflight and workflow stages (UX issue #66). Presentation only: this module builds the
// list the user confirms from the plan project.js already computed (js/project-core.js does the real
// work: validation, retirement analysis, transactions, journaling, recovery). It adds no new write
// path and changes no algorithm (#40-#44). No DOM; tests/preflight.test.js runs it in Node.

'use strict';

const P8Preflight = (() => {
  /**
   * input: {
   *   mode: 'write' | 'adopt',
   *   prefix: 'demo/' | '' (location of the carts relative to the project folder),
   *   onDisk: Set<lowercase cart name> (carts present in the demo folder now),
   *   carts: [{ name, parts }],              // data carts this write builds
   *   rewrites: [{ name, changes }],         // fx carts whose --@data reload() lines change (changes = number)
   *   assets: [{ name, exists }],            // assets/*.json written
   *   removedAssets: [name],                 // assets/*.json files removed by a rename
   *   manifestExists: boolean,               // demo/suite.json
   *   retire: [name], kept: [{cart, by}], unresolved: [{file, line, call, why}]
   * }
   */
  function build(i) {
    const p = i.prefix || '';
    const files = [];
    for (const c of i.carts || []) {
      const exists = i.onDisk.has(c.name.toLowerCase());
      files.push({ path: `${p}${c.name}`, action: exists ? 'change' : 'add', why: `data cart, ${c.parts} part${c.parts === 1 ? '' : 's'}` });
    }
    for (const r of i.rewrites || []) {
      files.push({ path: `${p}${r.name}`, action: 'change', why: `${r.changes} --@data anchor line${r.changes === 1 ? '' : 's'} rewritten${r.changes === 0 ? ' (renamed anchors)' : ''}` });
    }
    for (const a of i.assets || []) files.push({ path: `assets/${a.name}.json`, action: a.exists ? 'change' : 'add', why: 'asset' });
    for (const n of i.removedAssets || []) files.push({ path: `assets/${n}.json`, action: 'remove', why: 'asset renamed: the file under the old name is removed' });
    files.push({ path: `${p}suite.json`, action: i.manifestExists ? 'change' : 'add', why: 'project manifest' });
    for (const n of i.retire || []) files.push({ path: `${p}${n}`, action: 'retire', why: `moved to ${p}unused/${n}; nothing references it any more` });

    const count = (a) => files.filter((f) => f.action === a).length;
    const counts = { add: count('add'), change: count('change'), retire: count('retire'), remove: count('remove') };
    const writes = counts.add + counts.change + counts.remove; // files whose content is created, replaced or deleted
    const moves = counts.retire;
    const warnings = [];
    if ((i.unresolved || []).length) warnings.push(`${i.unresolved.length} reference${i.unresolved.length === 1 ? '' : 's'} cannot be resolved, so no cart is moved.`);
    if ((i.kept || []).length) warnings.push(`${i.kept.length} old cart${i.kept.length === 1 ? '' : 's'} stay${i.kept.length === 1 ? 's' : ''} in place because ${i.kept.length === 1 ? 'it is' : 'they are'} still referenced.`);
    return {
      mode: i.mode || 'write', files, counts, writes, moves,
      kept: i.kept || [], unresolved: i.unresolved || [], warnings,
      summary: `${counts.add} added, ${counts.change} changed${counts.remove ? `, ${counts.remove} removed` : ''}, ${counts.retire} moved to unused/`,
      confirmLabel: `Write ${writes + moves} file${writes + moves === 1 ? '' : 's'}`,
    };
  }

  /**
   * Workflow strip: Analyze (read-only) -> Plan -> Validate -> Commit. status: 'done' | 'current' | 'todo' | 'blocked'.
   * state: { open, hasProject, partCount, unplaced, errors, warnings, needsWrite, lastWrite }
   * "Commit" is only 'done' after a verified write and while nothing changed since.
   */
  function stages(s) {
    const analyze = !s.open ? { status: 'todo', detail: 'Open Project Folder… (a folder with demo/ or main.p8). Reading is analysis only: nothing is written.' }
      : !s.hasProject ? { status: 'current', detail: 'Folder read (read-only). Adopting it writes anchors and assets: you see every file first.' }
        : { status: 'done', detail: `Project read: ${s.partCount} part${s.partCount === 1 ? '' : 's'}. Read-only.` };
    const plan = !s.hasProject ? { status: 'todo', detail: 'Arrange the parts into data carts (buttons, drag or Auto-pack).' }
      : s.unplaced ? { status: 'current', detail: `${s.unplaced} part${s.unplaced === 1 ? '' : 's'} not placed yet. Use Move… or Auto-pack.` }
        : { status: 'done', detail: 'Every part is in a cart. Nothing is written yet.' };
    const validate = !s.hasProject || s.unplaced ? { status: 'todo', detail: 'Checks run on the arranged plan.' }
      : s.errors ? { status: 'blocked', detail: `${s.errors} error${s.errors === 1 ? '' : 's'} to fix before writing (see the report below).` }
        : { status: 'done', detail: s.warnings ? `No errors, ${s.warnings} warning${s.warnings === 1 ? '' : 's'}. Write Carts shows the exact files before anything is written.` : 'No errors. Write Carts shows the exact files before anything is written.' };
    const commit = !s.hasProject || s.unplaced || s.errors ? { status: 'todo', detail: 'Write Carts: preview, confirm, then a verified write.' }
      : s.needsWrite ? { status: 'current', detail: 'Unwritten changes. Press Write Carts to preview the files.' }
        : s.lastWrite ? { status: 'done', detail: `Written and verified: ${s.lastWrite}.` }
          : { status: 'done', detail: 'Matches the files on disk.' };
    return [
      { id: 'analyze', label: 'Analyze', ...analyze },
      { id: 'plan', label: 'Plan', ...plan },
      { id: 'validate', label: 'Validate', ...validate },
      { id: 'commit', label: 'Commit', ...commit },
    ];
  }

  return { build, stages };
})();

if (typeof module !== 'undefined') module.exports = P8Preflight;
