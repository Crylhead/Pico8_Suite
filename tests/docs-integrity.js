// Documentation / help / tour drift checks (UX issue #69). Pure: takes data, returns actionable
// messages, so tests/docs-integrity.test.js can also run it on a deliberately broken fixture.
//
// Rules (each message says what to change):
//  1. every workspace tab has exactly one tool topic in the help registry (EXCEPTIONS documents none by default)
//  2. topic ids and control/action ids are unique; related/legacy references resolve
//  3. every data-help-id in index.html resolves to help text
//  4. built-in workspaces/subtools have tours with declared area coverage; every target and before.click
//     has markup/builder evidence, with optional/conditional/before for dynamic or hidden targets
//  5. every keyboard shortcut shown on a menu item is documented in the help registry or the F1 reference
'use strict';

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '').replace(/↑/g, 'up').replace(/↓/g, 'down');

function tagOf(html, id) {
  const m = new RegExp(`<[a-z0-9]+\\b[^>]*\\sid="${id}"[^>]*>`, 'i').exec(html);
  return m ? m[0] : null;
}

// Discover bundled tools from the shell and loaded modules, not a second hand-maintained list.
// Keep literal ws/sub registration metadata and P8ExtraTools.push({ id, ... }) discoverable.
function builtins(html, sources = {}) {
  const tools = new Map();
  const add = (ws, sub) => tools.set(sub ? `${ws}/${sub}` : ws, { ws, ...(sub ? { sub } : {}) });
  for (const m of html.matchAll(/<main\b[^>]*\sdata-ws=["']([\w-]+)["']/g)) add(m[1]);
  const tabs = html.match(/id=["']exTabs["'][\s\S]*?<\/div>/)?.[0] || '';
  for (const m of tabs.matchAll(/data-value=["']([\w-]+)["']/g)) add('extras', m[1]);
  for (const source of Object.values(sources)) {
    for (const m of source.matchAll(/\bregisterTool\(\{([\s\S]*?)\}\);/g)) {
      const ws = m[1].match(/\bws:\s*['"]([\w-]+)['"]/)?.[1], sub = m[1].match(/\bsub:\s*['"]([\w-]+)['"]/)?.[1];
      if (ws) add(ws, sub);
    }
    for (const m of source.matchAll(/P8ExtraTools[^;]*?\.push\(\{\s*id:\s*['"]([\w-]+)['"]/g)) add('extras', m[1]);
  }
  return [...tools.values()];
}

const AREAS = ['work', 'controls', 'input', 'output', 'handoff'];
const keyOf = (tool) => tool.sub ? `${tool.ws}/${tool.sub}` : tool.ws;

function tourCoverage(tools, tours, exceptions = {}) {
  const errors = [];
  for (const tool of tools) {
    const key = keyOf(tool), matches = tours.filter((tour) => tour.ws === tool.ws && (tour.sub || null) === (tool.sub || null));
    if (Object.prototype.hasOwnProperty.call(exceptions, key)) {
      if (typeof exceptions[key] !== 'string' || !exceptions[key].trim()) errors.push(`Tour exception "${key}" needs a written reason.`);
      continue;
    }
    if (matches.length !== 1) errors.push(`Built-in "${key}" needs exactly one tour (found ${matches.length}). Add ws/sub metadata in js/tours-data.js or a justified tourExceptions entry.`);
  }
  for (const tour of tours) {
    if (!tools.some((tool) => keyOf(tool) === keyOf(tour))) errors.push(`Tour "${tour.id}" references unknown built-in "${keyOf(tour)}". Check ws/sub metadata.`);
    // Home is navigation, covered by the Suite overview rather than an editor-area tour.
    if (tour.scope === 'suite' && tour.ws === 'home') continue;
    if (!tour.steps?.length || tour.steps[0].before?.ws !== tour.ws) errors.push(`Tour "${tour.id}" must open its workspace in the first step's before.ws.`);
    const covered = new Set();
    for (const step of tour.steps || []) for (const area of step.areas || []) {
      if (!AREAS.includes(area)) errors.push(`Tour "${tour.id}" step "${step.id}": unknown area "${area}"; use ${AREAS.join(', ')}.`);
      else if (!step.target) errors.push(`Tour "${tour.id}" step "${step.id}": area "${area}" needs a highlighted target.`);
      else covered.add(area);
    }
    for (const area of AREAS) {
      const reason = tour.areaExceptions?.[area];
      if (reason !== undefined && (typeof reason !== 'string' || !reason.trim())) errors.push(`Tour "${tour.id}" area exception "${area}" needs a written reason.`);
      if (!covered.has(area) && !reason) errors.push(`Tour "${tour.id}" does not cover area "${area}". Tag a relevant step with areas or document areaExceptions with a reason.`);
    }
  }
  return errors;
}

// Static evidence only: selector tokens exist in markup or literal DOM builders. This does not
// establish runtime visibility/selector ancestry; the browser checklist remains necessary.
function targetErrors(selector, step, where, html, sources, tools) {
  const errors = [], src = Object.values(sources).join('\n');
  let dynamic = false, hidden = false;
  const declared = !!(step.optional || step.conditional || step.before?.ws || step.before?.click);
  const staticAttrs = [...html.matchAll(/\b(id|class|data-[\w-]+)=["']([^"']*)["']/g)];
  const attrs = (name, value) => staticAttrs.some((m) => m[1] === name && (value === null || (name === 'class' ? m[2].split(/\s+/).includes(value) : m[2] === value)));
  const literal = (name, value) => [...src.matchAll(/\b(id|className):\s*['"]([^'"]*)['"]/g)].some((m) => m[1] === name && (name === 'className' ? m[2].split(/\s+/).includes(value) : m[2] === value));
  const has = (name, value) => {
    if (attrs(name, value)) return;
    dynamic = true;
    const generated = name === 'id' ? literal('id', value) : name === 'class' ? literal('className', value)
      : name === 'data-ex' || name === 'data-value' ? tools.some((t) => t.ws === 'extras' && t.sub === value)
      : [...src.matchAll(/['"](data-[\w-]+)['"]:\s*['"]([^'"]*)['"]/g), ...src.matchAll(/\.setAttribute\(['"](data-[\w-]+)['"],\s*['"]([^'"]*)['"]\)/g)].some((m) => m[1] === name && (value === null || m[2] === value));
    if (!generated) errors.push(`${where}: target ${name === 'id' ? '#' + value : name === 'class' ? '.' + value : '[' + name + (value === null ? '' : '=' + value) + ']'} does not exist in index.html or bundled DOM builders.`);
  };
  if (/nth-child|nth-of-type/.test(selector)) errors.push(`${where}: brittle selector "${selector}"; use an id, class or data-tour-id.`);
  for (const m of selector.matchAll(/\[(data-[\w-]+)(?:\s*=\s*["']?([\w.-]+)["']?)?\]/g)) has(m[1], m[2] ?? null);
  const bare = selector.replace(/\[[^\]]*\]/g, '');
  for (const m of bare.matchAll(/#([\w-]+)/g)) { has('id', m[1]); if (/\shidden(?:\s|>|=)/.test(tagOf(html, m[1]) || '')) hidden = true; }
  for (const m of bare.matchAll(/\.([\w-]+)/g)) has('class', m[1]);
  if ((dynamic || hidden) && !declared) errors.push(`${where}: target "${selector}" is ${hidden ? 'hidden by default' : 'created by JavaScript'}; declare optional/conditional or a harmless before step.`);
  return errors;
}

/**
 * input: { html, sources: { loadedPath: sourceText }, topics, controlLookup(id), tours, workspaces[],
 *          exceptions: { ws: helpReason }, tourExceptions: { "ws[/sub]": reason } }
 * returns string[] (empty = ok)
 */
function check({ html, topics, controlLookup, tours, workspaces, exceptions = {}, sources = {}, tourExceptions = {} }) {
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
  const tools = builtins(html, sources);
  errors.push(...tourCoverage(tools, tours, tourExceptions));
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
      for (const selector of [s.target, s.before?.click].filter(Boolean)) {
        errors.push(...targetErrors(selector, s, where, html, sources, tools));
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

module.exports = { check, builtins, tourCoverage };
