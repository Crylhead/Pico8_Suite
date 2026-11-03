# Contributing to PICO8_Suite

## Development setup

Work from this repository's root. The web app is plain HTML/CSS/JavaScript: there is no npm install, bundler or build step. Serve locally with `python -m http.server 8000 --bind 127.0.0.1`, then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

Use Chrome/Edge when testing writable folders or in-place file saves. Browser data is origin-specific; changing port/host or switching between `file://` and HTTP does not move the asset Library. Export a Library backup first. Use disposable demo copies for filesystem testing.

The optional Run helper needs Python 3 and an installed PICO-8. See [README.md](README.md). The development review used Node.js 24.22.1 and Python 3.12.14; the repository does not yet declare a tested compatibility matrix.

## Available checks

Run from the repository root:

```sh
node tests/regress.js
python -m py_compile tools/pico8_bridge.py
python -m unittest discover -s tests -p 'test_*.py' -v
node tests/check-static.js
```

Check every JavaScript file in PowerShell:

```powershell
Get-ChildItem js -Filter *.js | ForEach-Object {
    node --check $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $($_.Name)" }
}
```

Or in Bash:

```sh
for file in js/*.js; do
  node --check "$file" || exit 1
done
```

`tests/docs-integrity.test.js` (drift between tools, the help registry, shortcuts and tours) runs inside `node tests/regress.js`; its rules and the manual UX acceptance plan are in [docs/UX_RELEASE_CHECKLIST.md](docs/UX_RELEASE_CHECKLIST.md). Documentation-only edits do not need the full suite. `tests/regress.js` runs its original six cases for subrange anchors and include expansion, then every `tests/*.test.js` file. Add focused regressions for a fix in a `tests/<area>.test.js` file using `t(name, fn)` from `tests/harness.js`; async test functions are supported. `tests/check-static.js` verifies that `index.html` element IDs are unique and its local script/style references exist. `tests/test_bridge.py` (standard-library `unittest`) starts the bridge in-process on a free loopback port with a fake process launcher, so it never starts PICO-8, and uses a scratch carts folder under `tests/` that it removes; it covers pairing-token, Host/Origin and request validation and concurrent run/stop.

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of the commands above on pull requests and pushes to `main`, using Node.js 24 and Python 3.12 on Ubuntu. It needs no npm install, browser or PICO-8 executable, and writes no project files. The historical PICO-8/Chrome benchmark and runtime-parity suites mentioned in older notes are not included; runtime checks in PICO-8 remain separate, optional evidence reported in PRs.

For a UI change, test its main journey and cancellation/error path in a browser, watching the console. For a byte-layout or decoder change, validate representative exports in PICO-8 when available. If it is unavailable, report that limit; JS round trips alone do not establish runtime parity.

## Agent and collaborator workflow

1. Start with the assigned [issue](https://github.com/Crylhead/Pico8_Suite/issues) and the [current health review](docs/HEALTH_REVIEW_2026-11-03_fd31e3c.md). Compare its pinned reviewed source against your current base and reproduce before changing code.
2. Prioritize the current data-preservation findings: Pixel Studio asynchronous saves (#80), unguarded Tile Maker → Map Editor replacement (#81), and mutable-list helper assumptions (#82). Folder/Run context (#83), import cancellation (#84) and diagnostic metadata privacy (#85) follow. Original issues #1–#14 and follow-ups #30–#35/#40–#44 have merged fixes; recheck current code and related PRs before treating historical findings as open.
3. Keep each implementation focused. Work on a feature branch based on current `main` and open a PR unless the maintainer explicitly asks for direct commits. Preserve byte formats, palette-slot identity, raw-default compression and current UX features.
4. Reuse the core/UI split. Add a few meaningful regression cases for the specific defect and success path; avoid broad rewrites, new test frameworks or large repetitive suites.
5. For fake filesystem/storage/bridge tests, cover cancellation, denied writes, external changes and partial failures without writing a real demo or launching PICO-8.
6. Explain the resulting behavior, exact validation/results and remaining limits in the PR. Reference the issue and record the fix commit when resolved.

Coordinate #81/#84 where they share transfer adapters; keep #82 under one parser owner. #80 needs actual save/replacement-state checks and #83 needs actual Run payload/folder-context checks. Existing recovery, parser, storage and editor regressions remain required for affected changes; preserve and extend the existing harness instead of rebuilding it. Follow AGENTS.md for proportional validation.

The permanent **Send to** control, Asset Dock and Output Shelf are earlier UX options, not an approved implementation layout. Registry-backed Send to actions already exist; keep any larger layout redesign separate from current correctness fixes; historical references are linked from the review.

## Architecture

- `js/*-core.js`: generally DOM-free models/codecs; `js/tiles-core.js` expects the shared `P8` core in its execution context.
- `js/app.js`: shell, actions, dialogs, shortcuts, Palette & Fades.
- `js/suite.js`: browser asset storage, consumers, palette providers and Home.
- `js/<tool>.js`: workspace UI and adapters.
- `index.html`: workspaces, menus and F1 help.
- `tools/pico8_bridge.py`: optional loopback HTTP helper; no third-party Python dependencies.

See [EXTENDING.md](EXTENDING.md) before adding a tool, [PROJECT_MODEL.md](docs/PROJECT_MODEL.md) for Cart Builder and [COMPRESSION.md](docs/COMPRESSION.md) for the implemented codec and historical measurements.


