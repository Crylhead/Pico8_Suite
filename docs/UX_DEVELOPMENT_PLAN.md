# PICO-8 Suite — UI/UX development plan

**Status:** proposed engineering roadmap (2026-11-02). **Owners:** project maintainers and independently assigned agents. **Target:** improve the existing browser-based toolchain without removing expert features, changing PICO-8 formats, or imposing a new framework.

This is the living source of truth for UX changes. Start with [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [EXTENDING.md](../EXTENDING.md), [PROJECT_MODEL.md](PROJECT_MODEL.md), and the relevant assigned issue. This roadmap is a specification, not proof that proposed features are implemented. Historical health reviews remain historical. **Issues #40–#44 are handled separately by ongoing correctness work; do not re-open or duplicate them here.** Any UX task intersecting their code must rebase on the merged fixes and preserve the new safety guarantees.

## Product vision and design philosophy

**Power without confusion.** PICO-8 Suite should feel like a connected development environment rather than a drawer of unrelated utilities. Its functionality must remain available, but navigation, feedback, and help should make the next action obvious.

1. **Usability / recognition over recall.** Name tools and actions; provide contextual labels, examples and meaningful previews. Never require users to remember which tab hides a feature or where a temporary asset was saved.
2. **Flexibility / progressive disclosure.** Present common actions first and advanced controls on demand; do not delete, silently reset or make expert features unreachable. Support both efficient keyboard workflows and mouse/touch where appropriate. Allow panel arrangements to adapt to display size.
3. **Stability / safety before convenience.** A save is only “Saved” after durable success. Destructive writes show affected resources and can be canceled safely; recoveries are verifiable. Never infer certainty from heuristic source analysis.
4. **Consistency with tool specialization.** Share navigation, statuses, dialogs, setting conventions and transfer semantics. Preserve specialized editor canvases, keyboard workflows and PICO-8 constraints.
5. **Local-first, privacy-first.** Keep the no-build, static-hosted, offline-capable baseline. No required account, remote server, analytics, automated log upload, or third-party dependency. Diagnostics are user-triggered, inspectable and redactable.
6. **Responsive, perceivable feedback.** Respond to user input immediately even when processing is slow; distinguish queued/preview/final work and show cancel/retry only when supported. Do not report an operation completed because it was merely queued.
7. **Documentation is product functionality.** A tool is not complete unless its purpose, options, shortcuts, data model, supported browsers, limitations and examples are documented and accessible from the UI. A changed tool updates its help and tours within the same PR.
8. **Accessible by default.** Essential labels, warnings, error recovery and focus indicators are never optional. The *extra explanatory help* can be disabled for experts; accessibility affordances cannot.
9. **Evidence, not aesthetic opinion.** Review workflows with testable tasks and error cases, keep baseline-versus-after screenshots only when useful, and distinguish static source inspection from verified browser and PICO-8 results.

Sources: [NN/g usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/), [NN/g progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [NN/g contextual help vs. tutorials](https://www.nngroup.com/articles/onboarding-tutorials/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/).

## Current architecture and constraints

- Entry points: `index.html` (app shell, workspace elements, F1 documentation), `css/style.css` and `css/suite.css` (tokens/layouts), `js/app.js` (`P8App`: workspace state, shortcuts, menus, dialogs), `js/suite.js` (`Suite`: tool registry, Library, consumers and transfers).
- Specialized UI: `js/studio.js`, `js/map.js`, `js/code.js`, `js/tiles.js`, `js/project.js`, `js/datacarts.js`, `js/audit.js`, `js/extras.js`, `js/terrain.js`.
- The Library is IndexedDB; current sessions are not synonymous with fully backed-up project files. Browser permissions and File System Access differ across environments. Chrome/Edge in-place folder access is optional, not the default path for all users. Browser-hosted tools still work without the Python Run bridge.
- PICO-8 compatibility (memory map, palette slots, graphics, map, data-cart bytes, LZ, code/token reporting) is an invariant. Existing `#include`, `--@data`, project transaction, recovery and bridge safety contracts are not UX refactoring opportunities.
- Minimal runtime footprint: no mandatory bundler, npm install, backend or new test framework. Apply [AGENTS.md](../AGENTS.md) proportional testing; test affected contracts, not every unrelated area.
- Do not create a second competing Home/Help/Settings state system. Extend stable existing APIs with documented adapters and maintain backwards compatibility.

## Experience model

### Navigation / Home

The top-level navigation should scale beyond eleven icon-only workspaces. Preferred information architecture is **Create** (Pixel Studio, Palette & Fades, Tile Maker, Map Editor, Terrain Lab), **Develop** (Code Editor, Cart Builder), **Inspect** (Project Audit, Data Carts), **Utilities** (Data Tools, remaining Extra Tools). This is a *discovery grouping*, not authorization to relocate or remove tools or break deep links. Offer persistent text labels at normal desktop widths, a compact collapsible mode, tool search/quick switch, active workspace state, and keyboard navigation. Update `EXTENDING.md` so new tools declare category/description/capabilities once.

Home should offer: resume recent browser assets, reopen an available project when permissions allow, new/create/import actions, recently used tools, and clear local-only storage messaging. Nothing silently opens protected folders. Never conflate a Library asset with a writable local project file.

### Project context (optional, explicit)

Introduce a single non-owning **active project reference** as a shared convenience layer. It should represent current project folder identity/permissions and expose changes to interested tools, not automatically modify their files. Tools can opt into adopting the current project; standalone import/export remains fully functional. Do not cache long-lived permission as a promise of future access. Recheck before writes and handle external changes.

### Transfers / provenance

The shared Library remains a first-class asset store. Provide a consistent **Send to… / Open in…** entry point, backed by the existing consumer/compatibility registry. Always show target, size/type compatibility and why a target is disabled. Do not silently alter or replace the destination document. Model provenance separately for a future **Return to source** convenience action; no implicit two-way syncing and no destructive overwrites.

### Save and operation status

Adopt exact language across workspaces:
- **Unsaved changes:** the active working document differs from its last confirmed target.
- **Saving…:** an operation is in flight; may still fail.
- **Saved to Library / Saved to project file / Downloaded:** these are different results, only claimed on verified completion.
- **Browser-only / memory-only:** not a portable backup; warn on exit risk and provide export.
- **Conflict / failed / recovery required:** persistent actionable state, including a route to resolve; never a success toast.
- **Analyzing / preview / finalizing:** provisional results may be shown without claiming they are final.

**Shared contract (#58):** `js/doc-status-core.js` (`P8DocStatus`) implements these states with document identity, revision-bound save tickets and persistent errors; the Map Editor is the pilot adapter. Adapter guidance for other tools is in [EXTENDING.md](../EXTENDING.md#document-save-status).

Modal confirmations must specify the affected files/assets and consequences, avoid vague “OK” on destructive actions, and handle cancel/permission failure/retries without losing dirty state.

## Documentation, tooltips and onboarding contract

**One canonical help registry** should map stable tool IDs and control/feature IDs to localized-ready text and versioned documentation anchors. Preferred implementation: static structured JS/JSON metadata loaded locally, plus maintained readable Markdown source. Do not depend on live network calls or dynamically scrape tooltips from arbitrary DOM. Avoid duplicating a full manual per tooltip or per tour step.

Each tool's documentation record must contain: stable ID, display name, purpose, inputs, workflow example, controls and parameter semantics/defaults/ranges, shortcuts, PICO-8 export and memory implications, compatibility/browser constraints, warnings, common errors/recovery, related tools, version/update note and links to official references. A concise in-app article opens via F1 at the active workspace/control; searchable Help includes a global index, task-driven guides, quick-reference pages, and accessible navigation. Document how to run the Suite offline and what the backup does *not* cover.

Tool help has **three levels**, stored as a local user preference: **Off** = no optional instructional popovers, **Concise** = short nonintrusive explanations (default for returning users), **Detailed** = extra example/learn-more help. Essential accessible names, visible control labels, irreversible-action warnings and status messages stay on in all levels. Hover and focus are both supported; Escape dismisses; never require tooltip access to perform a task. Native `title` attributes may produce browser tooltips; the preference mechanism must handle those consistently without removing accessible names.

**Quick tours are optional, replayable, versioned and resilient.** A first-run welcome offers Start tour / Explore independently / Never auto-offer. Provide a Suite overview and small per-tool tours based on stable registered step IDs and visible element selectors, with semantic preconditions. Skip hidden/removed elements gracefully, support keyboard focus and Escape, never start in the middle of a destructive workflow and never block real editing. On a tool change, maintainers update its help and tour version/steps in the same PR. A migration/replay policy: prior completion remains honored for minor copy/layout updates; only meaningful new capability introduces an optional “What’s new” prompt, never a forced replay. Tours work offline and tolerate preference/IndexedDB failures with safe defaults.

## Bug reports, crashes, diagnostic export and privacy

Implement two distinct surfaces: **Diagnostics** (capture errors) and **Report a problem** (user action). Use a bounded in-memory ring buffer for structured events: timestamp, severity, source/tool, stable error code, optional sanitized message/stack, app version/commit if known, browser family and relevant operation state. Cover `window.error`, `unhandledrejection`, worker failures and explicitly reported operation failures without double logging. Worker `error` and `messageerror` are separate from window errors. A JavaScript failure is not necessarily a browser tab crash, and the page cannot guarantee recovery of logs after a total tab/process crash; say so in the UI.

Default diagnostic payload must **exclude** document text/code, asset pixels, file contents, library records, file handles, user names, full local paths, pairing tokens, cookies, localStorage/IndexedDB contents, request payloads, or arbitrary user-provided strings. As error messages and stacks can still accidentally contain sensitive content, sanitize conservatively and allow inspection/redaction before any copy/export. Capture raw data neither by default nor with background remote upload. Keep output bounded; local JSON download is enough initially. A plain-language Error ID helps match feedback to the session log.

**Report a problem** (Help menu and contextual error actions) asks for a short description, steps to reproduce, expected/actual, tool and version, then offers preview/edit/redact the diagnostic summary; Copy summary, Download diagnostics, or Open GitHub's bug-report issue form. Auto-submission and background upload are out of scope. Opening GitHub cannot attach a local file automatically: instruct the user to review and attach it manually if desired. The entire experience must work with no GitHub login until the optional GitHub action, and degrade clearly when offline. Use a repository issue template without exposing private diagnostics in URL query parameters.

References: [MDN window error](https://developer.mozilla.org/en-US/docs/Web/API/Window/error_event), [MDN unhandledrejection](https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event), [GitHub issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository), [MDN File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API).

## Visual, accessibility and interaction standards

- Document existing CSS colors, spacing, font sizes, control dimensions, panel style and state semantics; centralize repeated primitives without freezing custom workspace design.
- Prioritize central canvas, readable status, resizable collapsible side panels, predictable keyboard handling, full light/dark support, and no new horizontal viewport overflow. Preserve layouts on reload with safe defaults.
- Work toward **WCAG 2.2 AA** for non-canvas UI. Audit keyboard reachability, visible focus, accessible names/roles, modal focus trap and return, screen-reader status updates, pointer size, reflow at 320 CSS px, 200% zoom, reduced motion and color-independent error meanings. Where canvas editing cannot fully meet a criterion, document limitation and offer an alternative interaction for key tasks.
- Custom tab/radio/toolbars must implement the appropriate APG focus and arrow-navigation pattern. Provide non-drag alternatives for data-part placement and other necessary commands.
- Tooltip/hint controls must not steal focus, cover editing targets indefinitely, or become the only source of essential information. Re-evaluate role semantics with actual keyboard and screen-reader checks.
- Reference [WAI tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), [WAI toolbar](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/), [WAI modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [WAI tooltip](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

**Shell baseline (#65):** [docs/ACCESSIBILITY.md](ACCESSIBILITY.md) documents the implemented radio-group, menu, dialog, toast and Enter/Space contract, the measured contrast and target sizes, canvas limitations with proposed non-drag follow-up issues, and the manual keyboard regression script.

## Performance and perceived smoothness

Aim for **visible acknowledgement on the next animation frame** for normal controls and drags. As a reference threshold, web.dev calls INP <=200 ms good (field metric at p75; this does not imply every terrain rebuild must finish within 200 ms). Track sampled input-to-paint responsiveness and frame pacing locally during UX profiling, not via default remote telemetry. For sustained drag/brush/zoom interactions, minimize skipped frames at 60 Hz on an agreed test machine; define measured baselines before declaring a regression. Work in Workers for terrain/data transformations when possible, coalesce superseded jobs and expose “Preview” vs “Final” and stale state clearly. No fabricated progress percentages. See [web.dev INP](https://web.dev/articles/inp) and [optimize INP](https://web.dev/articles/optimize-inp/).

## Roadmap, work-package independence and dependencies

Issue labels in titles use UX P1/P2/P3 for relative priority, not a demand to work in serial. Maintain agents' independent ownership by limiting each issue to its surface and documented contract. Shared contracts should be decided in the earliest small issue, then consumed by tool-specific work. Parallel PRs must rebase before merge if they touch `index.html`, `js/app.js`, `js/suite.js` or shared CSS.

**Wave A — foundation and trust:** design tokens/components; preference contract; read-only active project; consistent save/status semantics; responsive baseline; accessibility baseline. These may proceed in parallel with clearly separated files, and should avoid pending #40–#44 fixes.

**Wave B — daily workflow:** navigation/tool discovery, Home and continuity, direct Send to, project context adapters, Cart Builder human-readable previews, performance/stale preview feedback. Source code implementation of risky project mutations remains outside the UX wave.

**Wave C — learnability and feedback:** canonical searchable help, optional explanatory tooltips, versioned onboarding, bounded diagnostics, bug report and GitHub issue form.

**Wave D — maintenance:** automated docs/tool/step registry integrity checks; lightweight usability script and release checklist; targeted browser smoke tests for critical journeys. Never run every unrelated expensive test for every UX-only change.

Dependency map: **Preferences → tooltip controls / onboarding preference**; **Help registry → tooltips → tours** (tour engine can be prepared independently against a fixture); **Diagnostics → report workflow**; **Read-only project context → individual integrations**; **Design tokens → adoption of shared primitives**. Navigation, Home, accessibility and performance can be independently prototyped. Keep source-level ownership explicit in each GitHub issue.

## Shared Definition of Done for every UX issue

1. The assigned issue's acceptance checks all pass, including the named edge cases. Show before/after behavior, not only screenshots or assertions on internal helpers.
2. Preserve existing tool reachability, outputs, shortcuts, keyboard workflows, cartridge formats, data integrity and no-build startup; no silent loss of advanced features.
3. All new UI controls have accessible labels, visible focus, appropriate keyboard action, adequate contrast, and clear non-hover access to critical information. Validate dark/light modes and narrow windows for touched surfaces.
4. User-facing failures are actionable; async operations do not claim a save/transmit/commit until confirmed. Cancel, permissions denied, invalid input and reentry have deliberate outcomes where relevant.
5. New/changed controls are reflected in canonical docs, F1 help, shortcut listing and tooltips/tour steps **if applicable**. Update tools' tour versions only on meaningful changes; never leave stale selector targets.
6. Preserve privacy/offline behavior. New diagnostics/help functionality must not add network submission, surprise tracking or raw project-content capture.
7. Run proportional tests per [AGENTS.md](../AGENTS.md): relevant focused checks, static/syntax where affected, final JS suite once if JS behavior changed, browser/manual validation if available. Describe gaps instead of claiming untested success.
8. Include the issue's evidence, exact commands/results, changed paths, UX screenshots/short recording where beneficial, risk and rollback details in the PR. Avoid unrelated refactors.

## Agent-facing issue format

Each issue includes **Outcome**, **Current surfaces**, **In scope**, **Out of scope**, **Acceptance criteria**, **Validation**, **Dependencies/coordination** and **References**. Work on one issue per PR. Do not independently invent conflicting global registries or settings; follow this roadmap and check active PRs first. If a task needs a new shared interface, keep the minimal interface stable and document it in `EXTENDING.md`.

### Baseline usability tasks (repeat before/after on the affected surface)

1. From Home, find Pixel Studio and create/import a 128×128 image; save and reopen it without changing palette slots.
2. Send that image to Tile Maker; understand if the target rejects its dimensions; move the result into the Library.
3. Edit a palette and apply it to a terrain preview; explain what is temporary and what will be exported.
4. Open a demo project in supported browser, inspect data carts and token usage, edit Lua, Save and Run correct file.
5. On a disposable project copy, preview the Cart Builder write, cancel safely and then confirm; list all affected files.
6. Simulate storage denial or permission loss: user sees an actionable unsaved state, no misleading success.
7. Discover an advanced parameter with keyboard-only access; switch optional tips off without losing labels/validation.
8. Complete, skip and replay a tool tour; after a renamed control, no orphaned tour step remains.
9. Trigger a synthetic harmless error, inspect diagnostics and generate a bug report without leaking project contents.
10. At 320/768/1280+ CSS px and 200% zoom, verify affected layouts remain navigable and editing remains possible.

**Measures:** task completion (target 100% in scripted happy-path), unexpected data loss (zero), critical-blocker recovery success (100% for scripted recoverable cases), misleading completed statuses (zero), error reporting without sensitive default payload (100%), help/tour selector integrity (100%), and count of unnecessary clicks/tool switches. Baseline measurements precede any numeric speed-improvement claim. Use 5 representative participants for exploratory evaluation if available, not as substitute for technical correctness.

## Living-document maintenance and release gates

- A tool/feature PR must update its canonical help entry, shortcut/parameter facts, browser and file-format notes and relevant tour metadata **in the same PR**. New tool registration without a doc/help entry is a detectable drift failure when the registry check exists.
- Keep `EXTENDING.md` synchronized with the tool registration interface. The old HTML F1 documentation may temporarily coexist, but must not contradict the canonical source; retire duplication only after parity audit.
- Tag help entries with a stable ID; use explicit renamed/deprecated aliases where needed. Every tour step has a stable ID and validated selector or semantic target with fallback. Do not use brittle nth-child selectors.
- A small maintenance checklist belongs in the contributor workflow; only test help/tour drift when relevant files change (or in CI). Maintain a “What's new” section with tool revisions or behavior changes, not an unmaintained marketing changelog.
- Review documentation/help against actual UI on every release and when options change. Revalidate browser permissions/supported APIs periodically from current MDN and actual browser tests.
- Promote this roadmap from proposed to active after review; record ADR-style tradeoffs for navigation, help registry and diagnostics privacy. Do not silently change the product philosophy in implementation PRs.

## External reference library

- [PICO-8 official manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html) — data limits/API and native behavior, primary source.
- [Nielsen Norman Group: 10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) — recognition, feedback, error prevention, consistency.
- [Nielsen Norman Group: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) — high capability without visual overload.
- [Nielsen Norman Group: onboarding and contextual help](https://www.nngroup.com/articles/onboarding-tutorials/) — optional, user-triggered help instead of mandatory interruptions.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) — accessibility acceptance.
- [WAI-ARIA authoring practices](https://www.w3.org/WAI/ARIA/apg/patterns/) — tabs, menus, toolbar, dialogs and tooltip semantics.
- [web.dev: interaction to next paint](https://web.dev/articles/inp) — response latency definitions/thresholds.
- [MDN: File System API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — browser permission and fallback design.
- [MDN: window error](https://developer.mozilla.org/en-US/docs/Web/API/Window/error_event), [unhandledrejection](https://developer.mozilla.org/en-US/docs/Web/API/Window/unhandledrejection_event) — diagnostics limitations.
- [GitHub: configuring issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository) — structured user reports.

## GitHub work-package index (18 independently assignable issues)

Each issue contains precise acceptance checks and explicit exclusions. Assign a single issue per agent/PR; **independently assignable does not mean that two PRs may simultaneously overwrite shared shell files**. Rebase and review the combined contract at merge time.

| Issue | Title / owner surface | Wave |
| --- | --- | --- |
| [#52](https://github.com/Crylhead/Pico8_Suite/issues/52) | Design tokens, shared visual control states | A |
| [#53](https://github.com/Crylhead/Pico8_Suite/issues/53) | Discoverable grouped navigation and tool switch | B |
| [#54](https://github.com/Crylhead/Pico8_Suite/issues/54) | Durable UX preference contract | A |
| [#55](https://github.com/Crylhead/Pico8_Suite/issues/55) | Optional read-only active project context | A |
| [#56](https://github.com/Crylhead/Pico8_Suite/issues/56) | Project adapters for Code Editor / Audit / Data Carts | B; after #55 |
| [#57](https://github.com/Crylhead/Pico8_Suite/issues/57) | Direct asset Send to / Open in with compatibility reasons | B |
| [#58](https://github.com/Crylhead/Pico8_Suite/issues/58) | Saved/dirty/downloaded/error state semantics | A |
| [#59](https://github.com/Crylhead/Pico8_Suite/issues/59) | Searchable, contextual F1 and canonical help registry | C foundation |
| [#60](https://github.com/Crylhead/Pico8_Suite/issues/60) | Optional concise/detailed tooltips | C; after #54 and #59 |
| [#61](https://github.com/Crylhead/Pico8_Suite/issues/61) | Replayable versioned onboarding tours | C; after #54 and #59 |
| [#62](https://github.com/Crylhead/Pico8_Suite/issues/62) | Bounded privacy-preserving diagnostics | C foundation |
| [#63](https://github.com/Crylhead/Pico8_Suite/issues/63) | Report-a-problem UI, preview/export and issue template | C; after #62 |
| [#64](https://github.com/Crylhead/Pico8_Suite/issues/64) | Resizable and responsive workspace panels | A/B |
| [#65](https://github.com/Crylhead/Pico8_Suite/issues/65) | Shared keyboard, focus and accessibility audit | A |
| [#66](https://github.com/Crylhead/Pico8_Suite/issues/66) | Cart Builder transparent staged/preflight UX | B; integrate after #40–#44 |
| [#67](https://github.com/Crylhead/Pico8_Suite/issues/67) | Terrain Lab perceived latency, state and errors | B |
| [#68](https://github.com/Crylhead/Pico8_Suite/issues/68) | Home task launcher and safe continuation | B |
| [#69](https://github.com/Crylhead/Pico8_Suite/issues/69) | Documentation/tour drift checks and UX release checklist | D; after #59 and #61 |

**Suggested first parallel assignments:** #52 (design tokens), #55 (isolated project-context API), #59 (documentation registry), #62 (diagnostic core), #67 (Terrain Lab performance feedback) — these occupy mostly distinct modules. For #53, #54, #58, #65 and #68 (shared shell), stagger integration and avoid racing edits to `js/app.js`, `js/suite.js`, `index.html` and shared CSS.

Progress should be tracked through issue state and linked PRs, not a duplicate manually checked list. If implementation materially changes an issue's acceptance test, review the change explicitly before merging rather than silently lowering the bar.
