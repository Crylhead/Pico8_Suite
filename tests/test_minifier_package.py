import hashlib
import importlib.util
import io
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
