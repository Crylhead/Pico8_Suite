// js/nav-core.js
// Workspace navigation model (UX issue #53). No DOM: runs in Node (tests/nav.test.js); js/suite.js
// uses it for the workspace bar, the Find tool dialog (Ctrl+K) and the Home tool groups.
//
// - Categories are a discovery grouping only: workspace IDs, deep links and tools never change.
//   A tool without a known `category` falls back to FALLBACK, so it is always listed.
// - Entries are registry records {ws, sub?, name, desc, tags?, category?}. `sub` names a part of a
//   workspace (an Extra Tools tab); its deep link is #ws/sub.
// - search() matches every query word against the name, description, tags and category name, so a
//   task word ("tokens", "fade") finds the tool; the order is deterministic.
// - FORMER_NAMES (#189): display names a tool had before, matched like part of its name so an old
//   name still finds the tool. They are search aliases only, never shown.

'use strict';

const P8Nav = (() => {
  const CATEGORIES = Object.freeze([
    Object.freeze({ id: 'create', label: 'Create', desc: 'Pixels, palettes, tiles, maps and terrain' }),
    Object.freeze({ id: 'develop', label: 'Develop', desc: 'Code and cart building' }),
    Object.freeze({ id: 'inspect', label: 'Inspect', desc: 'Project and data cart analysis' }),
    Object.freeze({ id: 'utilities', label: 'Utilities', desc: 'Converters and generators' }),
  ]);
  const FALLBACK = 'utilities';
  const FORMER_NAMES = Object.freeze({ cartbuilder: ['Cart Builder'], datacarts: ['Data Carts'], data: ['Data Tools'] });
  const formerNames = (entry) => (!entry?.sub && Object.hasOwn(FORMER_NAMES, entry?.ws) ? FORMER_NAMES[entry.ws] : []);
  const rank = new Map(CATEGORIES.map((c, i) => [c.id, i]));

  const categoryOf = (entry) => (rank.has(entry?.category) ? entry.category : FALLBACK);
  const category = (id) => CATEGORIES[rank.get(id) ?? rank.get(FALLBACK)];

  /**
   * Entries sorted by category, then by `order` (workspace IDs, e.g. the workspace bar order), then
   * by input order. A sub-tool follows the other entries of its category in input order.
   */
  function sort(entries, order = []) {
    const pos = new Map(order.map((ws, i) => [ws, i]));
    return entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (rank.get(categoryOf(a.e)) - rank.get(categoryOf(b.e)))
        || (Boolean(a.e.sub) - Boolean(b.e.sub))
        || ((pos.get(a.e.ws) ?? Infinity) - (pos.get(b.e.ws) ?? Infinity))
        || (a.i - b.i))
      .map((x) => x.e);
  }

  /** [{category, entries}] in category order; empty categories are left out. */
  function group(entries, order = []) {
    const out = [];
    for (const e of sort(entries, order)) {
      const id = categoryOf(e);
      if (out[out.length - 1]?.category.id !== id) out.push({ category: category(id), entries: [] });
      out[out.length - 1].entries.push(e);
    }
    return out;
  }

  const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = (q) => fold(q).split(/[\s,;]+/).filter(Boolean);

  /**
   * Entries matching every word of `query`, best first: name word start, name, tag/category,
   * description (ties keep sort() order). An empty query returns sort(entries, order).
   */
  function search(entries, query, order = []) {
    const terms = words(query);
    const all = sort(entries, order);
    if (!terms.length) return all;
    const scored = [];
    all.forEach((e, i) => {
      const name = fold(e.name);
      const nameWords = name.split(/[^a-z0-9.]+/);
      const tags = (e.tags || []).map(fold).join(' ') + ' ' + fold(category(categoryOf(e)).label);
      const desc = fold(e.desc);
      const former = formerNames(e).map(fold).join(' ');
      let score = 0;
      for (const t of terms) {
        if (nameWords.some((w) => w.startsWith(t))) score += 0;
        else if (name.includes(t) || former.split(/[^a-z0-9.]+/).some((w) => w.startsWith(t))) score += 1;
        else if (tags.includes(t)) score += 2;
        else if (desc.includes(t)) score += 3;
        else return;
      }
      scored.push({ e, i, score });
    });
    return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.e);
  }

  const ID = /^[a-z0-9][a-z0-9_-]*$/i;

  /** '#extras/terrain' -> {ws:'extras', sub:'terrain'}; anything malformed -> {ws:'', sub:null}. */
  function parseRoute(hash) {
    let s = String(hash ?? '').replace(/^#/, '');
    try { s = decodeURIComponent(s); } catch { return { ws: '', sub: null }; }
    const [ws, sub, ...rest] = s.split('/');
    if (!ID.test(ws) || rest.length) return { ws: '', sub: null };
    return { ws, sub: sub && ID.test(sub) ? sub : null };
  }

  const formatRoute = (ws, sub = null) => `#${ws}${sub ? `/${sub}` : ''}`;

  return { CATEGORIES, FALLBACK, FORMER_NAMES, formerNames, categoryOf, category, sort, group, search, parseRoute, formatRoute };
})();

if (typeof module !== 'undefined') module.exports = P8Nav;
