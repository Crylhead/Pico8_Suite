# Adding a tool to the suite

A tool is a workspace (`<main data-ws="...">`) plus a script that registers itself with `window.Suite` and `window.P8App`. Data Tools (`js/datatools.js`) is a small, complete example.

## 1. Markup (`index.html`)

```html
<!-- tab (in #wsTabs): a 20×20 icon; the shell adds the visible name on wide screens. Place it near the tools of its category; registerTool re-sorts the bar by category. -->
<button role="radio" data-value="mytool" aria-checked="false" title="My Tool" aria-label="My Tool"><svg viewBox="0 0 20 20" aria-hidden="true">…</svg></button>

<!-- workspace -->
<main class="layout-mytool" data-ws="mytool" hidden> … </main>

<!-- optional menu, only visible in this workspace -->
<div class="menu" data-show="mytool"> … <button role="menuitem" data-action="mytool-export">Export…</button> </div>
```

Every element with `data-show="ws1 ws2"` is hidden outside the listed workspaces. Load the script after `js/suite.js`.

### Keyboard and accessibility contract

The shell provides keyboard behavior for standard markup; use it instead of custom key handling (details and the manual regression script: [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md)):

- **Option groups:** `role="radiogroup"` (with an `aria-label`) containing `role="radio"` buttons with `aria-checked`. Select in a `click` listener and update `aria-checked`. The shell maintains the roving tabindex and Arrow/Home/End keys, including for groups created later.
- **Menus:** `.menu` > `.menu-btn` (`aria-haspopup="menu"`) + `.menu-pop[role=menu]` with `role="menuitem"` buttons. Keyboard handling and focus return are automatic.
- **Dialogs:** use `App.modal({ title, body, buttons, alert })` / `App.showMessage(title, msg, 'error')`. The title names the dialog, and focus returns to the opener. Pass `alert: true` (or a `danger` button) for warnings, errors and destructive confirmations.
- **Shortcuts:** `App.registerShortcuts(ws, handler)` does not receive `Enter`/`Space` aimed at a keyboard-focused button, checkbox, link, select or menu/radio item, nor arrow keys inside an option group or open menu.
- Every icon-only control needs an `aria-label`. Never rely on color or `title` (hover) alone for state, warnings or errors.

## 2. Script

```js
(() => {
  const App = window.P8App;
  const S = window.Suite;
  const element = document.querySelector('[data-ws="mytool"]');

  function load(asset) { /* Copy the accepted data into this tool's model. */ }
  async function exportSomething() { /* Prepare and download the tool's result. */ }
  async function pickImage() {
    const asset = await S.pickAsset({ title: 'Choose an image', kind: 'image' });
    if (asset) load(asset);
  }

  S.registerTool({ ws: 'mytool', name: 'My Tool', desc: 'What it does.', color: '#ff77a8', tags: ['image'], category: 'create' });
  App.registerActions({ 'mytool-export': exportSomething, 'mytool-pick': pickImage });
  App.registerShortcuts('mytool', (e, typing) => { /* Ignore typing unless handling an editor shortcut. */ });

  S.registerConsumer({
    id: 'mytool', label: 'My Tool', kinds: ['image'],
    accepts: (a) => a.w <= 128 ? true : 'Needs 128 px or less',
    open: async (a) => {
      // Confirm replacing unsaved work here, before mutating this tool or shared state.
      App.setWorkspace('mytool');
      load(a);
    },
  });
  S.bindAssetDrop(element, (asset) => S.openIn('mytool', asset));
  document.addEventListener('p8:assets', (e) => { /* e.detail: {type, id, remote} */ });
})();
```

### Navigation metadata

`registerTool` feeds the workspace bar, Home and **Find tool** (<kbd>Ctrl</kbd>+<kbd>K</kbd>), via `js/nav-core.js` (`P8Nav`):

- `name` and `desc` are what users search; write `desc` as a task ("count tokens", "pack data carts"). `tags` are extra search words and appear on the Home card.
- `category` is `'create'`, `'develop'`, `'inspect'` or `'utilities'`. It only groups the tool (bar order, Home section, Find tool heading); IDs, deep links and shortcuts do not depend on it. A missing or unknown category falls back to **Utilities**, so the tool is always listed.
- A part of a workspace can register too: `S.registerTool({ ws: 'mytool', sub: 'part', name, desc, category })` lists it in Find tool (not on Home) and opens it with `App.setWorkspace('mytool', { sub: 'part' })`; the `p8:workspace` event carries `{ ws, sub }`. Call `App.setRoute('mytool', 'part')` when the user switches parts, so the address `#mytool/part` stays a working deep link. Extra Tools does this for its tabs.

