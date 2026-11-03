#!/usr/bin/env python3
"""Strict real-engine Minifier gate (#145): no silent skips, enforced counts, negative controls.

Run after `python tools/package_minifier.py`. Unlike `unittest discover`, which skips the
native and PNG suites when the Git-ignored engine bundle is absent, this exits non-zero when:
  * vendor/shrinko8/runtime/engine.zip is missing or differs from vendor/minifier-lock.json;
  * any selected test is skipped, fails or errors, or the executed count differs from EXPECTED.

`--negative-controls` instead runs the same suites against deliberately broken temporary copies
(optimizer disabled; PNG payload bits flipped) and exits non-zero unless both are detected.
Nothing is downloaded and no project file is modified.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'vendor/shrinko8/runtime/engine.zip'
ENCODER = ROOT / 'vendor/shrinko8/suite_png.py'
# Update deliberately when real-engine tests are added or removed.
EXPECTED = {'test_minifier_native': 12, 'test_minifier_png': 5}


def verify_bundle():
    shrinko = json.loads((ROOT / 'vendor/minifier-lock.json').read_text())['shrinko8']
    if not BUNDLE.is_file():
        raise SystemExit(f'FAIL: {BUNDLE.relative_to(ROOT)} is missing; run tools/package_minifier.py first.')
    data = BUNDLE.read_bytes()
    if len(data) != shrinko['bundleBytes'] or hashlib.sha256(data).hexdigest() != shrinko['bundleSha256']:
        raise SystemExit('FAIL: engine.zip does not match the pinned bundle in vendor/minifier-lock.json.')
    print(f"Verified pinned Shrinko8 {shrinko['version']} bundle ({len(data):,} bytes, SHA-256 {shrinko['bundleSha256'][:12]}...).")


def run_strict():
    verify_bundle()
    sys.path.insert(0, str(ROOT / 'tests'))
    ok = True
    for module, expected in EXPECTED.items():
        suite = unittest.defaultTestLoader.loadTestsFromName(module)
        result = unittest.TextTestRunner(verbosity=2, stream=sys.stdout).run(suite)
        problems = []
        if result.testsRun != expected:
            problems.append(f'ran {result.testsRun} tests, expected exactly {expected}')
        if result.skipped:
            problems.append(f'{len(result.skipped)} skipped: ' + '; '.join(f'{t.id()} ({why})' for t, why in result.skipped))
        if result.failures or result.errors:
            problems.append(f'{len(result.failures)} failed, {len(result.errors)} errors')
        print(f'{module}: ' + ('FAIL - ' + ' | '.join(problems) if problems else f'{result.testsRun} executed, 0 skipped, all passed'))
        ok = ok and not problems
    if not ok:
        raise SystemExit('FAIL: real-engine Minifier checks did not all execute and pass.')
    print('PASS: real-engine Minifier checks executed with zero skips.')


def child_outcomes(test_ids):
    """Child mode: run the named tests and print {test id: pass|fail|error|skip} as JSON."""
    sys.path.insert(0, str(ROOT / 'tests'))
    outcomes = {}

    class Recorder(unittest.TextTestResult):
        def addSuccess(self, test):
            super().addSuccess(test); outcomes.setdefault(test.id(), 'pass')

        def addSubTest(self, test, subtest, err):
            super().addSubTest(test, subtest, err)
            if err is not None:
                outcomes[test.id()] = 'fail' if issubclass(err[0], test.failureException) else 'error'

        def addFailure(self, test, err):
            super().addFailure(test, err); outcomes[test.id()] = 'fail'

        def addError(self, test, err):
            super().addError(test, err); outcomes[test.id()] = 'error'

        def addSkip(self, test, reason):
            super().addSkip(test, reason); outcomes[test.id()] = 'skip'

    suite = unittest.defaultTestLoader.loadTestsFromNames(test_ids)
    unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=Recorder).run(suite)
    print(json.dumps(outcomes))


def run_with(env, test_ids):
    """Run tests in a fresh interpreter so a broken bundle never shares sys.modules with the real one."""
    command = [sys.executable, str(pathlib.Path(__file__).resolve()), '--child', *test_ids]
    completed = subprocess.run(command, cwd=ROOT, env={**os.environ, **env, 'PYTHONIOENCODING': 'utf-8'},
                               text=True, encoding='utf-8', capture_output=True)
    try:
        outcomes = json.loads(completed.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        outcomes = {}
    return outcomes, completed.stdout + completed.stderr


def broken_engine(directory):
    """Engine copy whose optimizer is a no-op: output must no longer match the recorded goldens."""
    target = pathlib.Path(directory) / 'engine-broken.zip'
    with zipfile.ZipFile(BUNDLE) as source, zipfile.ZipFile(target, 'w') as output:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == 'pico_minify.py':
                data += b'\n\ndef minify_code(ctxt, root, minify_opts):  # negative control\n    return None\n'
            output.writestr(info, data)
    return target


def broken_encoder(directory):
    """Encoder copy that corrupts one ROM bit per pixel; only an independent PNG decode can tell."""
    text = ENCODER.read_text(encoding='utf-8')
    needle = 'byte = rom[x + y * width]'
    if text.count(needle) != 1:
        raise SystemExit('FAIL: negative control could not locate the PNG payload write; update the mutation.')
    target = pathlib.Path(directory) / 'suite_png_broken.py'
    target.write_text(text.replace(needle, needle + ' ^ 1'), encoding='utf-8')
    return target


def run_negative_controls():
    verify_bundle()
    with tempfile.TemporaryDirectory() as directory:
        controls = [
            ('optimizer disabled', {'P8_MINIFIER_ENGINE_ZIP': str(broken_engine(directory))},
             ['test_minifier_native.NativeMinifierTests.test_release_integration_goldens_match_the_pinned_real_engine',
              'test_minifier_native.NativeMinifierTests.test_corpus_matches_goldens_cli_and_is_deterministic']),
            ('PNG payload corrupted', {'P8_MINIFIER_PNG_ENCODER': str(broken_encoder(directory))},
             ['test_minifier_png.PngTests.test_independent_upstream_png_reader_retains_rom_version_code_and_label']),
        ]
        ok = True
        for label, env, tests in controls:
            outcomes, output = run_with(env, tests)
            # Detected means each targeted test itself executed and failed/errored on the broken
            # copy; a skip, a class/import setup error or a pass does not count as detection.
            detected = all(outcomes.get(t) in ('fail', 'error') for t in tests)
            print(f'  outcomes: {outcomes or "none recorded"}')
            print(f'Negative control [{label}]: ' + ('detected (suite failed as required)' if detected else 'NOT DETECTED'))
            if not detected:
                print(output)
            ok = ok and detected
    if not ok:
        raise SystemExit('FAIL: a deliberately broken engine/encoder passed the real-engine checks.')
    print('PASS: real-engine checks reject a broken optimizer and a broken PNG encoder.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--negative-controls', action='store_true', help='prove broken engine/encoder copies are detected')
    parser.add_argument('--child', nargs='+', help=argparse.SUPPRESS)
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):  # P8SCII test names/output on non-UTF-8 consoles
        stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    if args.child:
        child_outcomes(args.child)
    elif args.negative_controls:
        run_negative_controls()
    else:
        run_strict()


if __name__ == '__main__':
    main()
