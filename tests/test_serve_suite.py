import functools
import hashlib
import http.server
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import serve_suite as serve


class ServeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='suite with spaces ')
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.assets = {'vendor/shrinko8/runtime/engine.zip': b'engine', 'vendor/pyodide/runtime/runtime.mjs': b'export const fixture=1;'}
        self.lock = {'shrinko8': {'bundleSha256': hashlib.sha256(b'engine').hexdigest()},
                     'pyodide': {'files': {'runtime.mjs': {'sha256': hashlib.sha256(self.assets['vendor/pyodide/runtime/runtime.mjs']).hexdigest(), 'bytes': 23}}}}
        (self.root / 'vendor').mkdir()
        (self.root / 'vendor/minifier-lock.json').write_text(json.dumps(self.lock))
        (self.root / 'index.html').write_text('<title>Suite fixture</title>')

    def test_valid_assets_reused_offline_and_corruption_repaired_through_verified_packager(self):
        serve.package.install(self.assets, self.root)
        with mock.patch.object(serve.package, 'archive_bytes', side_effect=AssertionError('offline')):
            serve.ensure_assets(self.root)
        (self.root / 'vendor/pyodide/runtime/runtime.mjs').write_bytes(b'corrupt')
        self.assertEqual(serve.asset_problems(self.root, self.lock), ['vendor/pyodide/runtime/runtime.mjs'])
        with mock.patch.object(serve.package, 'archive_bytes', side_effect=[b'shrinko', b'pyodide']) as read, mock.patch.object(serve.package, 'prepare', return_value=self.assets) as prepare:
            serve.ensure_assets(self.root, 'engine.tar.gz', 'python.tgz')
        self.assertEqual([c.args[1] for c in read.call_args_list], ['engine.tar.gz', 'python.tgz'])
        prepare.assert_called_once_with(self.lock, b'shrinko', b'pyodide')
        self.assertEqual(serve.asset_problems(self.root, self.lock), [])

    def test_setup_failure_never_opens_browser_or_serves_and_keeps_existing_files(self):
        before = (self.root / 'index.html').read_bytes()
        with mock.patch.object(serve.package, 'archive_bytes', side_effect=ValueError('SHA-256 mismatch')), mock.patch.object(serve.webbrowser, 'open') as opened, mock.patch.object(http.server.ThreadingHTTPServer, 'serve_forever') as started:
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                serve.run(self.root, port=0)
        opened.assert_not_called(); started.assert_not_called()
        self.assertEqual((self.root / 'index.html').read_bytes(), before)

    def test_busy_port_does_not_prepare_open_or_change_port(self):
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), serve.SuiteHandler) as occupied:
            with mock.patch.object(serve, 'ensure_assets') as prepare, mock.patch.object(serve.webbrowser, 'open') as opened:
                with self.assertRaises(OSError):
                    serve.run(self.root, port=occupied.server_port)
            prepare.assert_not_called(); opened.assert_not_called()

    def test_browser_opens_only_after_verified_setup_and_successful_bind(self):
        steps = []
        with mock.patch.object(serve, 'ensure_assets', side_effect=lambda *a: steps.append('verified')), mock.patch.object(serve.webbrowser, 'open', side_effect=lambda url, **kwargs: steps.append(url) or True) as opened, mock.patch.object(http.server.ThreadingHTTPServer, 'serve_forever', side_effect=lambda: steps.append('serving')):
            serve.run(self.root, port=0)
        self.assertEqual(opened.call_args.kwargs, {'new': 2})
        self.assertEqual(steps[0], 'verified')
        self.assertRegex(steps[1], r'^http://127\.0\.0\.1:\d+/index.html#minifier$')
        self.assertEqual(steps[2], 'serving')

    def test_actual_static_server_has_module_mime_and_cannot_serve_hidden_or_outside_files(self):
        serve.package.install(self.assets, self.root)
        (self.root / '.private').write_text('hidden')
        (self.root / 'folder').mkdir()
        server = serve.SuiteServer(('127.0.0.1', 0), functools.partial(serve.SuiteHandler, directory=str(self.root)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}'
            with urllib.request.urlopen(url + '/index.html') as response:
                self.assertIn(b'Suite fixture', response.read())
            with urllib.request.urlopen(url + '/vendor/pyodide/runtime/runtime.mjs') as response:
                self.assertEqual(response.headers.get_content_type(), 'text/javascript')
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url + '/index.html', headers={'Host': 'unrelated.example'}))
            self.assertEqual(error.exception.code, 400)
            for target in ['/.private', '/folder/', '/../../etc/passwd']:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url + target)
                self.assertEqual(error.exception.code, 404)
            with tempfile.NamedTemporaryFile() as outside:
                try:
                    (self.root / 'outside').symlink_to(outside.name)
                except OSError:
                    return  # Windows may require symlink permission; the remaining boundary tests still run.
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url + '/outside')
                self.assertEqual(error.exception.code, 404)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
