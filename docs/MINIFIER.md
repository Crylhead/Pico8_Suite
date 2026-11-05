# Minifier user guide

Develop → Minifier runs pinned Shrinko8 locally in a browser worker. Choose a level (**Minimal**, Safe, Aggressive) and a focus (Balanced, **Tokens**, characters, compressed size, or two combined), as in the Shrinko8 web version; **Minimal + Tokens** is the default. Safe also renames variables (locals and globals, never PICO-8 callbacks or built-ins) but keeps table field names. Aggressive also allows changes Shrinko8 cannot prove safe; with **Rename aggressively** it renames table fields too, which breaks code that reaches fields or globals through strings (`t["name"]`, `_ENV`). Test Aggressive builds in PICO-8. It compares a captured source with generated Lua and offers separate build-copy exports. It never applies output to Code Editor, overwrites an original file or marks it saved. It never optimizes automatically on import, typing, Save, Run or Cart Packer export.

Minimal retains names and line breaks but may change expressions, comments and spacing. Token savings are **not guaranteed**; unchanged or increased output is a valid result. Only Minimal and Tokens are enabled; Safe, Aggressive, custom compiler scripts and Parens-8 are unsupported.

## Start locally or on a host

Run `python tools/package_minifier.py` once in the Suite folder (Python 3.9+; the first run needs Internet or the pinned archives). Then simply **open `index.html` directly** in Chrome or Edge; no server is needed. The setup writes `vendor/pyodide/runtime/file-assets.js`, which the page loads as a script; the worker starts from a blob URL and answers the engine's own file requests from that memory, with the same SHA-256 and version checks as the HTTP mode (#162). If the file is missing, the workspace shows **One-time setup required**; run the command, then choose **Retry engine**. The optional launcher (**Start_Pico8_Suite.bat** or `python tools/serve_suite.py`) still works and serves the Suite at localhost; it also prepares the same files. A hosted installation needs no Python service or Run bridge. Firefox and Safari are not tested for direct opening.

Processing stays in the browser; source is not uploaded. All runtime requests use the Suite's origin. Once runtime assets are loaded, the initialized engine can process in memory offline; this does not promise a cold offline reload without cached assets. See [engine packaging and offline setup](MINIFIER_ENGINE.md).

Browser Library and session data belong to each address. Export a Library backup before moving between a directly opened `index.html` (`file://`) and localhost, and import it there. Minifier source snapshots are page-only and are **lost on reload**; retain the original source outside this workspace.

## First build

1. Choose **Open file…** for a UTF-8 `.lua` or text `.p8`, or **Paste Lua…** for nonempty Lua. Paste becomes `pasted.lua`. PNG/binary cart input is unsupported. A cartridge retains its full original text, version and non-Lua sections; the viewer shows Lua only.
2. Wait for the engine to be ready. Import checks encoding and cartridge structure; the engine checks Lua syntax when you choose **Optimize**. Replacing an existing snapshot asks first. Failed or cancelled intake retains the previous work.
3. Leave **Profile: Minimal** and **Focus: Tokens**, then choose **Optimize**. For example, paste `local value = 1 + 2` followed by `print(value)` to inspect generated code and measured counts. Do not expect a fixed saving for every program.
4. Choose **Compare**, **Original** or **Optimized**. Both panes are read-only and syntax-highlighted like the Code Editor (plain text in forced-colors mode and for very large sources); select text to copy manually. For long lines, Original or Optimized gives one pane the full width. On narrow screens the default is Original; select Optimized to inspect the result. View changes never change source.
5. Read **Code measurements** and expand **Diagnostics**. Check any over-limit warnings, errors and source-only directive warnings.
6. Choose **Copy optimized Lua** or **Download…**. For `.p8` input, the format dialog offers a separate `.min.p8` cart or `.min.lua`; Lua input offers only `.min.lua`. Complete cart input also offers `.min.p8.png` when the optional local encoder is ready. Cancel writes nothing. Keep the original editable project and verify the build in PICO-8.

**Cancel** stops pending work; switching workspaces also cancels pending intake/jobs while retaining the snapshot. **Load engine / Retry engine** starts a fresh engine without submitting source. Choose Optimize explicitly after readiness. Input or option changes invalidate earlier results and disable exports until a new successful result passes validation.

## Code Editor and projects

