import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_minifier', ROOT / 'tools/package_minifier.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def tar(items):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, data in items.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue()


class PackageTests(unittest.TestCase):
    def fixture(self):
        empty = io.BytesIO()
        with zipfile.ZipFile(empty, 'w'):
            pass
        lock = {'shrinko8': {'commit': 'fixture', 'modules': [], 'bundleSha256': hashlib.sha256(empty.getvalue()).hexdigest()},
                'pyodide': {'files': {'runtime.wasm': {'sha256': hashlib.sha256(b'wasm').hexdigest(), 'bytes': 4}}}}
        return lock, tar({}), tar({'package/runtime.wasm': b'wasm'})

    def test_required_assets_verified_before_any_install(self):
        lock, engine, runtime = self.fixture()
        assets = package.prepare(lock, engine, runtime)
        self.assertEqual(assets['vendor/pyodide/runtime/runtime.wasm'], b'wasm')
        lock['pyodide']['files']['runtime.wasm']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            package.prepare(lock, engine, runtime)

    def test_reject_traversal_and_corrupt_cached_archives(self):
        lock, engine, runtime = self.fixture()
        lock['shrinko8']['modules'] = ['../escape.py']
        with self.assertRaisesRegex(ValueError, 'Invalid engine module'):
            package.prepare(lock, engine, runtime)
        with tempfile.TemporaryDirectory() as directory:
            cached = pathlib.Path(directory) / 'corrupt.tgz'
            cached.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                package.archive_bytes({'url': 'unused', 'sha256': '0' * 64}, cached)


if __name__ == '__main__':
    unittest.main()

class FileModeTests(unittest.TestCase):
    """#162: index.html opened directly reads the runtime from classic scripts written at setup."""

    def make_root(self, directory):
        root = pathlib.Path(directory)
        files = {'pyodide.mjs': b'export const loadPyodide = 1;', 'pyodide.asm.mjs': b'export default 2;',
                 'pyodide-lock.json': b'{"info": {}}', 'pyodide.asm.wasm': bytes(range(256)) * 4, 'python_stdlib.zip': b'PK\x05\x06' + bytes(18)}
        engine = b'PK\x05\x06' + bytes(18)
        lock = {'shrinko8': {'version': 'v', 'commit': 'c', 'bundleSha256': hashlib.sha256(engine).hexdigest()},
                'pyodide': {'version': 'p', 'pythonVersion': '3.x', 'files': {n: {'sha256': hashlib.sha256(d).hexdigest(), 'bytes': len(d)} for n, d in files.items()}}}
        (root / 'vendor/pyodide/runtime').mkdir(parents=True)
        (root / 'vendor/shrinko8/runtime').mkdir(parents=True)
        (root / 'vendor/minifier-lock.json').write_text(json.dumps(lock), encoding='utf-8')
        for name, data in files.items():
            (root / 'vendor/pyodide/runtime' / name).write_bytes(data)
        (root / 'vendor/shrinko8/runtime/engine.zip').write_bytes(engine)
        (root / 'vendor/shrinko8/suite_bridge.py').write_bytes(b'BRIDGE = "\xe2\x99\xa5"\r\n')
        (root / 'vendor/shrinko8/suite_png.py').write_bytes(b'PNG = 1\n')
        return root, files, engine, lock

    def load(self, path, name):
        text = path.read_text(encoding='utf-8')
        prefix = f'self.{name} = '
        body = text[text.index(prefix) + len(prefix):]
        return json.loads(body[:body.rindex(';')])

    def test_bundle_embeds_exactly_the_verified_runtime_and_current_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root, files, engine, lock = self.make_root(directory)
            package.write_file_mode(root)
            assets = self.load(root / package.FILE_ASSETS, 'P8MinifierFileAssets')
            self.assertEqual((assets['format'], assets['pyodideVersion'], assets['bundleSha256']), (1, 'p', lock['shrinko8']['bundleSha256']))
            for name in ('pyodide.asm.wasm', 'python_stdlib.zip'):
                self.assertEqual(base64.b64decode(assets['files'][name]), files[name])
            self.assertEqual(base64.b64decode(assets['files']['engine.zip']), engine)
            self.assertEqual(assets['files']['pyodide.mjs'], files['pyodide.mjs'].decode())
            sources = self.load(root / package.SUITE_SOURCES, 'P8MinifierSuiteSources')
            self.assertEqual(sources['pins'], {'pyodideVersion': 'p', 'pythonVersion': '3.x', 'shrinko8Version': 'v', 'shrinko8Commit': 'c', 'bundleSha256': lock['shrinko8']['bundleSha256']})
            self.assertEqual(sources['python']['suite_bridge.py'], 'BRIDGE = "\u2665"\n')

    def test_unverified_runtime_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root, *_ = self.make_root(directory)
            (root / 'vendor/pyodide/runtime/pyodide.asm.wasm').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'pyodide.asm.wasm'):
                package.write_file_mode(root)
            self.assertFalse((root / package.FILE_ASSETS).exists())
            self.assertFalse((root / package.SUITE_SOURCES).exists())
            self.assertEqual(package.asset_problems(root, json.loads((root / 'vendor/minifier-lock.json').read_text())), ['vendor/pyodide/runtime/pyodide.asm.wasm'])

    def test_committed_suite_sources_match_bridge_files_and_lock(self):
        committed = (ROOT / package.SUITE_SOURCES).read_bytes().decode('utf-8').replace('\r\n', '\n')
        self.assertEqual(committed, package.suite_sources_text(ROOT),
                         'vendor/shrinko8/suite-sources.js is out of date: run python tools/package_minifier.py and commit it')
