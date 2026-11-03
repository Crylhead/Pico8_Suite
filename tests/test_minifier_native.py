"""Real pinned engine tests; run after tools/package_minifier.py. No Pillow/Lua runtime needed."""
import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUNDLE = ROOT / 'vendor/shrinko8/runtime/engine.zip'
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

    def test_single_file_scope_and_options_fail_explicitly(self):
        self.assertEqual(self.run_source('#include missing.lua\nprint(1)')['diagnostics'][0]['code'], 'E_INCLUDE_UNSUPPORTED')
        self.assertTrue(self.run_source('print("#include missing.lua")')['ok'])
        self.assertEqual(self.run_source('print(1)', '../escape.lua')['diagnostics'][0]['code'], 'E_INPUT_INVALID')
        self.assertEqual(self.run_source('print(1)', profile='aggressive')['diagnostics'][0]['code'], 'E_OPTIONS_UNSUPPORTED')
        self.assertEqual(self.run_source('print(1)', target='chars')['diagnostics'][0]['code'], 'E_OPTIONS_UNSUPPORTED')

    def test_zero_improvement_and_p8scii_are_valid_results(self):
        zero = self.run_source('cls()')
        self.assertTrue(zero['ok'], zero)
        self.assertEqual(zero['metrics']['original']['tokens'], zero['metrics']['optimized']['tokens'])
        result = self.run_source('print("♥")')
        self.assertTrue(result['ok'], result)
        self.assertIn('♥', result['lua'])


if __name__ == '__main__':
    unittest.main()
