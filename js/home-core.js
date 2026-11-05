// js/home-core.js
// Home launcher model (UX issue #68). No DOM; tests/home.test.js runs it in Node. js/suite.js renders it.
//
// - Task shortcuts are not a second list of tools: each registered tool may declare
//   `tasks: [{ group: 'create'|'edit'|'import'|'analyze', label, hint?, open?: { click } }]` in
//   Suite.registerTool, and Home groups whatever is registered.
// - Project continuation never opens a folder by itself. It reads the optional project context (#55):
//   a remembered folder is offered only as "Reconnect" (the user's click is the permission request),
//   and a denied, revoked or missing folder says what to do next.
// - Browser-only state (Library, tool sessions) and folder-backed state (real files) are named as such.

'use strict';

const P8Home = (() => {
  const GROUPS = Object.freeze([
    { id: 'create', label: 'Create', hint: 'Start something new' },
    { id: 'edit', label: 'Edit', hint: 'Work on code or a project' },
    { id: 'import', label: 'Import', hint: 'Bring in images, folders or a backup' },
    { id: 'analyze', label: 'Analyze', hint: 'Look inside a project' },
  ]);
  const FALLBACK_GROUP = 'edit';
  const known = new Set(GROUPS.map((g) => g.id));

  /** tasks of every registered tool grouped in GROUPS order; a tool without tasks is simply not listed here (its card is) */
  function taskGroups(tools) {
    const all = [];
    for (const t of tools) {
      for (const k of t.tasks || []) {
        if (!k || !k.label) continue;
        all.push({ group: known.has(k.group) ? k.group : FALLBACK_GROUP, label: k.label, hint: k.hint || '', ws: t.ws, tool: t.name, open: k.open || null });
      }
    }
    return GROUPS.map((g) => ({ ...g, tasks: all.filter((x) => x.group === g.id) })).filter((g) => g.tasks.length);
  }

  /** the tool the user was last in (never Home); null when it is unknown or no longer registered */
  function continueEntry(lastTool, tools) {
    if (!lastTool || lastTool === 'home') return null;
    const t = tools.find((x) => x.ws === lastTool);
    return t ? { ws: t.ws, name: t.name } : null;
  }

  /**
   * p: project context snapshot { name, source, access }, workspaces: ids that exist.
   * Returns { kind, text, label?, action? }; action 'open' (go to the tool) or 'reconnect' (ask permission on click).
   */
  function projectEntry(p, workspaces) {
    if (!p || p.access === 'none') {
      return { kind: 'none', text: 'No project folder is open. Open Project Folder… in Cart Builder makes a folder the active project; Code Editor, Project Audit and Data Carts can then use it (each also opens folders of its own). Needs Chrome or Edge. Project files stay on disk; the browser asks for permission on each visit.' };
    }
    const where = workspaces.includes(p.source) ? p.source : null;
    switch (p.access) {
      case 'granted': return { kind: 'open', label: `Continue project “${p.name}”`, text: 'Folder-backed: these are real files on your disk. Access was last available; it is checked again when you continue.', action: 'open', ws: where };
      case 'prompt': return { kind: 'reconnect', label: `Reconnect “${p.name}”`, text: 'The browser needs your permission again before this folder is used. Nothing is opened until you agree.', action: 'reconnect', ws: where };
      case 'denied': return { kind: 'blocked', text: `Access to “${p.name}” was denied or revoked. Open the project again${where ? ' in its tool' : ''} and choose the folder.`, ws: where };
      case 'stale': return { kind: 'missing', text: `The folder “${p.name}” is no longer available (moved, renamed or deleted). Choose the project folder again${where ? ' in its tool' : ''}.`, ws: where };
      default: return { kind: 'name', text: `“${p.name}” is known by name only: this browser gives no folder access. Use the folder or file picker in a tool.`, ws: where };
    }
  }

  /** where the user's work lives, and a warning when the browser cannot keep it */
  function storageNotice(mode, hasAssets) {
    if (mode === 'memory') {
      return { tone: 'warn', text: 'Browser storage is unavailable here (private mode or blocked). The Library works for this page only and is lost when you close it. Use Library → Export Library Backup or download your work.' };
    }
    // #193: one line; Back up and How storage works sit beside it on Home
    return { tone: 'info', text: `Library and tool sessions live in this browser only (not files on disk${hasAssets ? '' : '; nothing saved yet'}).` };
  }

  return { GROUPS, taskGroups, continueEntry, projectEntry, storageNotice };
})();

if (typeof module !== 'undefined') module.exports = P8Home;
