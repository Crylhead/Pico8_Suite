# Terrain Lab input-to-feedback baseline (UX #67)

**Provenance:** measurements supplied by the archive author; not independently reproduced in the GitHub integration environment. Issue #67 remains open for foreground before/after and frame-pacing evidence.

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
