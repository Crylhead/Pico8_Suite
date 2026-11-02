// Documentation / help / tour drift checks (UX issue #69). Pure: takes data, returns actionable
// messages, so tests/docs-integrity.test.js can also run it on a deliberately broken fixture.
//
// Rules (each message says what to change):
//  1. every workspace tab has exactly one tool topic in the help registry (EXCEPTIONS documents none by default)
//  2. topic ids and control/action ids are unique; related/legacy references resolve
//  3. every data-help-id in index.html resolves to help text
//  4. every tour step is valid; helpId resolves; a static id must exist in index.html; a target that is not in
//     index.html (built by JS) or is hidden by default must declare `conditional` or `optional`
//  5. every keyboard shortcut shown on a menu item is documented in the help registry or the F1 reference
'use strict';

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '').replace(/↑/g, 'up').replace(/↓/g, 'down');

function tagOf(html, id) {
  const m = new RegExp(`<[a-z0-9]+\\b[^>]*\\sid="${id}"[^>]*>`, 'i').exec(html);
  return m ? m[0] : null;
}

/**
 * input: { html, topics, controlLookup(id), tours, workspaces[], exceptions: { ws: reason } }
 * returns string[] (empty = ok)
 */
function check({ html, topics, controlLookup, tours, workspaces, exceptions = {} }) {
  const errors = [];

  // 1
  for (const ws of workspaces) {
    const found = topics.filter((t) => t.kind === 'tool' && t.ws === ws);
    if (exceptions[ws]) continue;
    if (!found.length) errors.push(`Workspace "${ws}" has no help topic. Add a { kind: 'tool', ws: '${ws}' } topic to js/help-data.js (or document an exception).`);
    if (found.length > 1) errors.push(`Workspace "${ws}" has ${found.length} help topics (${found.map((t) => t.id).join(', ')}); keep exactly one.`);
  }

  // 2
  const topicIds = new Set();
  const controlIds = new Map();
  for (const t of topics) {
    if (topicIds.has(t.id)) errors.push(`Duplicate help topic id "${t.id}" in js/help-data.js.`);
    topicIds.add(t.id);
    for (const c of [...(t.controls || []), ...(t.actions || [])]) {
      if (controlIds.has(c.id)) errors.push(`Control/action id "${c.id}" is used in topics "${controlIds.get(c.id)}" and "${t.id}"; ids must be unique.`);
      controlIds.set(c.id, t.id);
    }
  }
  const docIds = new Set([...html.slice(Math.max(0, html.indexOf('id="docsTemplate"'))).matchAll(/<h3 id="(doc-[\w-]+)"/g)].map((m) => m[1]));
  for (const t of topics) {
    for (const r of t.related || []) if (!topicIds.has(r)) errors.push(`Topic "${t.id}" lists related topic "${r}" which does not exist.`);
    if (t.legacy && !docIds.has(t.legacy)) errors.push(`Topic "${t.id}" links to F1 section "${t.legacy}" which is missing in index.html (#docsTemplate).`);
  }

  // 3
  for (const m of html.matchAll(/data-help-id="([^"]+)"/g)) {
    if (!controlLookup(m[1])) errors.push(`index.html marks data-help-id="${m[1]}" but the help registry has no control or action with that id.`);
  }

  // 4
  const seenTours = new Set();
  for (const tour of tours) {
    if (seenTours.has(tour.id)) errors.push(`Duplicate tour id "${tour.id}".`);
    seenTours.add(tour.id);
    if (!Number.isInteger(tour.major) || tour.major < 1) errors.push(`Tour "${tour.id}" needs a positive integer major version.`);
    const stepIds = new Set();
    for (const s of tour.steps || []) {
      const where = `Tour "${tour.id}" step "${s.id}"`;
      if (stepIds.has(s.id)) errors.push(`${where}: duplicate step id.`);
      stepIds.add(s.id);
      if (s.helpId && !controlLookup(s.helpId)) errors.push(`${where}: helpId "${s.helpId}" is not in the help registry.`);
      if (!s.text && !s.helpId) errors.push(`${where}: needs text or helpId.`);
      if (s.before && s.before.ws && !workspaces.includes(s.before.ws)) errors.push(`${where}: before.ws "${s.before.ws}" is not a workspace.`);
      if (!s.target) continue;
      if (/nth-child|nth-of-type/.test(s.target)) errors.push(`${where}: brittle selector "${s.target}"; use an id, class or data-help-id.`);
      const declared = !!(s.conditional || s.optional || (s.before && (s.before.ws || s.before.click)));
      let dynamic = false;
      let hidden = false;
      for (const m of s.target.matchAll(/#([\w-]+)/g)) {
        const tag = tagOf(html, m[1]);
        if (!tag) { dynamic = true; errors.push(`${where}: target #${m[1]} does not exist in index.html.`); } else if (/\shidden(\s|>|=)/.test(tag)) hidden = true;
      }
      const withoutAttrs = s.target.replace(/\[[^\]]*\]/g, '');
      for (const m of withoutAttrs.matchAll(/\.([\w-]+)/g)) {
        if (!new RegExp(`class="[^"]*\\b${m[1]}\\b`).test(html)) dynamic = true; // built by JS
      }
      for (const m of s.target.matchAll(/data-help-id="([^"]+)"/g)) {
        if (!html.includes(`data-help-id="${m[1]}"`)) errors.push(`${where}: target data-help-id="${m[1]}" is not in index.html.`);
      }
      if ((dynamic || hidden) && !declared) {
        errors.push(`${where}: target "${s.target}" is ${hidden ? 'hidden by default' : 'created by JavaScript'}; declare "optional: true" or "conditional: true" (or a before step) so it cannot go dead silently.`);
      }
    }
  }

  // 5
  const reference = norm(html.slice(Math.max(0, html.indexOf('id="docsTemplate"'))).replace(/<[^>]+>/g, ' '))
    + norm(topics.flatMap((t) => (t.shortcuts || []).map((s) => s[0])).join(' '));
  const kbds = new Map();
  for (const m of html.slice(0, html.indexOf('id="docsTemplate"')).matchAll(/<button[^>]*role="menuitem"[^>]*>([^<]*)<kbd>([^<]+)<\/kbd>/g)) {
    kbds.set(norm(m[2]), `${m[1].trim()} (${m[2]})`);
  }
  for (const [key, label] of kbds) {
    const parts = key.split(/\/|,/).filter(Boolean);
    if (!parts.every((p) => reference.includes(p) || reference.includes(p.replace(/ctrl\+?/g, 'ctrl+').replace(/\+/g, '')))) {
      errors.push(`Menu shortcut "${label}" is not documented. Add it to a topic's shortcuts in js/help-data.js or to the F1 keyboard section.`);
    }
  }
  return errors;
}

module.exports = { check };
