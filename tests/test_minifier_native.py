"""Real pinned engine tests; run after tools/package_minifier.py. No Pillow/Lua runtime needed."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

import minifier_corpus

ROOT = pathlib.Path(__file__).resolve().parents[1]
# The override is only for tests/run_minifier_native.py negative controls (broken engine copies).
BUNDLE = pathlib.Path(os.environ.get('P8_MINIFIER_ENGINE_ZIP') or ROOT / 'vendor/shrinko8/runtime/engine.zip')
FIXTURES = ROOT / 'tests/fixtures/minifier'


@unittest.skipUnless(BUNDLE.is_file(), 'Package the pinned Minifier runtime to run real-engine checks')
class NativeMinifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(BUNDLE))
        spec = importlib.util.spec_from_file_location('suite_minifier_test_bridge', ROOT / 'vendor/shrinko8/suite_bridge.py')
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)

    def run_source(self, text, path='fixture.lua', **options):
        job = {'entryPath': path, 'kind': path.rsplit('.', 1)[1], 'files': [{'path': path, 'text': text}], **options}
        return json.loads(self.bridge.optimize(json.dumps(job)))

    def test_cli_parity_for_lua_and_p8_with_actual_counts(self):
        expected_flags = ['--minify-safe-only', '--no-minify-rename', '--no-minify-lines', '--focus-tokens', '--no-minify-transform']
        for name, counts in [('sample.lua', (16, 11)), ('sample.p8', (15, 10))]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                source = FIXTURES / name
                output = pathlib.Path(directory) / name
                result = self.run_source(source.read_text(), name)
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['flags'], expected_flags)
                command = [sys.executable, '-c', 'import sys;sys.path.insert(0,sys.argv.pop(1));import shrinko8;sys.exit(shrinko8.main())', str(BUNDLE), str(source), str(output), '-F', source.suffix[1:], '-f', source.suffix[1:], *expected_flags, '--input-count', '--count', '--parsable-count', '--error-format', 'common']
                cli = subprocess.run(command, text=True, capture_output=True, check=True)
                actual_text = result['cartText'] if source.suffix == '.p8' else result['lua']
                self.assertEqual(actual_text, output.read_text())
                self.assertEqual((result['metrics']['original']['tokens'], result['metrics']['optimized']['tokens']), counts)
                self.assertIn(f'count:None:tokens:{counts[1]}:8192', cli.stdout)
                self.assertIsNone(result['metrics']['original']['compressedBytes'])
                self.assertIn('compressedReason', result['metrics']['original'])

    def test_invalid_source_is_specific_and_has_no_output(self):
        result = self.run_source((FIXTURES / 'invalid.lua').read_text(), 'invalid.lua')
        self.assertFalse(result['ok'])
        self.assertNotIn('lua', result)
        self.assertEqual(result['diagnostics'][0], {'severity': 'error', 'code': 'E_SHRINKO8', 'message': 'identifier expected', 'file': 'invalid.lua', 'line': 1, 'column': 7})

    def test_no_transform_flag_is_not_itself_a_compiler_hint_rejection(self):
        # Actual upstream behavior: disabling transform can silently ignore a compiler request.
        from shrinko8 import main
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            source = pathlib.Path(directory) / 'hint.lua'
            output = pathlib.Path(directory) / 'out.lua'
            source.write_text('--$switch-compiler:parens8\nprint(1)')
            exit_code = main([str(source), str(output), *self.bridge.FLAGS])
            self.assertIn(exit_code, (None, 0, 2))
            self.assertTrue(output.is_file())
        for text in ['--$switch-compiler:parens8\nprint(1)', '--[[$dynamic-include:foo]]\nprint(1)', '--[[$deflanguage:alias=parens8]]\nprint(1)', '--[[language::foo]] "text"']:
            self.assertEqual(self.run_source(text)['diagnostics'][0]['code'], 'E_TRANSFORM_UNSUPPORTED')
        self.assertTrue(self.run_source('local s="--$switch-compiler:parens8"\nprint(s)')['ok'])

    def test_missing_include_and_options_fail_explicitly(self):
        self.assertEqual(self.run_source('#include missing.lua\nprint(1)')['diagnostics'][0]['code'], 'E_INCLUDE_MISSING')
        self.assertTrue(self.run_source('print("#include missing.lua")')['ok'])
        self.assertEqual(self.run_source('print(1)', '../escape.lua')['diagnostics'][0]['code'], 'E_INPUT_INVALID')
        self.assertEqual(self.run_source('print(1)', profile='aggressive')['diagnostics'][0]['code'], 'E_OPTIONS_UNSUPPORTED')
        self.assertEqual(self.run_source('print(1)', target='chars')['diagnostics'][0]['code'], 'E_OPTIONS_UNSUPPORTED')

    def run_tree(self, files, entry='main.lua'):
        job = {'entryPath': entry, 'kind': entry.rsplit('.', 1)[1], 'files': [{'path': path, 'text': text} for path, text in files.items()]}
        return json.loads(self.bridge.optimize(json.dumps(job)))

    def test_builtin_include_tree_matches_cli_counts_and_output(self):
        folder = FIXTURES / 'project'
        files = {p.relative_to(folder).as_posix(): p.read_bytes().decode('utf-8') for p in folder.rglob('*') if p.is_file() and p.suffix in ('.lua', '.p8')}
        result = self.run_tree(files, 'main.p8')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['lua'].count('repeat'), 2)
        self.assertIn('selected', result['lua'])
        self.assertNotIn('not_selected', result['lua'])
        self.assertIn('♥', result['lua'])
        self.assertRegex(result['cartText'], r'version 42\n')
        self.assertTrue(any(d['code'] == 'W_BUILD_DIRECTIVE' for d in result['diagnostics']))
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / 'result.p8'
            command = [sys.executable, '-c', 'import sys;sys.path.insert(0,sys.argv.pop(1));import shrinko8;sys.exit(shrinko8.main())', str(BUNDLE), str(folder / 'main.p8'), str(output), *self.bridge.FLAGS, *self.bridge.COUNT_FLAGS]
            cli = subprocess.run(command, text=True, capture_output=True, check=True)
            self.assertEqual(result['cartText'], output.read_text())
            for side, prefix in [('original', 'input'), ('optimized', 'None')]:
                self.assertIn(f'count:{prefix}:tokens:{result["metrics"][side]["tokens"]}:8192', cli.stdout)
                self.assertIn(f'count:{prefix}:chars:{result["metrics"][side]["characters"]}:65535', cli.stdout)

    def test_unsafe_trees_never_return_output(self):
        cart = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n'
        cases = [
            ({'main.lua': '#include lib.lua', 'lib.lua': '#include main.lua'}, 'E_INCLUDE_CYCLE'),
            ({'main.lua': '#include ../outside.lua'}, 'E_INCLUDE_MISSING'),
            ({'main.lua': '#include x.lua', 'X.lua': 'cls()'}, 'E_INCLUDE_MISSING'),
            ({'main.lua': 'cls()', 'LIB.lua': 'cls()', 'lib.lua': 'flip()'}, 'E_INCLUDE_AMBIGUOUS'),
            ({'main.lua': '#include "space name.lua"', 'space name.lua': 'cls()'}, 'E_INCLUDE_PATH'),
            ({'main.lua': '#include tabs.p8:9', 'tabs.p8': cart + 'cls()'}, 'E_INCLUDE_TAB'),
            ({'main.lua': '#include tabs.p8:1', 'tabs.p8': cart + '#include lib.lua\n-->8\ncls()', 'lib.lua': 'cls()'}, 'E_INCLUDE_SEMANTICS'),
            ({'main.lua': '#compile test\ncls()'}, 'E_DIRECTIVE_UNSUPPORTED'),
            ({'main.lua': '--$unknown-compiler:foo\ncls()'}, 'E_TRANSFORM_UNSUPPORTED'),
            # Real upstream discrepancy: level-one long string is mistaken for an include by its preprocessor.
            ({'main.lua': 'local s=[=[\n#include lib.lua\n]=]\nprint(s)', 'lib.lua': 'print(1)'}, 'E_INCLUDE_SEMANTICS'),
        ]
        for files, code in cases:
            with self.subTest(files=files):
                result = self.run_tree(files)
                self.assertFalse(result['ok'], result)
                self.assertEqual(result['diagnostics'][0]['code'], code, result)
                self.assertNotIn('lua', result)
                self.assertNotIn('cartText', result)

    def test_zero_improvement_and_p8scii_are_valid_results(self):
        zero = self.run_source('cls()')
        self.assertTrue(zero['ok'], zero)
        self.assertEqual(zero['metrics']['original']['tokens'], zero['metrics']['optimized']['tokens'])
        result = self.run_source('print("♥")')
        self.assertTrue(result['ok'], result)
        self.assertIn('♥', result['lua'])

    def test_release_integration_goldens_match_the_pinned_real_engine(self):
        data = json.loads((FIXTURES / 'release/engine-results.json').read_text())
        lock = json.loads((ROOT / 'vendor/minifier-lock.json').read_text())
        self.assertEqual(data['engine']['shrinko8Commit'], lock['shrinko8']['commit'])
        self.assertEqual(data['engine']['pyodideVersion'], lock['pyodide']['version'])
        for case in data['cases']:
            with self.subTest(case=case['name']):
                actual = json.loads(self.bridge.optimize(json.dumps(case['source'])))
                self.assertEqual(actual, case['result'])

    def test_exported_carts_retain_assets_with_an_independent_native_reader(self):
        from pico_cart import CartFormat, read_cart
        from pico_defs import from_p8str
        header = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n'
        text = header + '--[[keep:source note]]\nprint("♥")\n-->8\nreload(0x8000,0,4,"data.p8") --@data entry.bin\n__gfx__\n12345678\n__map__\n0011fe\n__gff__\n00ff\n__music__\n03 00010203\n__sfx__\n00100000' + '01873' * 32 + '\n__label__\n0123456789abcdef\n__data__\n00ff1122\n__meta:title__\nNative asset check\n'
        # Node builds through the actual export module; Shrinko8's separate native reader
        # then decodes its bytes, rather than trusting the JavaScript cart round trip.
        script = r'''
const fs = require('fs'), C = require('./js/minifier-core.js'), E = require('./js/minifier-export-core.js');
const { engine } = require('./tests/minifier-fixtures.js');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
let s = C.transition(C.initialState(), {type:'source',source:data.source});
s = C.transition(s,{type:'ready',engine:engine()}); s = C.transition(s,{type:'start'});
s = C.transition(s,{type:'complete',job:s.activeJob,result:data.result});
process.stdout.write(JSON.stringify(E.build(s,{...C.prepareInput(data.source),sourceRevision:s.sourceRevision})));
'''
        for original in [text, text.replace('\n', '\r\n'), header + '-- comment only\n__gfx__\n__music__\n__sfx__\n', (FIXTURES / 'release/representative.p8').read_text()]:
            with self.subTest(crlf='\r\n' in original), tempfile.TemporaryDirectory() as directory:
                result = self.run_source(original, 'assets.p8')
                self.assertTrue(result['ok'], result)
                source = {'entryPath': 'assets.p8', 'kind': 'p8', 'files': [{'path': 'assets.p8', 'text': original}]}
                node = subprocess.run(['node', '-e', script], input=json.dumps({'source': source, 'result': result}), text=True, capture_output=True, cwd=ROOT, check=False)
                self.assertEqual(node.returncode, 0, node.stderr)
                artifacts = json.loads(node.stdout)
                before = pathlib.Path(directory) / 'before.p8'
                after = pathlib.Path(directory) / artifacts['cart']['filename']
                before.write_bytes(original.encode('utf-8'))
                after.write_bytes(artifacts['cart']['text'].encode('utf-8'))
                a, b = read_cart(str(before), CartFormat.p8), read_cart(str(after), CartFormat.p8)
                self.assertEqual(a.rom, b.rom)
                self.assertEqual(a.version_id, b.version_id)
                self.assertEqual(a.label.array if a.label else None, b.label.array if b.label else None)
                self.assertEqual(from_p8str(b.code).rstrip('\n'), result['lua'].rstrip('\n'))
                non_lua = original[original.index('__gfx__'):]
                self.assertTrue(artifacts['cart']['text'].endswith(non_lua))
                self.assertEqual(artifacts['lua']['text'], result['lua'])

    # --- #148 compatibility corpus -------------------------------------------------------------
    def test_corpus_matches_goldens_cli_and_is_deterministic(self):
        corpus = minifier_corpus.manifest()
        golden = minifier_corpus.goldens()
        lock = json.loads((ROOT / 'vendor/minifier-lock.json').read_text())
        self.assertEqual(golden['engine']['shrinko8Commit'], lock['shrinko8']['commit'])
        self.assertGreaterEqual(len(corpus['cases']), 6)
        for case in corpus['cases']:
            with self.subTest(case=case['name']), tempfile.TemporaryDirectory() as directory:
                files = minifier_corpus.files_for(case)
                job = minifier_corpus.job(case['entry'], files)
                first = json.loads(self.bridge.optimize(json.dumps(job)))
                second = json.loads(self.bridge.optimize(json.dumps(job)))
                self.assertTrue(first['ok'], first)
                self.assertEqual(first, second, 'same input must give identical output')
                self.assertEqual(first, golden['cases'][case['name']], 'output differs from the recorded pinned-engine result')
                self.assertEqual(first['flags'], self.bridge.FLAGS, 'fixed Minimal + Tokens preset')
                # The same files through the pinned upstream CLI with the same flags.
                folder = pathlib.Path(directory)
                for rel, text in files.items():
                    (folder / rel).parent.mkdir(parents=True, exist_ok=True)
                    (folder / rel).write_bytes(text.encode('utf-8'))
                output = folder / ('out.' + case['entry'].rsplit('.', 1)[1])
                command = [sys.executable, '-c', 'import sys;sys.path.insert(0,sys.argv.pop(1));import shrinko8;sys.exit(shrinko8.main())', str(BUNDLE), str(folder / case['entry']), str(output), *self.bridge.FLAGS, *self.bridge.COUNT_FLAGS]
                cli = subprocess.run(command, text=True, capture_output=True, check=True)
                self.assertEqual(first['cartText'] if case['entry'].endswith('.p8') else first['lua'], output.read_bytes().decode('utf-8'))
                for side, prefix in [('original', 'input'), ('optimized', 'None')]:
                    self.assertIn(f'count:{prefix}:tokens:{first["metrics"][side]["tokens"]}:8192', cli.stdout)
                    self.assertIn(f'count:{prefix}:chars:{first["metrics"][side]["characters"]}:65535', cli.stdout)
                self.assertLessEqual(first['metrics']['optimized']['tokens'], first['metrics']['original']['tokens'])

    def test_corpus_exports_keep_every_cart_section_with_an_independent_reader(self):
        from pico_cart import read_cart_from_source
        from pico_defs import from_p8str
        golden = minifier_corpus.goldens()
        for case in [c for c in minifier_corpus.manifest()['cases'] if c['entry'].endswith('.p8')]:
            with self.subTest(case=case['name']):
                files = minifier_corpus.files_for(case)
                result = golden['cases'][case['name']]
                built = minifier_corpus.export(minifier_corpus.job(case['entry'], files), result)
                original = files[case['entry']]
                a = read_cart_from_source(original, preprocess_hook=lambda path, code, *args, **opts: (code, []))
                b = read_cart_from_source(built['cart']['text'])
                self.assertEqual(a.rom, b.rom, 'gfx/map/flags/sfx/music bytes')
                self.assertEqual(a.version_id, b.version_id)
                self.assertEqual(a.label.array if a.label else None, b.label.array if b.label else None)
                self.assertEqual(from_p8str(b.code).rstrip('\n'), result['lua'].rstrip('\n'))
                self.assertTrue(built['cart']['text'].endswith(original[original.index('__gfx__'):] if '__gfx__' in original else ''))
                if '__meta:title__' in original:
                    self.assertIn('__meta:title__\ncorpus assets\n', built['cart']['text'])

    def test_corpus_negatives_refuse_with_actionable_codes_and_no_export(self):
        golden = minifier_corpus.goldens()
        negatives = minifier_corpus.manifest()['negative']
        self.assertGreaterEqual(len(negatives), 7)
        for case in negatives:
            with self.subTest(case=case['name']):
                job = minifier_corpus.job(case['entry'], case['files'])
                result = json.loads(self.bridge.optimize(json.dumps(job)))
                self.assertEqual(result, golden['negative'][case['name']])
                self.assertFalse(result['ok'])
                self.assertNotIn('lua', result)
                self.assertNotIn('cartText', result)
                diagnostic = result['diagnostics'][0]
                self.assertEqual((diagnostic['severity'], diagnostic['code']), ('error', case['code']))
                self.assertGreater(len(diagnostic['message']), 10, 'message says what to fix')
                self.assertEqual(minifier_corpus.export(job, result), {'canExport': False, 'built': False})


if __name__ == '__main__':
    unittest.main()
