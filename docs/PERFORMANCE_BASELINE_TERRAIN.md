# Terrain Lab input-to-feedback baseline (UX #67)

**Provenance:** the table below was supplied by the archive author. An independent foreground before/after measurement with frame pacing follows at the end of this file.

Local, manual measurement through `window.P8TerrainDebug`; no telemetry. Run in the Browser pane of the Claude desktop app (Chromium, Windows 10, one run, pane in the background), so treat the numbers as an indication on one machine, not a lab baseline. Repeat on your machine before comparing.

| Terrain size | Synchronous acknowledgement (edit → status badge updated), median / max of 10 edits | Preview + final until "Final" (single edit, total) | Final render time reported by the worker |
| --- | --- | --- | --- |
| 256 | 0.4 ms / 2.1 ms | ≈ 500 ms | 366 ms |
| 512 | 0.4 ms / 1.9 ms | ≈ 723 ms | 596 ms |
| 1024 | 0.5 ms / 0.8 ms | ≈ 1509 ms | 1312 ms |

- **Acknowledgement** is the time `changed()` needs to bump the revision, update the badge ("Queued" / stale marker) and queue the preview. It is independent of the terrain size because the heavy work runs in the workers. It is *not* INP: INP also contains event-handler and paint time, which the pane could not report (`requestAnimationFrame` is throttled in a background pane, so the next-frame samples in `ackSamples` stayed empty here). Capture next-frame samples and a Chrome performance trace in a foreground window for INP and frame pacing.
- **Total processing time** (last two columns) is reported separately from responsiveness: a slow final render no longer delays the acknowledgement.
- Not measured here: frame pacing during brush drags at 60 Hz, a baseline *before* this change (the old badge showed only "Preview" / "Final").
- Output is unchanged: the worker, the revision handling for results and the exported bytes were not modified; the existing terrain tests (`tests/terrain.test.js`) cover the model.

## Independent foreground measurement, before and after (2026-11-03)

**Setup:** headless Chrome on Windows 11, driven over the DevTools protocol. The page is a foreground page, so `requestAnimationFrame` is not throttled. **Before** is the Suite at `334c310` (just before the archive integration that brought the #67 status work), served from a temporary `git worktree`. **After** is `main` at `2174127`. One run per build on one machine: an indication, not a lab benchmark. A temporary script outside the repo did the measuring; nothing is recorded by the app.

**Inputs:** 10 keyboard steps on a visible terrain slider (*Sea level* in Advanced mode, 150 ms apart), then a 2-second brush drag (Raise) across the canvas at about 60 Hz, at each Final size.

- **Event Timing** (`PerformanceObserver` type `event`, threshold 16 ms) covers keydown/keyup/input. Its `duration` is input delay + processing + presentation of the next frame, which is the quantity INP is built from.
- **Frame pacing** is the `requestAnimationFrame` interval during the drag, plus `longtask` entries.
- **Total processing** is reported separately: from the last edit or pointer release until the badge reads *Final*.

| Final size | Build | Badge right after a slider step | Slider Event Timing p50 / p95 / max | Events > 100 ms | Drag frame interval p50 / p95 / max | Frames > 50 ms · long tasks | Drag release → *Final* |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 256 | before | *Preview* | 24 / 48 / 48 ms | 0 | 16.7 / 16.8 / 16.8 ms | 0 · 0 | 30 ms |
| 256 | after | *Queued · image is stale* | 24 / 32 / 32 ms | 0 | 16.7 / 16.8 / 16.9 ms | 0 · 0 | 29 ms |
| 512 | before | *Preview* | 24 / 32 / 32 ms | 0 | 16.7 / 16.8 / 17.0 ms | 0 · 0 | 61 ms |
| 512 | after | *Queued · image is stale* | 24 / 48 / 48 ms | 0 | 16.7 / 16.8 / 17.0 ms | 0 · 0 | 62 ms |
| 1024 | before | *Preview* | 40 / 48 / 48 ms | 0 | 16.7 / 16.8 / 16.9 ms | 0 · 0 | 164 ms |
| 1024 | after | *Queued · image is stale* | 24 / 32 / 32 ms | 0 | 16.7 / 16.8 / 16.8 ms | 0 · 0 | 186 ms |

**Reading:**
- **Responsiveness** is unchanged and good in both builds. The slider's input-to-next-paint stays well under 100 ms at every size; Event Timing values are quantized to about 8 ms, so the p50/p95 differences are noise. The brush drag keeps a steady 60 fps (p95 16.8 ms) with no long task, because all terrain work runs in the workers.
- **Total processing** until *Final* grows with the size, as expected: about 30, 60 and 160–220 ms after the last input. It is reported separately and does not delay the acknowledgement.
- **Truthfulness** is what changed. Before, the badge said *Preview* (or *Final*, while a new edit was still rendering). After, it immediately says *Queued · image is stale* with a dashed frame. Twenty-five edits made at random moments during renders never left the badge on *Final* right after an edit.
- **Output** is unchanged: a fresh default 512 terrain renders a byte-identical Final canvas in both builds (pixel hash `7febd7a5`, color view). The worker and model were not modified; `tests/terrain.test.js` covers the model.

**Worker failure (after only):** a synthetic `error` event on the preview worker, and separately on the final worker, shows **Render failed** with the explanation *"The preview / final render stopped (Error ID …). Retry re-renders your latest edit; your edits are not lost. If it keeps failing, use Help › Report a problem."* There is no DevTools/console instruction. **Retry** returns to *Final* in about 120 ms, and the error is in `P8App.diagnostics` under the same Error ID. Before, the same failure showed *Worker error* / *Error (see console)*.