Code Editor's **Cart → Minify…**, or Minifier's **Use current editor**, captures the live buffer including unsaved edits. **Back to Code Editor** returns to its existing content, caret, save identity and undo history. Later editor edits, saves, document/folder changes invalidate the capture; refresh with Use current editor. No optimized code is written back.

For `#include`, first open the project folder in Code Editor. The handoff reads only reachable dependencies with already-granted access; it does not rescan or ask for permission. Standalone Open/Paste cannot discover neighboring files. Supported forms include nested/repeated relative includes, paths with spaces, `../` within the project and `.p8:0–9` tab includes.

Use exact filename case and explicit extensions. Missing, inaccessible, ambiguous or cyclic includes block intake. Quoted include paths, unsafe escapes, root fallback and tab cases where Suite and Shrinko8 semantics differ are refused. In particular, tab source carts containing includes or unusual/empty tab boundaries are unsupported. Unknown compiler/preprocessor directives are blocked. Dependency snapshots stay fixed until explicitly refreshed; disk edits are not watched. See [verified include boundaries](MINIFIER_ENGINE.md#project-includes--min-07).

Source-only `--@data` anchors and keep/preserve hints may change or disappear during minification. Generated code is an **optimized build copy**, not a round-trippable editable project replacement. Keep the authoring files and project assets.

## Measurements and diagnostics

| Display | Meaning |
| --- | --- |
| Tokens | Actual same-job Shrinko8 counts; budget 8,192. These are not Code Editor estimates. |
| Characters | Actual same-job counts; budget 65,535. Tokens focus may increase this measurement. |
| Compressed code bytes | Engine measurement when available, not the whole `.p8` or PNG size. |
| Saved / increased | Signed outcome described in words, with a comparable percentage. Zero saving is `0 (0%)`; tiny nonzero percentages show `<0.01%`. A zero baseline cannot yield a percentage for an increase. |
| — | Measurement unavailable; the visible explanation gives the reason. No saving is invented when either side is missing. |
| Earlier / stale | The displayed output and measurements belong to an earlier snapshot and cannot export. |
| Over limit | A code budget was exceeded. A successful minification does not guarantee the cartridge fits or runs. |

Diagnostics can be filtered by All, Errors, Warnings or Info; every new set starts at All. Reliable location buttons select the corresponding whole line in the **current original Lua** snapshot. Cart error coordinates include the cartridge header; reported columns remain engine coordinates. Unknown files, invalid positions and stale jobs stay plain text. Location navigation never edits code or opens files.

## Export safety

Both output actions require a current successful validated result. Cancelled, failed, stale, unsupported, incomplete or preservation-mismatched builds cannot export. A valid unchanged result can. Preservation checks establish format/data integrity separately from PICO-8 code-budget compliance; neither establishes runtime equivalence.

For cartridges, checks compare the engine's decoded asset ROM/version and generated Lua, then insert only that Lua into the **exact original header and non-Lua text**. Final checks cover code, data, labels, version and section presence. Metadata, empty graphics/sound sections and their line endings survive. Generated cart Lua follows the original Lua-marker line ending; copied/downloaded Lua uses the engine result text.

**Budget warnings:** the export panel and format dialog identify each exceeded metric, its limit and exact excess. Tokens may be at most 8,192 and characters at most 65,535. If either is exceeded, Lua remains available and text `.p8` requires the explicit **Download .p8 for debugging only** choice; this is an inspection copy, not a compatible build. PNG is blocked for known token/character overages or compressed code of 15,360 bytes or more (maximum 15,359). That compressed-code restriction applies to PNG, not text `.p8` / `.lua`. Unknown compression is checked during PNG encoding. Zero savings and increases within the limits still permit normal exports.

Copy writes only Lua. Clipboard denial or unavailability reports failure; manually select the read-only text and copy with your keyboard. If source changes during copying, feedback identifies the captured earlier build. Download requests a separate browser artifact; the browser controls completion. It is never a project Save. A source/result change while the format dialog is open blocks the download. Export completion returns keyboard focus to its invoking control when still usable, otherwise the Source actions; it does not pull focus back after you navigate elsewhere. Optional `.p8.png` export uses the validated cart, rechecks the current source after encoding and enforces code capacity. Its compressed-code count is distinct from the PNG image byte length. A missing encoder or capacity error keeps `.p8` / `.lua` exports available. See [PNG dependencies, format and verification](MINIFIER_PNG.md).

Independent cartridge-parser checks establish format/data preservation; they do **not** establish runtime equivalence. The [acceptance record](MINIFIER_ACCEPTANCE.md) documents the user-confirmed original/optimized representative-cart comparison, including startup sound, in Windows PICO-8 0.2.7 for [MIN-10 / #128](https://github.com/Crylhead/Pico8_Suite/issues/128). That result does not guarantee equivalence for arbitrary carts.

## Help, tooltips and Quick Tour

- **F1** opens the focused control's explanation, or the Minifier topic when no known control is focused. Searchable Help covers controls, includes, measurements, exports and recovery; Full documentation follows the topic.
- **Help → Tour this tool** starts the Minifier orientation. **Help → Quick tours…** also finds it by tool or subject. The tour covers Source, Optimization Options, Compare, Metrics, Diagnostics and Export, plus generated output and Back to Code Editor when visible. It does not load, optimize, save or modify source.
- Use **Next / Back**, **Finish** or **Escape**. Keyboard focus moves into the tour controls and returns to the opener when possible. Hidden targets are skipped, including the optimized pane in Original view and Back without an editor capture. Replaying is always available; it does not reset source or change the selected code view.
- **Help → Settings → Help detail** offers Concise, Detailed or Off optional tooltips. Detailed adds examples/context and an F1 hint. Labels, warnings, confirmations, errors and export validation stay visible with hints off. Escape dismisses a tooltip.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| One-time setup required | Run `python tools/package_minifier.py` in the Suite folder (the notice has a **Copy** button that says whether the clipboard accepted it), then choose **Retry engine** in the notice (or reload). Until then the source area grows so the notice is fully visible, and Diagnostics lists the state as *setup*, not as an error. For an unsupported address type, open `index.html` directly or use the launcher. |
| Engine failed to load / missing runtime | Check [packaging/setup](MINIFIER_ENGINE.md), prepare verified assets, then Retry engine. Retry never silently resubmits code. |
| Optimize unavailable | Load a nonempty source, wait for readiness, or refresh an earlier editor capture. Unknown level/focus values are refused. |
| Invalid UTF-8, malformed cart or empty input | Use a UTF-8 text `.lua`/`.p8` with nonempty Lua. Cancelled/failed intake leaves earlier work intact. |
| Include missing or denied | Open the folder in Code Editor, grant access through its explicit workflow, correct the dependency/path, then refresh. Minifier does not request access itself. |
| Source location has no button | The location is stale, out of range or not in the displayed entry file. Read the reported path/position without assuming a safe jump exists. |
| Copy failed | Use read-only selection and keyboard copy, or a permitted browser clipboard context. |
| Download disabled / preservation failure | Read the validation message below the buttons. Refresh/Optimize current input; do not use a mismatched build. |
| No saving or increased output | Valid outcome, especially for Minimal or a focus on another measure. Review other budgets and test the build; do not assume every source can shrink. |

## Version, licenses and support

The bundled engine is **Shrinko8 1.2.7f**, pinned to commit `fb6e66827d481020857d7548fdd9dd0171315a86`, copyright thisismypassport, **MIT license**. The Suite bridge uses unchanged upstream Python modules; upstream's web UI and Parens-8 are not included. Local execution uses Pyodide **314.0.7**; pins and notices are in [the lock file](../vendor/minifier-lock.json), [Shrinko8 attribution](../vendor/shrinko8/NOTICE.md), [MIT license](../vendor/shrinko8/LICENSE) and [Pyodide notices](../vendor/pyodide/NOTICE.md).

- [Upstream Shrinko8 documentation](https://github.com/thisismypassport/shrinko8)
- [Suite issues: integration, UI and reproducible problems](https://github.com/Crylhead/Pico8_Suite/issues) — describe the workflow, browser, source format and visible error. **Help → Report a problem** prepares local, reviewable diagnostics; inspect/redact before sharing source or private paths.
- [Official PICO-8 manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html)
- [Engine packaging, supported include semantics and adapter details](MINIFIER_ENGINE.md)

This guide describes the core workflow delivered in MIN-01 through MIN-10. The representative-cart runtime gate passed via user testing; optional PNG export is implemented in MIN-11 and its separate representative-fixture console check is recorded in the [PNG verification notes](MINIFIER_PNG.md); #129 is closed. Neither automatic Cart Packer minification nor applying generated output to editable source is supported.
