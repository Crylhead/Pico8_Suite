# PICO-8 Suite — Minifier Workspace: Technical UI/UX Specification

**Document ID:** P8S-MIN-UX-001  
**Version:** 1.2 (status annotation; original v1.1 design retained)

**Date:** 2026-11-03  
**Status:** Historical design baseline with current implementation status below

**Default profile:** **Minimal**  
**Optimization target:** **Tokens**  
**Primary engine:** Shrinko8, version pinned at implementation  
**Target repository:** https://github.com/Crylhead/Pico8_Suite

## Current implementation status — 2026-11-03

Minifier is implemented on `main` through [PR #144](https://github.com/Crylhead/Pico8_Suite/pull/144) (`51c223b`). MIN-01–MIN-11 shipped; [core tracker #130](https://github.com/Crylhead/Pico8_Suite/issues/130), [core acceptance #128](https://github.com/Crylhead/Pico8_Suite/issues/128) and [PNG task #129](https://github.com/Crylhead/Pico8_Suite/issues/129) are closed. This status does not mean every original design detail or every possible cart has been verified.

| Area | Current behavior / evidence |
| --- | --- |
| Workspace and defaults | Develop → Minifier, immediately after Code Editor; only **Minimal + Tokens** is supported. Safe/Aggressive and other focus values remain disabled/unavailable. |
| Input and project handoff | UTF-8 `.lua` / `.p8`, pasted Lua and unsaved Code Editor snapshots; verified include forms from the already-opened project folder. Original source, caret/save context and undo are retained. |
| Outputs | Copy generated Lua; separate `.min.lua` / `.min.p8`; optional `.min.p8.png` for complete cart input when its local encoder is available and capacity checks pass. PNG import is unsupported. |
| Hosting and assets | HTTP(S) with packaged pinned Shrinko8/Pyodide assets, or `index.html` opened directly (`file://`) after the one-time `python tools/package_minifier.py` (#162). No source upload, CDN fallback or mandatory Run bridge. See [setup](MINIFIER_ENGINE.md). |
| Comparison presentation | Native read-only textareas with Compare / Original / Optimized modes. Since [#147](https://github.com/Crylhead/Pico8_Suite/issues/147) both panes are syntax-highlighted with the Suite Lua lexer: an `aria-hidden` copy built from text nodes sits behind each textarea, which remains the selectable, copyable and accessible plain-text control. Forced-colors mode, sources over 200,000 characters and a lexer failure show plain text. Stale output keeps its dashed border and is dimmed. Long code uses the single Original / Optimized view rather than a resizable split. |
| Public API and control IDs | Use [EXTENDING.md](../EXTENDING.md#minifier-jobs), `index.html` and the current `js/minifier-*.js` modules. The illustrative IDs and request/result schema below are the original proposal, not an authoritative current API. |
| Verification | Headless Chromium and native engine/data checks, plus user-run original/optimized `.p8` and PNG fixture comparisons in Windows PICO-8 0.2.7. See [core acceptance](MINIFIER_ACCEPTANCE.md) and [PNG verification](MINIFIER_PNG.md). No general runtime-equivalence, other-browser or full screen-reader claim is made. |
| Follow-up work | Required native-engine CI execution is tracked in [#145](https://github.com/Crylhead/Pico8_Suite/issues/145); broader cart coverage in [#148](https://github.com/Crylhead/Pico8_Suite/issues/148); export budget wording in [#149](https://github.com/Crylhead/Pico8_Suite/issues/149). |

### Reading the retained design baseline

Sections 1–15 and the icon appendix preserve the original v1.1 design from [PR #118](https://github.com/Crylhead/Pico8_Suite/pull/118). Proposed layouts, control IDs, schema examples, release checkboxes and the initial six work packages are historical requirements, not a current feature inventory or completion dashboard. The implementation was delivered through the later eleven-issue [roadmap #130](https://github.com/Crylhead/Pico8_Suite/issues/130). For current user behavior, start with [MINIFIER.md](MINIFIER.md); for actual evidence and untested combinations, use the acceptance records above. Do not mark a proposed requirement verified without evidence.

## 1. Product decision and goals

Introduce a standalone **Minifier** workspace in **Develop**, immediately after Code Editor and before Cart Builder. Expose the same tool through a **Minify…** command in the Code Editor. Both entry points invoke one implementation. The workspace performs an explicit, non-destructive optimization of an in-memory source snapshot and permits inspection and export of a generated *build artifact*; it does not silently replace editable project sources.

Primary task: **“I want to reduce the PICO-8 token count without making my source unnecessarily hard to debug.”** Optimizing tokens does not guarantee a lower character count, smaller compressed code, or faster execution. Minimal may save *zero* tokens; a zero result is valid and must never be disguised as success with an invented saving.

Design invariants: integrate with the existing static/no-build JavaScript shell; adopt the current design system; preserve work and file permissions; never invent a success state; use help/tour infrastructure; offer local-only processing; and keep the third-party engine replaceable.

### In scope for v1

- Standalone import of `.p8` and `.lua`; paste Lua; receive current Code Editor snapshot; include-aware project input when a readable folder is available.
- Minimal profile and Tokens target as defaults; options to change to Safe or Aggressive and alternative targets may be added without changing the default.
- Explicit Optimize, Cancel, Retry, original/optimized comparison, real before/after counters, warnings/errors, copy and export.
- Output `.lua` and `.p8`; `.p8.png` only if the bundled engine's PNG conversion and asset dependencies are verified in the supported browsers. Do not render an enabled export option that is not implemented.
- Lazy-loaded Shrinko8 adapter in a Web Worker; local packaged dependencies for hosted use.
- Documentation, current-tool quick tour, diagnostics and focused tests.

### Out of scope for v1

- Automatically optimizing every Code Editor save, Run, or Cart Builder build.
- Parens-8 compilation / experimental compiler transformations.
- Mandatory local Python service, remote optimization API, or new mandatory bundler.
- Pretending source and optimized output are semantically identical without runtime testing.
- Creating a second code editor, file manager, library, settings system, or separate navigation scheme.

## 2. Information architecture and launch points

- Register workspace as `ws: 'minifier'`, `name: 'Minifier'`, `category: 'develop'`, tags `['minify','optimize','tokens','shrinko8','lua','cartridge']` and a descriptive action-oriented `desc`. Route `#minifier`.
- In `index.html`, add the Minifier workspace-tab control between Code Editor and Cart Builder, plus `<main data-ws="minifier" class="layout-minifier" hidden>`.
- In Code Editor, add **Tools → Minify…** (or a clearly labeled Code/Cart action consistent with current menu organization). This transfers the *unsaved in-memory snapshot*, not only last-saved disk content.
- Add Minifier to Home/Find Tool through `Suite.registerTool`; do not special-case Home search or write a second launcher.
- Optionally add a Code Editor toolbar shortcut only after verifying space and responsive behavior; one menu entry is mandatory, an icon-only button is not.
- From Minifier, **Back to Code Editor** returns to the source editor without applying generated code.

## 3. Layout and responsive behavior

### Desktop, viewport ≥ 1200 px

The workspace fills available height, with a bounded top command bar, a left control panel (nominal 288–320 px), a main comparison area, a metric summary underneath the comparison, and a collapsible diagnostics drawer. Use existing panel, button, field, segment and status primitives. Do not duplicate the shell menubar.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ MINIFIER  my_effect.p8  [From Code Editor]                 [Help] [Tour this tool]     │
│ [Open file…] [Paste Lua…] [Use current editor]    [Optimize] [Cancel]    ● Ready       │
├───────────────────────┬────────────────────────────────────────────────────────────────┤
│ OPTIMIZATION          │ [Compare] [Original] [Optimized]       [Copy] [Download ▼]      │
│ Profile               │ ┌─────────────────────┬──────────────────────────────────────┐ │
│ (●) Minimal           │ │ Original source     │ Optimized output                     │ │
│ ( ) Safe              │ │ read-only           │ read-only                            │ │
│ ( ) Aggressive        │ │ syntax-highlighted  │ syntax-highlighted                   │ │
│                       │ │ synchronized scroll*│ optional linked scroll*               │ │
│ Focus                 │ └─────────────────────┴──────────────────────────────────────┘ │
│ [Tokens         ▾]    │ Before / After / Saved   Tokens  Chars  Compressed bytes         │
│                       ├────────────────────────────────────────────────────────────────┤
│ Minimal keeps names   │ [Diagnostics (0) ▾]  Errors, warnings, include paths           │
│ and line breaks.      │                                                                │
│ [Advanced settings ▸] │ *Linked scroll only when line mapping can be meaningful.        │
└───────────────────────┴────────────────────────────────────────────────────────────────┘
```

The drawing is structural, not pixel-perfect. Comparison panes must not be artificially equal in width if either creates excessive wrapping: support resizing or an easy single-view toggle. Maintain a clearly visible distinction between **original** and **generated** code. The output is never editable in place in v1.

### Tablet, 700–1199 px

Reduce the control rail to roughly 240–280 px or place controls in a disclosure above results when main code panes would be too narrow. Switch comparison to a single selected read-only source pane by default, while preserving a user-selectable Compare mode if there is space. All counters remain visible.

### Small screens, < 700 px

Single vertical column: source command area → profile/target → Optimize → metrics → code-view segmented control → code viewer → diagnostics. Use horizontal scrolling *inside the code viewer* rather than truncating code; no horizontal page scroll. Ensure primary actions are reachable without hover. Use viewport-safe sticky controls only if they do not cover content or keyboard focus.

### Layout behavior

- Use suite CSS custom properties (`--surface`, `--surface-2`, `--border`, `--text`, `--muted`, `--accent`, `--status-*`, `--space-*`, `--mono`, radii and focus tokens); no custom parallel theme.
- The app's light/dark/system and reduced-motion preferences work automatically.
- Keep the control panel visible enough that the default mode and objective are unmistakable; reserve raw CLI options for Advanced Settings.
- Resizing the browser must not reset source, results, selected profile or diagnostic messages.

## 4. Element and interaction catalog

| Stable ID | Label / role | Initial state | Behavior / contract |
| --- | --- | --- | --- |
| `mnSourceName` | Source identity and provenance | “No source selected” | Display file basename plus `Code Editor`, `Local file`, `Pasted Lua`, or `Project folder`; never imply a disk save. |
| `mnOpen` | `Open file…` button | Enabled | Import `.p8` or `.lua` via browser picker, preserving original bytes and filename metadata. |
| `mnPaste` | `Paste Lua…` button | Enabled | Opens a modal textarea; confirms replacement of an existing unexported working source. |
| `mnUseEditor` | `Use current editor` button | Enabled if Code Editor snapshot is available | Read the *current* editor buffer and project context, including dirty edits; provide no false “saved” claim. |
| `mnProfile` | Segmented/radio group | **Minimal** | Choices: Minimal / Safe / Aggressive; explain impact in persistent supporting text. |
| `mnTarget` | Select or segmented choice | **Tokens** | Tokens / Characters / Compressed size / Balanced, according to verified engine support. |
| `mnOptimize` | Primary button: **Optimize** | Disabled until a valid source is present and engine ready | Runs exactly one immutable source+options revision. |
| `mnCancel` | Button: **Cancel** | Hidden/disabled when idle | Cancels current processing; termination of the worker is permitted when engine cannot interrupt. |
| `mnStatus` | Visible status line | “No source loaded” | Exact pending/ready/running/result/stale/error status with accessible live announcement on transitions. |
| `mnCompareMode` | Radio/segmented: Compare / Original / Optimized | Compare on wide desktop | Switches read-only code presentation; never mutates source. |
| `mnSourceCode` | Read-only source view | Empty with helper text | Text selection, copy, scroll; render syntax markup safely, no untrusted HTML injection. |
| `mnOutputCode` | Read-only result view | Placeholder | Disabled or explicitly marked “No result” until processing succeeds. |
| `mnMetrics` | Metrics table | Source counts may load before optimization | Rows: Tokens (primary), Characters, Compressed bytes (when supported); Before, After, Saved, % reduction. |
| `mnDiagnostics` | Collapsible diagnostic region | Collapsed when empty | Filter by Error / Warning / Info; plain text and optional file:line targets. |
| `mnCopy` | **Copy optimized Lua** | Disabled until current successful result | Copy generated Lua; explicitly say when clipboard is unavailable. |
| `mnDownload` | **Download…** | Disabled until current successful result | `.lua`, `.p8`; `.p8.png` only if validated and available. Save as separate file by default. |
| `mnReturn` | **Back to Code Editor** | Shown for Code Editor provenance | Returns without modification; optional Apply is a separate later enhancement. |
| `mnAdvanced` | **Advanced settings** disclosure | Collapsed | Show read-only derived options and supported toggles, not an arbitrary command shell. |
| `mnTour` | **Tour this tool** | Enabled | Invoke existing tour infrastructure, not a separate walkthrough implementation. |

Disable buttons using real `disabled` state, with visible explanatory text where needed. Tooltip content comes from shared help registry and is never the only explanation of an important restriction.

## 5. Precise default Shrinko8 configuration

**Pinned v1 preset**: `profile: 'minimal'`, `target: 'tokens'`.

The upstream Shrinko8 web interface defines Minimal as:

```text
--minify-safe-only --no-minify-rename --no-minify-lines
```

The chosen optimization target appends:

```text
--focus-tokens
```

So the v1 baseline command-equivalent is:

```text
--minify-safe-only --no-minify-rename --no-minify-lines --focus-tokens
```

**Additional Suite safety rule:** disable unsupported/custom compiler transforms for the initial release, preferably via a verified `--no-minify-transform` engine option. If compilation hints (`--$switch-compiler:`, `--$dynamic-include:`) or unsupported custom directives require transformation, show an explicit unsupported-source diagnostic rather than silently producing a non-working build. Test this behavior with actual Shrinko8 input. If engine invocation is via its Python library API, map these flags to the corresponding validated library arguments; do not pass a shell command string into a browser worker.

**What “Minimal” promises:** no identifier renaming, no removal of line breaks, and Shrinko8's safe-only transformation policy. It **does not** promise unchanged comments, unchanged spacing, unchanged token stream, or verified runtime equivalence. Token-focused minification may reduce tokens by folding constant expressions, removing dispensable syntax, or merging statements where permitted. It may achieve no token reduction. Always display both the mode and its limitations in the UI.

**Profile explanatory copy:** “Minimal keeps variable names and line breaks to make the result easier to debug. It may still change expressions, comments, and spacing. Focusing on tokens may leave character or compressed size unchanged—or increase them.”

**Advanced Settings v1:** expose “Keep comments” only after validating exact compatibility with current Shrinko8; the default is **off**, and the UI must explain that comment removal can affect build directives. Preserve source control comments in the *original*, never alter them silently. Do not expose arbitrary command-line input, custom Python scripts, or compiler plug-ins in v1.

## 6. Metrics and meaning

Always calculate **before** and **after** using the same validated measurement engine and the same resolved include set. Show differences only when the comparison scope is identical.

- **Tokens:** primary number, displayed as e.g. `6,800 → 6,640`, `160 saved`, `2.35% reduction`. Source of truth: PICO-8-aware Shrinko8 token counter. The Suite's Code Editor estimator can provide a preliminary count but must be labeled *Estimate* when compared to definitive engine output.
- **Characters:** raw PICO-8 code characters, using Shrinko8's cartridge semantics. Never compare an unexpanded include file against expanded output as if they were the same unit.
- **Compressed bytes:** show only if calculated by the compatible Shrinko8 code compressor; distinguish the compressed code count from whole `.p8.png` file size. Use `—` and explanation if unavailable.
- **Limits:** show token budget `8,192` and character budget `65,535` where applicable; use version-appropriate compression limits only after validation, not an invented generic threshold. Show `Over limit` separately per metric.
- **Saved:** `before - after`; `percentage = saved / before * 100` for `before > 0`. For no change show `0 (0%)`, for a larger output show `+N / Increased`, and for no baseline show `—`.
- Use tabular numbers, non-color indications, and no forced “green” styling if tokens increased.

No precomputed sample improvements or marketing claims may appear in the real metrics area.

## 7. Critical user journeys

### A. Standalone cartridge

1. Open `#minifier` → empty state says “Open a PICO-8 cartridge or Lua file to start.”
2. User chooses `mydemo.p8` → original code appears; original cart bytes are retained in an immutable snapshot.
3. Controls display `Minimal` and `Tokens` by default; secondary description explains the expected trade-off.
4. Click **Optimize** → engine state changes to `Processing…`; result actions disable; optional indeterminate progress appears only during real work.
5. On success → show immutable generated output, before/after metrics and applicable diagnostic warnings.
6. Click **Download → PICO-8 cartridge (.p8)** → export `mydemo.min.p8`, preserving original cart sections. Clipboard action copies Lua only, not a whole `.p8`.
7. The original source remains unchanged; opening new input warns only if there is work not otherwise recoverable.

### B. Code Editor → Minifier

1. In the Code Editor, choose **Minify…**.
2. Construct a snapshot from the current unsaved buffer, associated cartridge sections, source filename and accessible includes. No forced save.
3. Open Minifier with a provenance label `From Code Editor • Unsaved changes` when appropriate.
4. Optimize and export a new file. **Back to Code Editor** restores the editing context unchanged.
5. If the source changed since launch, label the Minifier output as based on an earlier snapshot. Never overwrite the newer editor buffer or claim it includes later edits.

### C. Project source with includes

1. Enumerate actual includes via the current Suite's `P8Code` / `P8Audit` include model, then pass a relative-path file map to Shrinko8.
2. Preserve the entry cart, include-order semantics, tab includes (`.p8:N`), source version and paths as required by the engine.
3. On missing, ambiguous, cyclic, inaccessible, or unsupported includes: display the affected path and **do not** create an incomplete output.
4. If a project contains `--@data` anchor lines, generated cart source may no longer be valid as an editable Cart Builder source even when it is valid at runtime. Warn explicitly, retain original editable project, and label output `Optimized build copy`.
5. Do not offer Apply-to-Editor for include-dependent or anchored projects until lossless project-source round-trip semantics have been designed and tested.

### D. Input changed while a job runs

Increment a monotonically increasing `sourceRevision` on each input or option change. Output messages carry `jobId`, `sourceRevision`, and `optionsRevision`. The UI rejects stale results. During a running job the status should identify processing of the earlier snapshot; a later edit causes the output to become **Stale**, not silently update.

## 8. State machine and feedback

| State | Message | Optimize | Output/export |
| --- | --- | --- | --- |
| `empty` | “Open a cartridge or paste Lua to start.” | Disabled | No result |
| `loading-engine` | “Loading minifier engine…” | Disabled | No result; engine assets are loaded lazily |
| `ready` | “Ready to optimize.” | Enabled | No current result |
| `running` | “Optimizing tokens…” | Disabled | Cancel available; old result visibly marked Stale |
| `success` | “Optimization complete.” | Enabled | Current result enabled; show truthful counters |
| `unchanged` | “No token savings found in Minimal mode.” | Enabled | Valid result enabled |
| `stale` | “Options or input changed. Optimize again.” | Enabled | Old output may be inspected but cannot be exported as current without explicit stale labeling/confirmation; preferably disable export |
| `cancelled` | “Optimization cancelled. Original source unchanged.” | Enabled after worker reset | No new result |
| `error` | “Optimization failed: [specific cause]. Original source unchanged.” | Retry after recovery | No new result; diagnostics available |
| `unsupported` | “This input requires an unsupported transform or missing include.” | Disabled until corrected | No result |

The app must acknowledge user commands immediately, even while the worker starts. Do not display fabricated percentage progress; use `progress.progress` indeterminate unless the engine provides measured phases or deterministically scoped progress. Never show success before a complete response and validation.

## 9. Error, privacy and integrity contracts

- **Source validation:** no silent truncation; reject non-PICO-8 input, malformed section delimiters, parse errors and unsupported file formats with an actionable location/description.
- **Data preservation:** `.p8` export must round-trip non-Lua sections (graphics, map, flags, sound, music, label and other supported sections) unchanged at the semantic/byte level appropriate to the format. Compare against the original cart. Reject output on mismatches.
- **File handling:** local input and in-memory buffers remain local. Do not fetch user source to an external server. External engine assets should be vendored/pinned so successful hosted operation does not depend on a third-party CDN.
- **Output:** default `originalname.min.p8` or `originalname.min.lua`. The browser Download operation is a generated copy, not an in-place “Saved” state. If file writes are added later, use the Suite's conflict-aware, permission-rechecking flows.
- **Build directives:** do not assume ordinary comments are disposable to project tools; detect `--@data` and other known project directives. Never silently apply optimized source to the project authoring file.
- **Diagnostics:** support `error/warn/info`, a stable error code, optional `file:line:column`, and a human-readable recovery action. Add detailed technical failures to the Suite's existing diagnostics infrastructure, without logging full private code by default.
- **Engine failure:** expose Retry; terminate/recreate the worker if stuck; cancel and recover without losing source or options. Offline/blocked asset loading gets a clear local-hosting/retry hint.
- **Compiler/license:** omit Parens-8 integration initially. Retain Shrinko8 MIT notice and other dependency license/attribution files. Reevaluate licensing when enabling optional integrations.

## 10. Keyboard, accessibility and UX behavior

- Standard buttons use `button.btn`, primary action `btn-primary`, and busy semantics (`aria-busy`) from `docs/DESIGN_SYSTEM.md`.
- Profile group uses `.seg[role=radiogroup] > button[role=radio][aria-checked]` or genuine native radios and follows the shell's roving-focus behavior; do not implement competing arrow-key handlers.
- Code views are selectable and scrollable with a visible focus target, accessible label (e.g. “Original PICO-8 Lua, read only”), and keyboard copy capability.
- Navigation order: source → profile → target → Optimize → comparison mode → code views → metrics → diagnostics → output actions. On completion, announce status without stealing focus.
- On opening the Minifier from Code Editor, focus the workspace heading or Optimize button only when a ready snapshot exists, without overwriting Code Editor selection.
- Esc closes modal or tour in accordance with the shell, not the entire workspace. If a cancel shortcut exists, it must not interfere with editor typing.
- Do not introduce Ctrl+R/Ctrl+S shortcuts that conflict with the Code Editor. Optional `Ctrl+Enter` to Optimize may be added only after testing focus and active-workspace shortcut scoping.
- All buttons have visible text or explicit accessible names; high contrast and forced-colors mode must remain usable. Status must never rely only on color.
- Offer `data-help-id` content through `P8Help` and tooltips via existing `P8Tips`; optional help text respects user preferences, essential warnings do not.
- Honor reduced motion. Avoid forced scrolling when validation errors occur; link diagnostics to offending source lines where reliable.
- Follow WCAG 2.2 AA intent for contrast, focus and pointer target size; perform actual keyboard and screen-reader smoke tests.

## 11. Help and quick tour

Register a `minifier` help topic in `js/help-data.js` with purpose, input formats, modes, token focus, copying versus downloading, data preservation, limitations and troubleshooting. Include a concise F1 section and links to the upstream README and pinned engine version.

Add a `P8Tours` tool tour in `js/tours-data.js` (via documented registry) with stable targets, `ws: 'minifier'`, `scope: 'tool'`, `major: 1` and 6–8 steps:

1. **Source** — import or receive code.
2. **Profile** — Minimal default and safety trade-off.
3. **Target** — Tokens versus other measures.
4. **Optimize** — explicit processing, cancel and error recovery.
5. **Comparison** — source and generated output are read-only.
6. **Metrics** — zero savings is a valid outcome.
7. **Diagnostics** — warnings and include-resolution failures.
8. **Export** — generated copy; original remains untouched.

Steps should describe areas, not merely narrate button labels. Use stable selectors, skip elements genuinely hidden on smaller viewports, do not change project files in the tour, and allow `Help → Tour this tool` to replay it.

## 12. Engineering modules and boundaries

Suggested changes (final names can follow repository conventions):

```text
Pico8_Suite/
  index.html                           # nav control, workspace, actions and help wiring
  css/minifier.css                     # workspace-only layout; shared tokens
  js/minifier-core.js                  # pure state, metrics, option validation, export names
  js/minifier-engine.js                # promise-based adapter, version and worker lifecycle
  js/minifier-worker.js                # Pyodide + pinned Shrinko8, virtual file tree
  js/minifier.js                       # DOM, events, status, Code Editor handoff
  js/code.js                           # one menu action + explicit snapshot producer
  js/help-data.js                      # canonical help
  js/tours-data.js                     # tool quick tour
  vendor/shrinko8/                     # pinned source/distribution and MIT attribution
  vendor/pyodide/                      # pinned browser runtime/assets + licenses
  tests/minifier-core.test.js          # pure unit tests
  tests/minifier-integration.test.js   # worker/engine and fixture contract (as practical)
  docs/MINIFIER.md                     # user, developer and build documentation
```

**No full page embedding**, `<iframe>` or remote Shrinko8 site dependency. The engine is a replaceable implementation detail behind one local interface. Keep existing `index.html` script order and no-build/standalone convention. Loading the Minifier may require HTTP(S) or localhost because worker/WebAssembly asset loading is unreliable under `file://`; detect and report this clearly without breaking other Suite tools.

### Proposed in-memory request/response contract

```ts
type Profile = 'minimal' | 'safe' | 'aggressive';
type Target = 'tokens' | 'chars' | 'compressed' | 'balanced';
type MinifyRequest = {
  jobId: number;
  sourceRevision: number;
  optionsRevision: number;
  entryPath: string;               // normalized relative path
  files: Array<{ path: string; text: string }>;
  kind: 'p8' | 'lua';
  profile: Profile;                 // default minimal
  target: Target;                   // default tokens
  allowCustomTransforms: false;    // v1 hard-disabled
};
type MinifyResponse = {
  jobId: number;
  sourceRevision: number;
  optionsRevision: number;
  engineVersion: string;
  outputText: string;              // generated lua/p8 as requested
  generatedCart?: string;         // complete .p8 after verification
  stats: {
    before: { tokens: number; chars: number; compressedBytes?: number };
    after: { tokens: number; chars: number; compressedBytes?: number };
  };
  diagnostics: Array<{
    severity: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    file?: string;
    line?: number;
    column?: number;
  }>;
};
```

The worker should never receive live DOM objects or browser handles. For a `.p8`, retain raw original sections to verify preservation; generate/validate complete cart output inside the adapter. Source and options revisions prevent late responses from overwriting current state. Ensure the worker returns serializable data only.

### Key contracts with existing code

- `P8App`: workspace selection, action dispatch, shortcuts and dialogs.
- `Suite.registerTool`: Home and search discovery.
- `P8Code`: cart section splitting, lexical hints and editor snapshot.
- `P8Audit`: include path resolution and counts (provisional, with clear labeling).
- `P8Help` / `P8Tours`: contextual documentation and orientation.
- `P8DocStatus` principles: do not confuse source identity, browser snapshot, download and true save. Minifier is a derived-results tool, so it need not represent generated copies as saved source documents.

No direct mutation of Code Editor private `ed` state from `minifier.js`. Expose a narrow snapshot API or event with an immutable copy of the source, its identity, and accessible dependency file texts.

## 13. Original acceptance checklist — historical design requirements

The unchecked boxes below retain the original design checklist. They do not indicate that the shipped Minifier is absent. Current implemented behavior, deferred details and actual verification are distinguished in the status table and linked records above; for example, syntax-aware comparison and native screen-reader/other-browser testing must not be marked passed based on the representative-cart checks.

### User-visible behavior

- [ ] Navigation shows **Minifier** in Develop between Code Editor and Cart Builder; Home, Find Tool and `#minifier` work.
- [ ] Default controls consistently show **Minimal** and **Tokens**, including fresh browser sessions and restored options; choices are labeled and keyboard-operable.
- [ ] Minimal maps to upstream `--minify-safe-only --no-minify-rename --no-minify-lines`; token target maps to `--focus-tokens`; additional transform restrictions are validated.
- [ ] Source loading works from `.p8`, `.lua`, paste, and current **unsaved** Code Editor snapshot.
- [ ] Optimize shows correct pending, processing, cancelled, error and final states. No invented progress percentages or savings.
- [ ] Before/after counters are generated from comparable source scopes; a 0-token improvement displays `0 (0%)` and may still download a valid result.
- [ ] Source and output can be inspected and copied without altering original code; download uses a distinct filename by default.
- [ ] Missing includes, unsupported transforms, invalid cartridges, inaccessible paths and stale results are clearly reported; invalid outputs are not exportable.
- [ ] Known project anchor comments trigger a clear authoring-vs-build-artifact notice.
- [ ] The comparison is usable at desktop, tablet and phone widths without page-level sideways scrolling.
- [ ] Help and Quick Tour work on this tool, cover its areas and can be dismissed without mutation.

### Engineering / release safety

- [ ] Engine is pinned with license notices and reproducible asset packaging; no network transmission of user source.
- [ ] Worker crashes/cancellation do not lose input, block the main app, or make unrelated tools unavailable.
- [ ] `file://` unsupported worker loading is surfaced with a working localhost instruction; other Suite features continue to work.
- [ ] Unit tests cover options serialization, counts/delta formatting, zero/increase cases, revision races, export naming and error states.
- [ ] Integration fixtures include standard `.p8`, `.lua`, PICO-8 shorthand, code tabs, P8SCII, comments, dynamic table keys, project directives and nested/missing/cyclic includes.
- [ ] Round-trip tests verify `.p8` non-Lua sections after minification; any mismatch blocks export.
- [ ] A test with deliberately failing or delayed worker cannot publish stale data or false success.
- [ ] Manual Chrome/Edge checks verify keyboard focus, screen-reader labels, storage/permission failures, responsive behavior and local-hosting setup.
- [ ] At least one representative generated `.p8` is launched successfully in real PICO-8; do not state broad runtime equivalence from one fixture.
- [ ] Update README, EXTENDING.md if any public interface changes, help registry, tour registry, relevant docs and focused CI checks in the feature PR.

## 14. Original suggested implementation work packages — historical

**MIN-01: Engine feasibility and packaging (P0).** Pin Shrinko8/Pyodide, run one minimal/token fixture entirely in a worker, document sizes, cold-load and file-protocol limitations. Acceptance: deterministic output, no external source uploads and clear failure path. This package precedes UI integration.

**MIN-02: Pure state and engine adapter (P0).** Implement request/result schemas, flag mapping, revision handling, cancellation, metrics and diagnostic mapping. Acceptance: Node-level tests with fake worker; no DOM dependencies in core.

**MIN-03: Workspace shell and navigation (P1).** Add workspace, top controls, comparison, metrics and responsive CSS using existing tokens. Acceptance: both themes, keyboard navigation and no console errors; driven by mock adapter first.

**MIN-04: Code Editor handoff and include resolution (P1).** Capture dirty editor state and folder dependency texts without forcing save; missing includes stop export. Acceptance: original buffer and project untouched after cancel, errors or download.

**MIN-05: Artifact verification and export (P1).** Complete `.p8` round-trip, file naming, copy/download, anchor warnings, stale rejection. Acceptance: non-Lua sections verified, invalid artifacts cannot leave the tool.

**MIN-06: Help, tour, docs and QA (P1).** Register help and tour; update user docs and tests. Acceptance: tool fully discoverable; both user guide and implementation notes reflect default Minimal + Tokens; focused real-browser validation.

## 15. Traceability and open engineering questions

**Verified upstream controls:** Minimal Minification in Shrinko8's web UI maps to `--minify-safe-only --no-minify-rename --no-minify-lines`; `--focus-tokens` is an independent optimization target. The `--no-minify-transform` option is available in current Shrinko8; verify the desired behavior against fixtures. **Do not claim that Minimal is only comment/space removal.**

**Original MIN-01 investigation questions (historical):** whether the packaged Pyodide runtime can efficiently handle `.p8.png` without shipping optional large dependencies; precise file-handling mode and version used for invoking Shrinko8 as a Python library; and whether include/cycle behavior can use the same in-memory file map on all supported browsers. Do not block the entire v1 UI on optional PNG export. The resolved engine/library and include contracts are documented in [MINIFIER_ENGINE.md](MINIFIER_ENGINE.md); the lightweight PNG path and its verified dependencies are documented in [MINIFIER_PNG.md](MINIFIER_PNG.md).

**References:**
- Suite repository: https://github.com/Crylhead/Pico8_Suite
- Suite design system: https://github.com/Crylhead/Pico8_Suite/blob/main/docs/DESIGN_SYSTEM.md
- Suite extension contract: https://github.com/Crylhead/Pico8_Suite/blob/main/EXTENDING.md
- Suite UX roadmap: https://github.com/Crylhead/Pico8_Suite/blob/main/docs/UX_DEVELOPMENT_PLAN.md
- Shrinko8 repository and documented flags: https://github.com/thisismypassport/shrinko8
- Shrinko8 web implementation: https://github.com/thisismypassport/shrinko8/blob/main/site/index.html
- Shrinko8 worker: https://github.com/thisismypassport/shrinko8/blob/main/site/worker.js
- WAI-ARIA authoring patterns: https://www.w3.org/WAI/ARIA/apg/patterns/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- NN/g progressive disclosure: https://www.nngroup.com/articles/progressive-disclosure/


## 16. Minifier icon — design and integration contract

![Proposed Minifier icon](../assets/icons/minifier.svg)

**Source file:** `assets/icons/minifier.svg` (vector source of truth). **Concept:** two inward-facing chevrons represent compression; three short horizontal lines in the center represent condensed Lua code. The symbol must remain distinct from the Code Editor's outward-facing code chevrons and Cart Builder's cartridge symbol.

| Property | Specification |
| --- | --- |
| Coordinate system | SVG `viewBox="0 0 20 20"`; intrinsic size 20 × 20 px |
| Layout | Symmetric horizontal compression mark, centered on (10,10), with minimum 2.5-unit outer margin |
| Drawing | Three open paths; no raster layers, external images, text fonts, scripts, gradients, filters or network assets |
| Style | `fill="none"`, `stroke="currentColor"`, `stroke-width="1.6"`, rounded caps and joins |
| States | Inherit the workspace tab's foreground for normal, selected, hover, focus and disabled states; never hardcode an accent within the SVG |
| Accessibility | Workspace tab button has accessible name `Minifier`; inline SVG is `aria-hidden="true"` and must not be the only label |
| Location | Develop navigation, after Code Editor and before Cart Builder; matching Home/Find Tool identity |
| Variants | No separately maintained dark/light SVG files; the same shape works in both themes |

**Embedding:** For the Suite's existing icon-based workspace navigation, copy the markup from `assets/icons/minifier.svg` into the workspace tab's inline `<svg viewBox="0 0 20 20" aria-hidden="true">` element, retaining the path geometry and inheriting `currentColor`. Do **not** use an external `<img src="...">` for theme-dependent foreground color: `currentColor` in an external SVG does not reliably inherit its host element's CSS color. As an alternative, use the SVG file as a CSS mask and style the mask with `currentColor`.

**Minimum acceptance checks:** render at 20 × 20 CSS pixels at 100%, 125%, and 200% browser zoom; verify visible shape in dark and light themes and high-contrast/forced-colors mode; confirm the `Minifier` accessible name is announced once; ensure adding the icon does not change existing workspace icons or render a non-functional Minifier tab before the tool is implemented. Asset validation may be performed independently of a functional workspace.

The approved icon is installed inline by MIN-03 in the native Minifier tab. Its path geometry, inherited theme color and single accessible name follow this contract. The shipped MIN-01–MIN-11 workflow and its verification are summarized in the current-status section above; deferred design details remain explicitly identified there.

---

**Delivery rule:** this specification is a design and implementation contract. It is not evidence that the UI, engine or generated carts have been tested or merged.
