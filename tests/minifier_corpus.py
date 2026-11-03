"""Shared helpers for the Minifier compatibility corpus (#148); used by the real-engine tests.

Sources are read with CRLF normalized to LF, so a Windows checkout and Linux CI build the same
jobs. Regenerate tests/fixtures/minifier/corpus/engine-results.json only after deliberately
changing a fixture or the engine pin (see docs/MINIFIER_ACCEPTANCE.md).
"""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
CORPUS = ROOT / 'tests/fixtures/minifier/corpus'

# Builds the downloadable cart through the actual export module, as the browser does.
EXPORT_SCRIPT = r'''
const fs = require('fs'), C = require('./js/minifier-core.js'), E = require('./js/minifier-export-core.js');
const { engine } = require('./tests/minifier-fixtures.js');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
let s = C.transition(C.initialState(), {type:'source',source:data.source});
s = C.transition(s,{type:'ready',engine:engine()}); s = C.transition(s,{type:'start'});
if (!data.result.ok) {
  // A refused job enters the state as a failure, exactly like a failed worker reply.
  s = C.transition(s,{type:'failure',job:s.activeJob,diagnostics:data.result.diagnostics});
  let built = true; try { E.build(s,{...C.prepareInput(data.source),sourceRevision:s.sourceRevision}); } catch { built = false; }
  process.stdout.write(JSON.stringify({ canExport: C.canExport(s), built })); process.exit(0);
}
s = C.transition(s,{type:'complete',job:s.activeJob,result:data.result});
process.stdout.write(JSON.stringify(E.build(s,{...C.prepareInput(data.source),sourceRevision:s.sourceRevision})));
'''


def read(path):
    return path.read_bytes().decode('utf-8').replace('\r\n', '\n')


def manifest():
    return json.loads(read(CORPUS / 'manifest.json'))


def goldens():
    return json.loads(read(CORPUS / 'engine-results.json'))


def files_for(case):
    """{relative path: text} for a positive case: the entry alone, or every source under its root."""
    folder = CORPUS / case['root']
    paths = [folder / case['entry']] if case['root'] == '.' else sorted(p for p in folder.rglob('*') if p.suffix in ('.lua', '.p8'))
    return {p.relative_to(folder).as_posix(): read(p) for p in paths}


def job(entry, files):
    return {'entryPath': entry, 'kind': entry.rsplit('.', 1)[1], 'files': [{'path': p, 'text': t} for p, t in files.items()]}


def export(source, result):
    """Run the real JavaScript exporter in Node; returns its parsed JSON output."""
    node = subprocess.run(['node', '-e', EXPORT_SCRIPT], input=json.dumps({'source': source, 'result': result}),
                          text=True, encoding='utf-8', capture_output=True, cwd=ROOT, check=False)
    if node.returncode != 0:
        raise AssertionError(node.stderr)
    return json.loads(node.stdout)


def regenerate():
    """Re-record engine-results.json from the packaged pinned engine. Run deliberately, then review the diff."""
    import importlib.util
    import sys
    sys.path.insert(0, str(ROOT / 'vendor/shrinko8/runtime/engine.zip'))
    spec = importlib.util.spec_from_file_location('corpus_bridge', ROOT / 'vendor/shrinko8/suite_bridge.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    lock = json.loads(read(ROOT / 'vendor/minifier-lock.json'))
    out = {'engine': {'shrinko8Version': lock['shrinko8']['version'], 'shrinko8Commit': lock['shrinko8']['commit']}, 'cases': {}, 'negative': {}}
    data = manifest()
    for case in data['cases']:
        result = json.loads(bridge.optimize(json.dumps(job(case['entry'], files_for(case)))))
        if not result['ok']:
            raise SystemExit(f"{case['name']}: {result['diagnostics']}")
        out['cases'][case['name']] = result
    for case in data['negative']:
        result = json.loads(bridge.optimize(json.dumps(job(case['entry'], case['files']))))
        if result['ok'] or result['diagnostics'][0]['code'] != case['code']:
            raise SystemExit(f"{case['name']}: expected {case['code']}, got {result}")
        out['negative'][case['name']] = result
    (CORPUS / 'engine-results.json').write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    print(f"Recorded {len(out['cases'])} cases and {len(out['negative'])} negative cases.")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Minifier compatibility corpus (#148)')
    parser.add_argument('--write', action='store_true', help='re-record engine-results.json from the packaged engine')
    if parser.parse_args().write:
        regenerate()
    else:
        parser.print_help()
