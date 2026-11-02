// js/transfer-core.js
// Destination list and send flow for "Send to… / Open in…" (UX issue #57). No DOM; runs in Node
// (tests/transfer.test.js). js/suite.js renders it for the Library and the tools.
//
// Consumer (Suite.registerConsumer): { id, label, kinds: ['image'|'palette'|'map'],
//   accepts?(asset) -> true | 'reason',          // size / format limits of the destination
//   unsaved?() -> false | 'description',         // OPTIONAL: destination holds unsaved work this send would replace
//   open(asset) -> Promise<boolean|void> }       // return false when the user cancelled inside the destination
//
// A destination that asks the user itself inside open() (Pixel Studio, Tile Maker) must return false when
// the user cancels; one that cannot ask declares `unsaved` and gets the central Replace / Cancel prompt.
// Never both for the same destination (double prompts). Nothing is converted or remapped silently:
// a destination either takes the asset as it is or says why not.

'use strict';

const P8Transfer = (() => {
  const PLURAL = { image: 'images', palette: 'palettes', map: 'maps' };
  const plural = (k) => PLURAL[k] || `${k}s`;

  /** [{ id, label, ok, reason }] for every consumer, available ones first; reasons are exact and visible */
  function destinations(consumers, asset) {
    const rows = consumers.map((c) => {
      if (!c.kinds.includes(asset.kind)) {
        return { id: c.id, label: c.label, ok: false, reason: `${c.label} opens ${c.kinds.map(plural).join(' or ')}, not ${plural(asset.kind)}.` };
      }
      const r = c.accepts ? c.accepts(asset) : true;
      return r === true ? { id: c.id, label: c.label, ok: true, reason: '' } : { id: c.id, label: c.label, ok: false, reason: String(r) };
    });
    return [...rows.filter((r) => r.ok), ...rows.filter((r) => !r.ok)];
  }

  /**
   * Runs a send. confirm(message) -> Promise<boolean> (Replace / Cancel).
   * Returns { status: 'done'|'cancelled'|'rejected'|'failed', message }. 'done' only when open() finished
   * and did not report a cancellation; a throwing destination is 'failed' and never reported as success.
   */
  async function send(consumer, asset, { confirm }) {
    if (!consumer) return { status: 'rejected', message: 'That destination is not available.' };
    const rows = destinations([consumer], asset);
    if (!rows[0].ok) return { status: 'rejected', message: rows[0].reason };
    let pending = false;
    try { pending = consumer.unsaved ? consumer.unsaved() : false; } catch { pending = false; }
    if (pending && !(await confirm(`${consumer.label} has unsaved work.\n\n${pending}\n\nReplace it with “${asset.name}”, or cancel and keep both as they are?`))) {
      return { status: 'cancelled', message: `Cancelled. “${asset.name}” and ${consumer.label} are unchanged.` };
    }
    try {
      const r = await consumer.open(asset);
      if (r === false) return { status: 'cancelled', message: `Cancelled. “${asset.name}” and ${consumer.label} are unchanged.` };
      return { status: 'done', message: '', confirmed: r === true };
    } catch (err) {
      return { status: 'failed', message: `${consumer.label} could not open “${asset.name}”: ${err && err.message ? err.message : 'unknown error'}. Nothing was changed.` };
    }
  }

  /** success wording: names the target and says whether the result is temporary or saved */
  const doneMessage = (consumer, asset, { saved }) => (saved
    ? `Sent “${asset.name}” to ${consumer.label}. The Library copy is unchanged; save in ${consumer.label} to keep your changes there.`
    : `Sent a temporary copy of “${asset.name}” to ${consumer.label}. It is not in the Library: save it there to keep it.`);

  return { destinations, send, doneMessage, plural };
})();

if (typeof module !== 'undefined') module.exports = P8Transfer;
