"""Optional PNG uses pinned ROM serialization, not Pillow or proprietary runtime data."""
import base64
import builtins
import importlib.util
import json
import os
import pathlib
import random
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Overrides are only for tests/run_minifier_native.py negative controls (broken engine/encoder copies).
BUNDLE = pathlib.Path(os.environ.get('P8_MINIFIER_ENGINE_ZIP') or ROOT / 'vendor/shrinko8/runtime/engine.zip')
ENCODER = pathlib.Path(os.environ.get('P8_MINIFIER_PNG_ENCODER') or ROOT / 'vendor/shrinko8/suite_png.py')
FIXTURE = ROOT / 'tests/fixtures/minifier/release/representative.min.p8'


@unittest.skipUnless(BUNDLE.is_file(), 'Package the pinned Minifier runtime first')
class PngTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(BUNDLE))
        spec = importlib.util.spec_from_file_location('suite_png_test', ENCODER)
        cls.png = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.png)

    def encode(self, text):
        return json.loads(self.png.export_png(text))

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Independent PNG reader test requires local test-only Pillow')
    def test_independent_upstream_png_reader_retains_rom_version_code_and_label(self):
        from pico_cart import read_cart_from_image, read_cart_from_source
        original = read_cart_from_source(FIXTURE.read_text())
        result = self.encode(FIXTURE.read_text())
        self.assertTrue(result['ok'], result)
        data = base64.b64decode(result['base64'])
        parsed = read_cart_from_image(data)
        self.assertEqual(parsed.rom, original.rom)
        self.assertEqual(parsed.code, original.code)
        self.assertEqual(parsed.version_id, original.version_id)
        self.assertEqual(parsed.label.array, original.label.array)
        self.assertEqual(len(data), result['pngBytes'])
        self.assertEqual((result['width'], result['height']), (160, 205))
        self.assertLess(result['compressedBytes'], 15360)
        self.assertNotEqual(result['compressedBytes'], result['pngBytes'])

    def test_encoder_works_when_pillow_imports_are_forbidden(self):
        original_import = builtins.__import__
        def restricted(name, *args, **kwargs):
            if name.startswith('PIL'):
                raise ImportError('Pillow is not in the browser bundle')
            return original_import(name, *args, **kwargs)
        with mock.patch('builtins.__import__', restricted), mock.patch('builtins.open', side_effect=AssertionError('PNG needs no runtime data files')):
            self.assertTrue(self.encode(FIXTURE.read_text())['ok'])

    def test_token_character_and_compressed_capacity_fail_without_partial_png(self):
        header = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n'
        randomizer = random.Random(129)
        noisy = ''.join(randomizer.choice('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') for _ in range(30000))
        for code in ['a=1\n' * 3000, 'x="' + 'a' * 66000 + '"', 'x="' + noisy + '"']:
            with self.subTest(length=len(code)):
                result = self.encode(header + code)
                self.assertFalse(result['ok'])
                self.assertEqual(result['diagnostics'][0]['code'], 'E_PNG_CAPACITY')
                self.assertNotIn('base64', result)
        self.assertTrue(self.encode(FIXTURE.read_text())['ok'])

    def test_invalid_or_unresolved_input_is_refused_without_reading_dependency(self):
        for text in ['cls()', 'pico-8 cartridge\nversion 42\n__lua__\nlocal = 1', 'pico-8 cartridge\nversion 42\n__lua__\n#include secret.lua']:
            result = self.encode(text)
            self.assertFalse(result['ok'])
            self.assertNotIn('base64', result)