Publish an indexed image with `await S.assets.put(S.imageAsset({ name, w, h, pixels, pal, transparent: 0, source: 'mytool' }))`, or a palette with `S.paletteAsset({ name, colors })`, inside an async action. Await `S.assets.ready` before reading startup Library data. Consumers must guard unsaved target work themselves; the registry does not do this automatically.

### Storage outcomes

`S.assets.put`, `remove`, `rename` and `S.kv.set` resolve only after the IndexedDB transaction has committed. Any failure (quota exceeded, `DataCloneError`, an aborted transaction, a closed connection or a synchronous throw) **rejects** with an `S.StorageError` (`op`, `reason`: `'quota' | 'clone' | 'abort' | 'closed' | 'error'`, `cause`). A rejected write leaves the Library cache and the previously stored record unchanged and emits no `p8:assets` event. `S.kv.get` also rejects when it cannot read, instead of looking empty. Only mark work as saved after the promise resolves; on rejection keep it dirty and report the failure:

```js
const stored = await S.assets.put(asset).catch((e) => S.reportStorageError('Save to Library', e));
if (!stored) return; // still dirty: the user can free space and retry, or export instead
dirty = false;
```

Background session saves use `S.kv.set(key, value).catch(S.autosaveFailed('My Tool session'))`, which shows one toast until a session save succeeds again.

When IndexedDB cannot be opened at startup the suite runs an explicit **memory-only session**: writes succeed in memory, `S.assets.persistent()` is `false` and `S.assets.mode()` is `'memory'`; the suite shows a warning and the Library labels it. A write that fails while IndexedDB is open never falls back to memory.

### UX preferences

`js/ux-prefs-core.js` (`P8Prefs`) holds the user's display/help choices in one schema-versioned `localStorage` record (`p8suite.uxPrefs`); the shell exposes the instance as `P8App.prefs` and edits it in **Help › Settings…** (`P8App.showSettings()`). Invalid or corrupt fields fall back to their defaults one by one, fields from a newer schema version survive a write, and blocked storage never throws (`prefs.status().persistent === false`; the preference still applies for the page). Only these choices are stored, no identifiers or telemetry.

