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

The committed regression runner currently contains six cases for subrange anchors and include expansion. There is no GitHub Actions workflow yet ([#14](https://github.com/Crylhead/Pico8_Suite/issues/14)). The historical PICO-8/Chrome benchmark suites mentioned in older notes are not included.

For a UI change, test its main journey and cancellation/error path in a browser, watching the console. For a byte-layout or decoder change, validate representative exports in PICO-8 when available. If it is unavailable, report that limit; JS round trips alone do not establish runtime parity.

## Agent and collaborator workflow

1. Start with the assigned [issue](https://github.com/Crylhead/Pico8_Suite/issues) and the [current health review](docs/HEALTH_REVIEW_2026-11-01.md). Compare its pinned reviewed source against your current base and reproduce before changing code.
2. Prioritize data preservation: project mutation (#1–#4, #7), durable Library/session saves (#5), asynchronous code saves (#6), and Terrain history (#9).
3. Keep each implementation focused. Work on a feature branch based on current `main` and open a PR unless the maintainer explicitly asks for direct commits. Preserve byte formats, palette-slot identity, raw-default compression and current UX features.
4. Reuse the core/UI split. Add a few meaningful regression cases for the specific defect and success path; avoid broad rewrites, new test frameworks or large repetitive suites.
5. For fake filesystem/storage/bridge tests, cover cancellation, denied writes, external changes and partial failures without writing a real demo or launching PICO-8.
6. Explain the resulting behavior, exact validation/results and remaining limits in the PR. Reference the issue and record the fix commit when resolved.

Issues #1/#2/#3/#4/#7 touch the same Cart Builder path; coordinate sequencing to avoid conflicting rewrites. #5 affects every tool using Suite storage. #11/#12 both benefit from consistent Lua comment/string handling. Establish #14 early so later focused tests run automatically.

The permanent **Send to** control, Asset Dock and Output Shelf are earlier UX options, not an approved implementation layout. Keep that design discussion separate from the current correctness fixes; historical references are linked from the review.

## Architecture

- `js/*-core.js`: generally DOM-free models/codecs; `js/tiles-core.js` expects the shared `P8` core in its execution context.
- `js/app.js`: shell, actions, dialogs, shortcuts, Palette & Fades.
- `js/suite.js`: browser asset storage, consumers, palette providers and Home.
- `js/<tool>.js`: workspace UI and adapters.
- `index.html`: workspaces, menus and F1 help.
- `tools/pico8_bridge.py`: optional loopback HTTP helper; no third-party Python dependencies.

See [EXTENDING.md](EXTENDING.md) before adding a tool, [PROJECT_MODEL.md](docs/PROJECT_MODEL.md) for Cart Builder and [COMPRESSION.md](docs/COMPRESSION.md) for the implemented codec and historical measurements.

