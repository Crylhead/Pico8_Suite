// js/help-core.js
// Help registry API (UX issue #59). No DOM; runs in Node (tests/help.test.js). Content lives in
// js/help-data.js. Tooltips (#60) and tours (#61) look text up by stable id:
//
//   P8Help.topic(id)              -> topic | null (aliases resolved)
//   P8Help.forWorkspace(ws, sub)  -> subtool topic, else workspace topic | null
//   P8Help.context(options)      -> { topic, controlId } explicit > focused control > subtool > workspace
//   P8Help.control(controlId)     -> { topic, control } | null
//   P8Help.search(query)          -> [{ topic, score, matches[] }] best first
//   P8Help.toc()                  -> topics grouped for the index

'use strict';

const P8Help = (() => {
  const Data = typeof P8HelpData !== 'undefined' ? P8HelpData : require('./help-data.js');
  const { TOPICS, ALIASES } = Data;
  const byId = new Map(TOPICS.map((t) => [t.id, t]));

  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = (s) => norm(s).split(/[^a-z0-9+#.]+/).filter(Boolean);

  const resolve = (id) => byId.get(ALIASES[id] || id) || null;

  function control(controlId) {
    const id = ALIASES[controlId] || controlId;
    for (const topic of TOPICS) {
      const c = (topic.controls || []).find((x) => x.id === id) || (topic.actions || []).find((x) => x.id === id);
      if (c) return { topic, control: c };
    }
    return null;
  }

  function forWorkspace(ws, sub) {
    return (sub && TOPICS.find((t) => t.ws === ws && t.sub === sub))
      || TOPICS.find((t) => t.kind === 'tool' && t.ws === ws && !t.sub) || null;
  }

  function context({ topicId, controlId, ws, sub } = {}) {
    const explicit = resolve(topicId);
    if (explicit) return { topic: explicit, controlId: null };
    const hit = control(topicId) || control(controlId);
    if (hit) return { topic: hit.topic, controlId: hit.control.id };
    return { topic: forWorkspace(ws, sub), controlId: null };
  }

  /** Fields searched, with weights: control and task names are what users type. */
  function fields(t) {
    return [
      [t.title, 8, 'title'],
      [(t.keywords || []).join(' '), 6, 'keyword'],
      [(t.tasks || []).join(' '), 5, 'task'],
      [(t.controls || []).map((c) => c.label).join(' '), 5, 'control'],
      [(t.actions || []).map((a) => a.name).join(' '), 5, 'action'],
      [(t.shortcuts || []).map((s) => `${s[0]} ${s[1]}`).join(' '), 3, 'shortcut'],
      [t.summary, 3, 'summary'],
      [[...(t.actions || []).flatMap((a) => [a.text, a.detail]), ...(t.controls || []).flatMap((c) => [c.text, c.detail]), ...(t.restrictions || []), ...(t.inputs || []), ...(t.outputs || [])].join(' '), 1, 'text'],
    ];
  }

  /** Every query word must match (prefix match on words); score is the weighted sum. */
  function search(query) {
    const qs = words(query);
    if (!qs.length) return [];
    const out = [];
    for (const topic of TOPICS) {
      const fs = fields(topic).map(([text, w, kind]) => ({ ws: words(text), w, kind }));
      let score = 0;
      const matches = new Set();
      let all = true;
      for (const q of qs) {
        let best = 0;
        for (const f of fs) {
          if (f.ws.some((x) => x === q)) { if (f.w * 2 > best) best = f.w * 2; matches.add(f.kind); } else if (f.ws.some((x) => x.startsWith(q))) { if (f.w > best) best = f.w; matches.add(f.kind); }
        }
        if (!best) { all = false; break; }
        score += best;
      }
      if (all) out.push({ topic, score, matches: [...matches] });
    }
    return out.sort((a, b) => b.score - a.score || a.topic.title.localeCompare(b.topic.title));
  }

  const toc = () => ({
    tools: TOPICS.filter((t) => t.kind === 'tool'),
    guides: TOPICS.filter((t) => t.kind === 'guide'),
    reference: TOPICS.filter((t) => t.kind === 'reference'),
  });

  return {
    topics: () => TOPICS.slice(),
    topic: resolve,
    forWorkspace, context, control, search, toc,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Help;
