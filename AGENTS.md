# Agent development rules

Applies throughout this repository. Follow current user instructions and platform policies first. Use [CONTRIBUTING.md](CONTRIBUTING.md) for setup and available commands; the task-based validation rules below determine which checks to run. Never skip an explicitly required check or weaken CI to save tokens.

## Scope and working conduct

- Implement the assigned task and necessary dependencies. Check current code and related open PRs before duplicating work; historical reviews are evidence, not the current backlog.
- Read this file, the assigned issue and relevant code first. Read other documentation only when it affects the task. Do not reread all reviews or audit the whole repository for a small fix.
- State a short plan for substantial work; proceed directly for trivial edits. Make routine reversible decisions autonomously. Ask only for material missing requirements or actions outside the authorized scope.
- Keep patches focused and preserve others' work. No unrelated cleanup, bulk formatting, dependency updates, framework changes or UI redesigns.
- Find the root cause and inspect callers sharing the faulty assumption. Fix directly related violations; record unrelated findings without expanding the assignment indefinitely.
- Communicate briefly and respectfully. Report concrete results, blockers and uncertainty. Do not hide failures, fabricate validation, claim unavailable runtime checks passed, or call the application bug-free because tests pass.
- Do not launch extra agents unless the user explicitly requests delegation. When requested, assign distinct ownership and share findings; avoid duplicate investigations and competing edits.

## Architecture and compatibility

- Plain HTML/CSS/JavaScript; no npm installation, bundler or build step is needed. The optional Python bridge uses the standard library.
- Keep reusable logic in the existing `js/*-core.js` modules and UI adapters in their tool modules. Preserve existing APIs unless the task requires changing them.
- Preserve PICO-8 memory layouts, nibble ordering, palette-slot identity, raw-default storage, existing LZ streams and asset/scene compatibility. Migrate formats explicitly if necessary.
- Use the shared Lua lexer for executable-code analysis. Do not treat regex matches inside comments/strings or approximate preview inference as proof that destructive rewriting or retirement is safe.
- For save/navigation/Run changes, bind asynchronous results to the correct document, revision and file context. Report durable-save, cancellation and download outcomes accurately.
- For project mutations, preserve recoverable evidence until the complete chosen revision is verified, including required cart locations. Uncertainty about references retains carts. Failure must not silently discard user work.
- Changes must preserve behavior outside their intended scope. Proposed Send to/Asset Dock/Output Shelf designs are not authorization to redesign the UI.

## Token and tool discipline

- Use `rg` and targeted file ranges first. Batch independent reads; do not dump entire large files, full tool registries, environments or repetitive logs.
- Reuse source and test results already obtained for the same unchanged state. Reread only after edits, a changed base or missing information makes it necessary.
- Prefer existing tools, fixtures and helpers. Do not install dependencies, download browsers, create new test infrastructure or start benchmarks without a concrete task requirement.
- Stop investigating once the acceptance criteria, relevant failure paths and directly affected callers are covered. Broaden checks only for a new failure, shared-contract change or specific unresolved concern.
- After checks pass, do not rerun them just because you are preparing a commit, writing the PR or changing documentation. Rerun affected checks after relevant code/test changes or integration that could invalidate the result.
- Summarize successful output. Include detailed logs only when needed to explain a failure. Keep the final handoff short.

## Validation proportional to the change

Choose checks by behavior affected, not by habit. Mention the selection in one short sentence; no separate testing proposal is needed. An existing green CI result can establish an unchanged baseline. Otherwise run the relevant baseline once when useful; do not run every check before editing every task.

| Change | Required local validation |
| --- | --- |
| Documentation, comments or prose-only help text | Inspect the diff, check changed links when applicable, and `git diff --check`. No runtime tests. If editing embedded strings/markup could break syntax, also check that file's syntax/structure. |
| CSS or visual layout | Inspect the changed UI in a browser when available; check the affected interaction. No unrelated codec, transaction or Python tests. |
| HTML IDs or script/style references | `node tests/check-static.js`; inspect the affected UI when available. |
| JavaScript behavior | Focused regression(s) while developing, syntax checks for changed JS, then `node tests/regress.js` once on the final code/test state before handoff. The existing suite is small; do not invent a new runner just to avoid it. |
| Python bridge behavior | Python syntax check and the existing bridge tests once on the final state; no JS suite unless browser/bridge integration also changed. |
| CI/test infrastructure or a shared cross-tool contract | Run the affected commands and dependent tests once. Broaden to the full existing checks only when those dependencies justify it. |

If a change spans categories, combine their relevant checks without repeating them. CI keeps its full existing checks regardless of the smaller local selection. Inspect one CI result when available; do not repeatedly poll a running job.

Available commands (run only those selected above):

```sh
# Focused area, using the current harness; substitute the actual test file:
node -e "require('./tests/anchors.test.js'); require('./tests/harness.js').run()"

# Final JS behavior check:
node tests/regress.js
node --check js/CHANGED_FILE.js

# HTML references/IDs:
node tests/check-static.js

# Bridge changes:
python -m py_compile tools/pico8_bridge.py
python -m unittest discover -s tests -p 'test_*.py' -v

# Every patch:
git diff --check
```

Do not execute every `tests/*.test.js` directly and assume tests ran: these files register cases with `tests/harness.js`; the harness must call `run()`.

## Tests that earn their cost

- Add regression tests for behavior fixes when existing coverage does not establish the correction. Reuse/extend a small fixture; do not create redundant tests to increase a count.
- Prefer a failing-before/fixed-after example, a normal success path and meaningful boundaries. Avoid implementation-mirroring assertions, exhaustive permutations and large random suites unless the algorithm requires them.
- Test the actual integration boundary when the defect is there: file locations/contents after recovery, real transition wiring and Run payloads, not only a helper's success flag.
- Saving, recovery, destructive rewriting, storage and concurrency changes require relevant failure/cancellation/interruption tests. These are necessary correctness checks, not optional overhead. Use deterministic, bounded schedules; test recovery retries when changing recovery.
- Use fake filesystem/storage/process runners or disposable folders. Never inject failures into a real demo or launch a real PICO-8 process for bridge unit tests.
- Do not add automated tests for a prose-only change or a trivial visual adjustment already verified by inspection. Do not add benchmarks or unrelated runtime/platform tests to a small fix.
- Use browser/PICO-8 verification when the behavior needs it and the runtime is available. If unavailable, state the gap once; do not silently replace runtime evidence with a round trip through the same implementation.
- If a check fails, investigate once and classify it as introduced, pre-existing or environment-blocked with evidence. Do not keep rerunning an unchanged command hoping for a different result, or disable a test to obtain green status.

## Git, review and completion

- Work on a task branch and open a focused PR unless the user explicitly authorizes another workflow. Do not merge, push directly to `main`, force-push shared history, change security settings or send messages on the user's behalf without authorization.
- Do not delete or overwrite unrelated/uncommitted work. Keep generated caches, temporary probes, logs and failure-injection data out of commits.
- Update documentation only where the task changes behavior. Preserve historical review SHAs; record fix provenance separately. Do not add a new full health-review document for every small fix.
- Before handoff, inspect the final diff for accidental changes. For multi-part work, verify the combined result once where interactions matter; do not repeat an independent full review per tiny commit.
- PR/handoff: state resulting behavior, issues addressed, exact checks/results and material limitations. Mention an omitted check only when its absence affects confidence; do not list every irrelevant test you skipped.
- Stop when the requested change is complete, relevant checks pass and the PR is reviewable. If acceptance criteria remain unmet, identify them clearly and leave the issue open; do not substitute endless testing or unrelated cleanup for completion.
