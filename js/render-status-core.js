// js/render-status-core.js
// Truthful preview / final status for long-running renders such as Terrain Lab (UX issue #67).
// No DOM; tests/render-status.test.js runs it in Node. It only *describes* the state js/terrain.js is
// in; it never changes the render pipeline, the algorithms or the output bytes.
//
// Vocabulary (also in the F1 help and EXTENDING.md):
//  - queued:          your last edit has no result yet; the screen still shows an older one (labelled stale)
//  - preview:         a fast, low-resolution result of your latest edit is on screen. Not final; not exported
//  - rendering-final: the full-resolution render of the latest edit is running (preview may be on screen)
//  - final:           the full-resolution result of the latest edit is on screen; only this can be exported
//  - stale:           the result on screen is older than your latest edit and nothing is running for it
//  - error:           a render failed; the screen shows the last good result (if any) labelled stale
// No percentages are shown: the renderer does not report progress, so none is invented.

'use strict';

const P8RenderStatus = (() => {
  /**
   * s: { rev, shownRev (-1: nothing shown), finalRev (-1: none), previewRunning, finalRunning, finalScheduled, error }
   *    rev: revision of the newest edit; *Rev: the edit a result was computed for
   */
  function describe(s) {
    const shownIsCurrent = s.shownRev === s.rev;
    const haveShown = s.shownRev >= 0;
    if (s.error) {
      return { state: 'error', tone: 'error', exportable: false, label: 'Render failed', detail: `${s.error}${haveShown ? ' The image shown is stale (older than your last edit).' : ''}`, stale: haveShown && !shownIsCurrent };
    }
    if (s.finalRev === s.rev) return { state: 'final', tone: 'final', exportable: true, label: 'Final', detail: 'Full-resolution render of your latest edit. Exports use this.', stale: false };
    if (s.finalRunning && shownIsCurrent) return { state: 'rendering-final', tone: 'busy', exportable: false, label: 'Preview · rendering final…', detail: 'The low-resolution preview is current; the full-resolution render is running.', stale: false };
    if (s.finalRunning) return { state: 'rendering-final', tone: 'busy', exportable: false, label: 'Rendering final…', detail: haveShown ? 'The image shown is stale until it finishes.' : 'Nothing to show yet.', stale: haveShown };
    if (shownIsCurrent) return { state: 'preview', tone: 'busy', exportable: false, label: 'Preview', detail: s.finalScheduled ? 'Preview of your latest edit. The final render starts when you pause.' : 'Preview of your latest edit. The final render is queued.', stale: false };
    if (s.previewRunning || s.finalScheduled) return { state: 'queued', tone: 'busy', exportable: false, label: haveShown ? 'Queued · image is stale' : 'Queued', detail: haveShown ? 'Your latest edit is queued. The image shown is from before it.' : 'Your latest edit is queued.', stale: haveShown };
    return { state: 'stale', tone: 'warn', exportable: false, label: 'Stale', detail: 'The image shown is older than your latest edit and nothing is running. Use Retry.', stale: true };
  }

  /** a message a person can act on, with the Error ID to quote in a report */
  function errorText(where, id) {
    return `The ${where} render stopped${id ? ` (Error ID ${id})` : ''}. Retry re-renders your latest edit; your edits are not lost. If it keeps failing, use Help › Report a problem.`;
  }

  /** input-to-feedback sample: ack = time from the input to the next frame showing the new status */
  function summarize(samples) {
    if (!samples.length) return { n: 0 };
    const sorted = samples.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return { n: sorted.length, median: q(0.5), p75: q(0.75), max: sorted[sorted.length - 1] };
  }

  return { describe, errorText, summarize };
})();

if (typeof module !== 'undefined') module.exports = P8RenderStatus;