| Field | Values (first = default) | Effect |
| --- | --- | --- |
| `helpLevel` | `concise`, `off`, `detailed` | `<html data-help-level>`; elements with `.help-optional` hide at `off`, `.help-detailed` show only at `detailed` |
| `autoOfferTours` | `true`, `false` | for onboarding tours (#61): never auto-offer when `false`; replaying stays available |
| `compactNav` | `false`, `true` | `<html data-compact-nav>` hides the workspace name box |
| `motion` | `system`, `reduce` | `<html data-motion>`; `P8App.reducedMotion()` is also true when the OS asks for reduced motion |

```js
P8App.prefs.get().helpLevel;                       // read (a copy)
P8App.prefs.set({ helpLevel: 'off' });             // → { changed: ['helpLevel'], saved: true }; invalid values throw TypeError
document.addEventListener('p8:preferences', (e) => { /* e.detail: { prefs, changed, saved } */ });
el.scrollIntoView({ behavior: P8App.reducedMotion() ? 'auto' : 'smooth' });
```

Use `.help-optional` / `.help-detailed` only for purely explanatory text. Never put labels, accessible names, warnings, errors, status or save feedback in them: those must stay visible at every help level. A new field needs a `SCHEMA` entry whose first value reproduces the previous behaviour, a Settings control, documentation here and in the F1 help, and (for an incompatible change) a `VERSION` bump with a `MIGRATIONS` step. Tests: `tests/ux-prefs.test.js`.

### Document save status

`js/doc-status-core.js` (`P8DocStatus`) is the shared save/operation state contract (#58). It tracks one open document and shows a badge with an icon and text for each state: not saved, unsaved, saving, saved (Library/file/project), downloaded copy, memory-only, failed, conflict. Use it instead of a plain `dirty` flag. The Map Editor (`js/map.js`) is the reference adapter.

```js
const status = P8DocStatus.create({ storage: () => S.assets.mode() });
status.open({ name, target: assetId ? 'library' : null });         // new or opened document (dirty: true for a restored unsaved copy)
// on every edit: status.edit();   confirm discard with: status.dirty()

async function save() {
  if (status.pending()) return false;                               // re-entry guard
  const doc = status.doc(), ticket = status.begin('library', { name }); // take ticket and snapshot together
  const asset = buildAsset();
  try { await S.assets.put(asset); }
  catch (e) { status.reject(ticket, { message: e.message }); S.reportStorageError('Save to Library', e); return false; }
  if (status.doc() !== doc) return false;                           // another document was opened meanwhile
  status.resolve(ticket, { name: asset.name });                     // edits made during the save stay unsaved
  return true;
}

status.downloaded(fileName);                // a download is a copy, never a save
const tk = status.snapshot();               // background session write: not a save
S.kv.set(KEY, data).then(() => status.session(tk, true), (e) => status.session(tk, false));
status.conflict(message); status.lost(message); // Library copy changed / deleted elsewhere
P8DocStatus.mount(hostEl, status, { title: 'Map save status', onRetry: save });
addEventListener('beforeunload', (e) => { if (status.atRisk()) e.preventDefault(); });
```

Results for an older document or an older save ticket are ignored, and an error stays visible until a later save succeeds or the user dismisses it. Tests: `tests/doc-status.test.js`.

## UI tokens and primitives

Style new controls with the shared tokens and primitives from [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) (live reference: `docs/design-system.html`) instead of new colours, sizes or focus styles. Use `.btn`, `.seg[role=radiogroup]`, `label.field`, `.select`, `fieldset.panel-group` > `legend.panel-heading`, `p.status-line[data-tone]`, `.notice[data-tone]` and `progress.progress`. Express state with attributes: `aria-pressed`/`aria-checked` (selected), `aria-busy` (busy), `disabled`, `aria-invalid` + `aria-describedby` (error). Use `--status-error` for error text, because `--danger` is not text-safe. Keep tool-specific selectors under the tool's own prefix.

## Live palettes between tools

Besides the library, tools can offer what is open right now. `S.registerPaletteSource({ id, label, get })` publishes a palette; `get()` returns `{ pal, fades, name }` or `null`. Here `pal` holds 16 PICO-8 colors and `fades` is `{ dark, bright }`, each fade table in the Palette & Fades format or `null`. `S.paletteSources()` lists the sources and `S.paletteSource(id)` reads one. Palette & Fades (`palette`) and Pixel Studio (`studio`) register theirs, and Terrain Lab uses them for its PICO-8 view.

## Asset model

| Field | Image | Palette |
|---|---|---|
| `kind` | `'image'` | `'palette'` |
| data | `w`, `h`, `pixels` (Uint8Array of slots 0–15), `pal` (16 PICO-8 colors), `transparent` (slot or -1), optional `doc` (Pixel Studio layers/frames) | `colors` (16 entries, each a PICO-8 color or null) |
| common | `id`, `name`, `source`, `created`, `modified` | |

Map assets use `kind: 'map'`, `w`, `h`, `cells` (Uint8Array of tile IDs), `sheet` (128-pixel-wide slot pixels), `pal`, and optional `sheetId` / `sheetName`; see `js/map.js`. There is no generic map constructor in Suite.

Helpers: `S.assetImageData(a)` (RGBA), `S.assetCanvas(a)`, `S.thumbnail(a, size)`, `S.assetFromImageData(imageData, name, pal)` (nearest-color quantize), `S.imageAssetToPng(a)`.

For tool state that is too large for `localStorage`, use `S.kv.get(key)` / `S.kv.set(key, value)` (IndexedDB; failures reject as described under [Storage outcomes](#storage-outcomes)).

## Extra Tools and historical desktop tools

LUT Creator, Wave Designer, Line Tool and Project Audit were ported from Demotools. `filename_optimizer`, `rocket_optimizer`, the demo framework and its release builder are not bundled in this standalone repository.

A small tool that does not need its own workspace can go into Extra Tools. Either add it to `js/extras.js` (build its panel with the helpers at the top of the file, add it to the internal `tools` object and add a button in `#exTabs`), or keep it in its own file loaded before `js/extras.js` and register it; Terrain Lab (`js/terrain.js`) does this:

```js
(window.P8ExtraTools ||= []).push({
  id: 'mytool', label: 'My Tool', desc: 'One line under the tabs.',
  // helpers: slider, numberField, checkbox, select, btn, group, row, showCode, fitCanvas, isActive(), show()
  create(helpers) { return { panel, draw() {}, tick(dt) {}, key(e) { return false; } }; },
});
```

For registered plug-ins, Extra Tools adds the tab (with the next <kbd>Alt</kbd>+number), shows the panel and calls `draw()` when the tab opens or resizes, `tick(dt)` every frame while it is visible and `key(e)` for key presses (return `true` when handled). Optional `category` and `tags` (as in `registerTool`) place the plug-in in Find tool; without them it is listed under Utilities. Each Extra Tools tab gets the address `#extras/<id>`.


## Diagnostics and Report a problem

`js/diagnostics-core.js` (`P8Diag`, #62) keeps a bounded in-memory log (100 records) of sanitized error summaries: window `error`, `unhandledrejection`, Worker `error`/`messageerror` and explicit failures. Nothing is stored or transmitted; the log is lost when the tab closes and cannot capture a crashed tab or process. Tools report failures with `P8App.diagnostics.report(source, 'E_TOOL_ACTION', error, 'state')` (never pass project content in `state`; it is exported as plain words only) and attach workers with `P8App.diagnostics.watchWorker(worker, 'worker:name')`. **Help › Report a problem…** (#63) shows two editable previews: the text summary for copying and the diagnostics JSON for downloading; each action exports exactly its corresponding preview. `exportBundle()` defaults to `{ messages: 'redacted' }`: messages are reduced to the generic error vocabulary in `SAFE_WORDS` (`redactMessage`), so arbitrary error text cannot leave by default; `{ messages: 'sanitized' }` (the dialog's *Include full error messages* opt-in) exports the regex-scrubbed text. Only add generic words to `SAFE_WORDS`, never identifiers or names. The default bundle lists every field explicitly (#85): `code` from `report()` must match `E_UPPER_CASE` (else `E_APP`), runtime error names map to JavaScript/DOMException types or `OtherError`, `source` must be a plain tool id, and `stack` keeps only `file:line:col` of the Suite's own scripts (`appFiles`, no function names). The opt-in adds `detailCode` names and the scrubbed stack. In-memory `read()` keeps the scrubbed text for local UI. The user may open the GitHub form (`.github/ISSUE_TEMPLATE/bug_report.yml`); no diagnostics travel in the URL.

## Active project context

`js/project-context-core.js` (#55) is an optional, read-only reference to the active project folder, shown in the app bar as "Project: name" with its access state. It owns nothing: it writes no files, scans nothing and never opens a project by itself. Library-only and download workflows ignore it.

- Consumers: `P8App.projectContext.get()` → frozen `{ id, name, source, handle, access, message }`; `await check()` re-queries the handle (do this before relying on access; never assume an old `granted`); `subscribe(fn)` receives `{ type: 'select'|'replace'|'clear'|'access', project, previous }` once per change, also as the `p8:projectcontext` document event (`p8:project` is Project Audit's scan hand-off to Data Carts and unrelated).
- `access`: `granted`, `prompt` (reconnect needed), `denied`, `stale` (handle unusable, including a folder that was moved, renamed or deleted: with access granted the context reads one entry to prove the folder still exists), `unsupported` (name only, no handle API). Denied, revoked or stale handles never fall back to another folder.
- Tools that open a project call `P8App.projectContextPublisher.select({ name, source, handle })` (Cart Builder does) and `clear(source)`; only the publishing tool can clear its project. `reconnect()` must run in a user gesture.
- After a reload only `{ name, source, handle }` is remembered; the project returns as `prompt` until permission is verified. Adapters (#56) must still request/verify permission and handle external changes before any write. The indicator never means "saved".

## Help registry (F1)

`js/help-data.js` holds the canonical help content and `js/help-core.js` (`P8Help`) the lookup API; the older long-form text in `#docsTemplate` (index.html) stays available as **Help › Full documentation** until its content is migrated (`tests/help.test.js` lists the sections that are still full-documentation-only). F1 opens the focused `data-help-id` explanation, otherwise the selected subtool, otherwise the workspace. Search, the Help index, a return-to-context link and the full reference remain available. Clearing search returns to the topic being read.

- **A new tool must add a `kind: 'tool'` topic** whose `ws` equals its workspace id (purpose, inputs, outputs, key actions, restrictions, related topics, shortcuts) and bump `rev` when its behavior changes. The test fails for a workspace tab or `registerTool` entry without a topic, a dangling `related`/`legacy` reference or a duplicate id.
- Stable ids: topics (`code`), controls and actions (`code.run`). Renamed ids need an entry in `ALIASES` so tooltips (#60) and tours (#61) keep working.
- Extra Tools subtopics use `kind: 'guide'`, `ws: 'extras'`, and `sub` equal to the tab's stable ID. Keep one canonical workspace topic and unique control/action IDs; moving a control to a subtopic preserves its ID for tooltips and tours. Unregistered subtools fall back to the workspace topic.
- API: `P8Help.topic(id)`, `forWorkspace(ws, sub?)`, `control(controlId)` → `{ topic, control }`, `context({ topicId, controlId, ws, sub })` → `{ topic, controlId }`, `search(query)`, `toc()`. Explicit topic/control links take precedence over focused control, then subtool, then workspace. Do not scrape the DOM for help text.
- In the app: `P8App.runAction('docs')` opens Help, `docs-full` the long-form documentation.

## Explanatory tooltips

`js/ux-tooltips.js` (`P8Tips`, #60) shows optional tips for elements marked `data-help-id="<control id>"`. The text always comes from the help registry (`controls[]` / `actions[]` with `text`, optional `detail`); never write tooltip text in HTML or JS. Concise shows `text`, Detailed adds `detail` and a pointer to F1, Off shows nothing (**Help › Settings…**, applies without reload).

- Tips appear after a delay on mouse hover and on keyboard focus (also after a touch tap). They stay visible while the pointer is over the control, the tip or the gap connecting them, or while focus remains within the control. Escape (consumed only while a tip is visible), leaving both areas without focus, scrolling, window blur or a preference change dismisses them. Pointer coordinates provide hover persistence without intercepting canvas clicks; tips never take focus or pointer events. Dragging or painting suppresses them.
- A native `title` on a marked control that already has visible text or an `aria-label` is moved to `data-title-orig`, so the registry tip replaces it and Off applies consistently. Put essential information in a label, status text, error or warning, never only in a tip.
- Unknown ids do nothing. `tests/tooltips.test.js` fails if a `data-help-id` in `index.html` has no registry text.

## Quick tours

`js/tours-core.js` (engine, no DOM), `js/tours-data.js` (built-in tours) and `js/tours.js` (UI), #61. Tours are optional: a first-run welcome offers *Start tour* / *Explore independently* / *Never auto-offer* (only when `autoOfferTours` is on, help level is not Off, no dialog is open and the user is on Home). **Help › Tour this tool** starts the current workspace/subtool tour; if none exists it offers Help and the global chooser. **Help › Quick tours…** searches and replays available tours, showing progress and distinguishing the Suite overview. Explicit launches work when automatic offers are disabled. Esc, the close button or finishing ends a tour; the page is never blocked (no backdrop) and tours never write project data.

- Register a tour with `P8Tours.register({ id, title, summary, major, ws, sub?, scope?, steps })`; `ws` is the workspace ID, `sub` the Extra Tools tab ID and `scope: 'suite'` identifies the Suite overview (otherwise a tool tour). Current-tool matching reads this metadata on every launch, never a second tool inventory. The first exact workspace/subtool match is used; a subtool without a match does not start a different tool’s tour. Legacy/extensions may omit `ws` to appear only in the global list. Registration refreshes an open chooser. A tool without a tour remains usable. A step has a stable `id`, a `title`, `text` or a registry `helpId`, an optional `target` selector (stable id, class or `[data-help-id]`, never `nth-child`) and optional `before: { ws, click }` (switch workspace / tab only). A step whose target is missing or hidden is skipped; a tour with no usable step says so and ends.
- **Versioning:** bump `major` only for a meaningful new capability: users who finished or closed an older major keep their status and see "What's new" in the list, no forced replay. Copy or layout edits do not change `major`.
- Progress is a single local record (`p8suite.tours`: welcome choice and per-tour status/major); unavailable storage falls back to this page only.
- `tests/tours.test.js` fails for invalid metadata, an unknown `helpId`, or a selector id/class/ws that no longer exists in `index.html` or `js/`. When you rename or remove a marked control, update its tour steps in the same PR.

## Adding a tool: documentation obligations

A new workspace or tool must, in the same PR: add its help topic and shortcuts (`js/help-data.js`), use stable control ids, add an optional tour or none (never required: a tool without one registers fine), and update the long-form F1 text or note the parity gap. `tests/docs-integrity.test.js` enforces this offline with actionable messages; see [docs/UX_RELEASE_CHECKLIST.md](docs/UX_RELEASE_CHECKLIST.md) for the full list and the manual release acceptance plan.

## Resizable side panels

`js/panels-core.js` (model, persistence) and `js/panels.js` (UI), #64. Pixel Studio, Map Editor and Terrain Lab get a splitter and a hide/show button at the left edge of their side panel. The width is the CSS variable `--side-w` on the layout element (`.layout-studio`, `.layout-map`, `.tl-split`); the grid column reads `var(--side-w, <old width>)`, so the old width is the default and nothing changes without the script.

- Keyboard: focus the splitter (`role="separator"`, `aria-valuenow/min/max`), ArrowLeft/ArrowRight resize (Shift = 64 px, else 16), Home/End = narrowest/widest, Enter hides/shows, `0` or double-click resets. Settings › Reset to defaults also restores all panels.
- Bounds: at least the panel minimum and never so wide that the canvas drops below 320 px; the width is re-clamped on resize.
- Persistence: `p8suite.layout` (`{ v, panels: { id: { w, c } } }`); corrupt or out-of-range values fall back per panel; blocked storage only loses persistence.
- Narrow screens: at each layout's existing breakpoint (studio 860 px, map 900 px, terrain 1000 px) the layout stacks, splitter and toggle are hidden, a stored collapse is ignored and every control is reachable by scrolling. A hidden panel on desktop is `inert` and keeps its toggle.
- To add a panel: add an entry to `PANELS` in `js/panels.js`, use `var(--side-w, <default>)` in its grid, and give the layout `position: relative` via `.has-splitter` (added automatically).

## Long-running renders: preview / final status

`js/render-status-core.js` (`P8RenderStatus`, #67) describes what Terrain Lab's status badge may say; `js/terrain.js` feeds it and renders it. The render pipeline, algorithms and output bytes are unchanged.

| State | Meaning | Exports |
| --- | --- | --- |
| Queued | your latest edit has no result yet; the image shown is from before it and is marked stale (dashed frame) | off |
| Preview | a fast low-resolution result of the latest edit is shown | off |
| Preview · rendering final… | that preview is current, the full-resolution render runs | off |
| Final | full-resolution result of the latest edit | **on** |
| Stale | the image is older than the latest edit and nothing is running (use Retry) | off |
| Render failed | worker or render error with an Error ID (also in Help › Report a problem) and a **Retry** that replaces both workers and renders the latest edit again; edits are kept | off |

A result for an older revision is dropped, never shown as current. Every edit updates the badge synchronously before the preview job is sent. No progress percentages are shown or invented. Another long-running tool can reuse `describe()` with its own revision counters and `errorText()`; `diagnostics.watchWorker(worker, source, onRecord)` gives the Error ID.

`window.P8TerrainDebug` (`state()`, `changed()`, `retry()`, `ackSamples`, `ackSummary()`) is for manual measurement only; nothing is sent anywhere.

## Home launcher

`js/home-core.js` (`P8Home`, #68) builds Home from the tool registry: **Continue** (the last tool other than Home, key `p8pal.lastTool`, plus the optional active project), **What do you want to do?** (task shortcuts grouped Create / Edit / Import / Analyze) and **All tools** (cards). A tool adds shortcuts with `tasks: [{ group, label, hint, open?: { click } }]` in `Suite.registerTool`; `open.click` selects a tab inside the tool (Terrain Lab does). A tool without `tasks` only gets its card; an unknown `group` falls back to Edit.

- A shortcut only switches workspace (and selects the named tab); it never opens a folder or replaces another tool's work.
- A remembered project shows as **Reconnect** (the click is the permission request); granted = **Continue project**; denied, revoked, missing and name-only projects show an explanation and no action. No project: the text says how to open one.
- The storage notice says the Library and tool sessions are browser-only; when IndexedDB is unavailable (`assets.mode() === 'memory'`) it becomes a warning.
- `tests/home.test.js` fails for a task group that does not exist and when one of the six first-run tasks (pixel art, palette, terrain, code, audit, packing) is missing.

## Minifier jobs

`js/minifier-core.js` (`P8MinifierCore`) is a DOM-free immutable model; `js/minifier-engine.js` (`P8MinifierEngine.create()`) adapts it to the real local worker from `js/minifier-worker-host.js`. See [the engine and adapter contract](docs/MINIFIER_ENGINE.md#shared-model-and-adapter--min-02) for script order, API, errors and state semantics. The native workspace in `js/minifier.js` / `css/minifier.css` uses this adapter; first entry initializes the engine, never optimizes. Its tab, Home card, Find tool entry and `#minifier` route come from the shared registry.

Use `setSource({kind, entryPath, files:[{path,text}]})` with plain snapshots, `setOptions({profile, target})` with named presets, and only call `optimize()` for an explicit user action. Await `initialize()` and use `P8MinifierCore.describe(state).canOptimize` to enable controls. Every source/options change invalidates current output immediately; `canExport` checks source/options/job identity but the future export layer must also validate cart content. Never infer readiness from script presence or reimplement revision guards in the UI. Cancel pending work on teardown and `dispose()` when the owner goes away; `retry()` only initializes a fresh worker, so it cannot resubmit source implicitly.

For handoff, call `Suite.minifier.load(snapshot, {provenance})` to copy a source into the existing workspace; `provenance` is `Local file`, `Pasted Lua`, `Code Editor`, `Project folder` or the default `In-memory source`. This validates text/cart structure but does not navigate, initialize or optimize. The handoff owner obtains replacement consent before calling it and chooses when to navigate with `P8App.setWorkspace('minifier')`. `getState()`, `initialize()`, `cancel()`, `setMode('compare'|'original'|'optimized')` and terminal `dispose()` are available on the same presenter. Source/results are page-session only; switching tools cancels pending intake/work and retains stale output for inspection. A default view follows the desktop breakpoint until the user explicitly chooses a mode, then resizing preserves that choice. The shell owns option-group arrow keys; do not add another handler.

MIN-04 Open/Paste actions use `P8App.pickFile`, `modal` and `confirmDialog`. Reads use strict UTF-8 decoding; cartridge boundaries and code tabs reuse `P8Code.splitCart` / `codeTabs`. `P8MinifierCore.textInput(name,text)` / `prepareInput(snapshot)` return a frozen `{source,lua,tabs,original}`. `original.text` retains the full input; for carts, `original.cart` contains `version`, exact raw `header` and `nonLua` tail, `sections` and `crlf`. The original file text also remains in the worker source map. `Suite.minifier.getInput()` adds the exact `sourceRevision`; future export code must compare it with the current result, not assume any retained result is current. Code panes display Lua; raw cart text is retained separately. Structural validation does not claim to parse Lua: the real engine does that on explicit Optimize.

Intake is transactional: a newer request, navigation, disposal or programmatic load invalidates an earlier picker/read. No model mutation occurs before validation and replacement consent. If the current job/result changes during confirmation, replacement stops and asks the user to try again. Intake errors use `mnInputStatus`, leaving the current model/result untouched. Cancel during intake cancels only intake; it does not cancel an existing optimization. No intake flow calls a saver, optimizer, folder picker or persistent store.

MIN-05 reports actual same-job engine counts through `P8MinifierCore.metricRows(result)`, including token/character limits, zero savings, increases, percentages and unavailable reasons. No estimate or whole-file byte count is used. `state.diagnosticJob` retains the immutable job owning the current diagnostics; source/options changes, new work, cancellation and initialization clear that binding. `diagnosticLocation(state, input, diagnostic)` accepts only a diagnostic object in the current list, a matching job/revision and exact entry-file snapshot, and an in-range Lua line. Cart file lines subtract the preserved header's line count (verified against the pinned engine). It selects whole lines to avoid treating P8SCII column counts as DOM UTF-16 offsets. Location actions revalidate on activation, so old saved callbacks cannot navigate a new source. Severity filtering is view-only and resets to All for new diagnostics.

MIN-06 Code Editor owns `Suite.codeSource` through `P8Code.createSourceBridge({read,focus})`. `getStatus()` returns availability/reason and an opaque document/location/folder/revision identity. `getSnapshot()` copies the live textarea, dirty/save baseline comparison, cart sections, code tabs, relative path and available folder/parent metadata into frozen plain data. No native handles cross this boundary; it never saves, reads files, scans folders, asks permissions or runs code. `isCurrent(identity)` rechecks the live context; `subscribe(fn)` returns an unsubscribe function. The editor refreshes observers after edits/save/load and before awaiting a folder scan. Selection/focus changes do not invalidate source identity.

`Suite.minifier.useEditor({navigate:true})` is the Code Editor menu handoff; the Minifier button uses the same method without navigation. It validates and obtains replacement consent, then rechecks both the editor identity and Minifier job/source after awaits. It may initialize the engine, never optimizes. `getInput().editor` contains the captured plain snapshot. An editor change invalidates the source revision/job and marks the captured source earlier while retaining its bytes; Optimize stays disabled until refreshed. The presenter also checks identity on every render to guard a late reply before an observer notification. Back only navigates and focuses the existing textarea; it never reloads the snapshot or assigns editor text/selection. A replaced editor document remains current. Dispose unsubscribes the observer.

MIN-07 adds `Suite.codeSource.getProjectSnapshot(capture,{live})`. The editor owns the exact-case handle index from its existing folder scan; Minifier receives only frozen plain file texts, dependency edges and warnings. `P8MinifierProject.resolve(source,{names,read,live})` uses `P8Code.lex/includes/includedCode` and `P8Audit.normPath/resolveInclude`, checks active-stack cycles and ambiguity, and reads each reachable dependency once. The reader queries already-granted **read** permission; it never requests permission, rescans or writes. It bypasses the editor meter’s cache and uses fatal UTF-8 decoding. Every await checks source/folder/index and intake identity. Partial graphs and denied/stale reads cannot replace the old source or result. Dependency disk changes after capture are not watched; refresh explicitly.

The worker accepts the complete plain file map. The Suite-owned Python bridge independently confines preprocessing to that map, bounds recursion and verifies upstream include notifications against actual-tokenizer source directives before calling the unchanged CLI. Before/after counts come from that same resolved tree. Project `--@` comments warn that output is a build copy; unknown `#` preprocessor and `$` compiler requests fail. Original file text/version/line endings stay in the snapshot; output is not a source round trip. See the [verified compatibility boundaries](docs/MINIFIER_ENGINE.md#project-includes--min-07).

MIN-08 `P8MinifierExport.build(state,input)` / `inspect(state,input)` require `Core.canExport`, exact source/job files and the retained original. The pure module returns frozen Lua and optional cartridge artifacts with distinct names, plus build-copy warnings for `--@` / keep/preserve comments. Generated Lua must have no unresolved includes or invalid tokens. For carts, the engine cart’s version/decoded ROM and Lua must match the source/result. Its canonical asset serialization is not used for export: optimized Lua is inserted between the exact original raw header and non-Lua envelope. The final envelope, code and independent `P8Cart` decoded ROM/version/label/section set are checked before either action is enabled. Any mismatch blocks output. `Core.prepareInput(raw,{allowEmpty:true})` permits validation of empty optimized Lua; normal intake still rejects empty source. `P8Code.splitCart` and `P8Cart` recognize `__meta:title__`-style section names (the real engine emits these even for comment-only carts).

The presenter caches validation per immutable state/input and rechecks on activation. Download’s format dialog is bound to the exact result/source/options; a change or Cancel produces no download. `P8App.download` requests a separate browser artifact, never a project Save, and feedback does not claim browser completion. Clipboard uses the actual Clipboard API promise and reports denial/unavailability; generic `copyText` fallback cannot prove success. A late clipboard completion names the captured earlier build, not a newer source. Pending callbacks stop at disposal. No export updates source/save identity, requests filesystem permissions or applies output to Code Editor. A tool tour (#127) and real PICO-8 runtime gate (#128) remain separate. Over-budget measurements stay visible; export validation establishes data/format preservation, not runtime equivalence.

Local startup (#134): `Start_Pico8_Suite.bat` / `tools/serve_suite.py` is an optional static-server and verified-asset preparation helper, separate from the PICO-8 Run bridge. `E_LOCAL_HTTP` is an unsupported hosting state, not a failed optimization. The presenter keeps setup instructions visible on file:// even when a new source clears job diagnostics, and disables both toolbar and menu Retry. Do not claim that retrying or loading another source can repair the page origin. Hosted/browser-worker behavior is unchanged.
