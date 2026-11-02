# UX release checklist

Use this before a release or a larger UX change (see [UX_DEVELOPMENT_PLAN.md](UX_DEVELOPMENT_PLAN.md), Definition of Done). Use a disposable project copy and a supported browser (Chrome or Edge for folder access). Record what you ran and what you could not run; do not claim untested items.

## Automated (offline, no browser)

- `node tests/regress.js` once on the final state. It includes `tests/docs-integrity.test.js`, which fails with an actionable message for: a workspace without a help topic, duplicate help/control ids, a `data-help-id` without help text, a tour step whose target no longer exists, is hidden by default or JS-built without `optional`/`conditional`, an unknown `helpId`, or a menu shortcut missing from the help.
- `node tests/check-static.js` when `index.html` ids or script/style references changed.
- A documentation-only change needs only a diff review, link check and `git diff --check`; do not run the full suite for it.

## Adding or changing a tool (same PR)

1. **Help topic** in `js/help-data.js` (`kind: 'tool'`, `ws` = the workspace id): purpose, inputs, outputs, actions, restrictions, shortcuts, related. Bump `rev`.
2. **Stable ids** for controls/actions (`tool.control`); mark essential controls with `data-help-id` only if they should have tooltips. A rename needs an `ALIASES` entry.
3. **Shortcuts:** every shortcut shown in a menu is listed in the topic (or the F1 keyboard section).
4. **Tour:** optional. If the tool has steps, give each a stable `id`, a non-brittle `target`, `optional`/`conditional` where it can legitimately be absent, and bump the tour `major` only for a meaningful new capability (offers "What's new"); copy edits keep it.
5. `EXTENDING.md` / `docs/` updated if a contract changed; the long-form F1 section updated or its parity noted.

## Human test plan (about 20 minutes)

Run each on the affected surface and note pass/fail; baseline tasks from the UX plan apply.

| Area | Check |
| --- | --- |
| Save / Run | Edit Lua in the Code Editor, Save, Run (with the bridge if available): the saved file is the one that runs; a failed save shows an error, never "Saved". |
| Transfers | Save an image to the Library, Open in another tool; an incompatible target explains why; the Library asset stays unchanged. |
| Permission loss | Revoke folder permission for the active project: the app bar shows "reconnect needed" or "access denied", edits stay in memory, no success message. |
| Onboarding | Clear `p8suite.tours`: the welcome appears once on Home; Start, Skip and "Never auto-offer" behave; Esc ends a tour; Help › Quick tours replays; a renamed/missing target is skipped. |
| Help / tooltips | F1 opens the current tool's topic; search finds a control name; Off hides tips but not labels, errors or warnings; tips appear on keyboard focus and hide on Esc. |
| Report preview | Help › Report a problem: review both the text and JSON previews for private information; remove a JSON record and verify the download omits it; Copy exports only the edited text summary; invalid JSON cannot download; GitHub opens only on click. A synthetic error appears in the summary once. |
| Keyboard | Tab through the app bar, menus, dialogs and a tool; focus is visible, option groups use arrow keys, dialogs return focus on close. See `docs/ACCESSIBILITY.md`. |
| Responsive | At 1280, 768 and 320 CSS px and 200% zoom: no lost controls, no horizontal page scroll, dialogs usable. |

## Handoff

State exactly which automated checks ran and which human rows were covered; list gaps once (for example "no PICO-8 available", "touch not tested").
