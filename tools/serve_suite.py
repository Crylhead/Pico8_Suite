#!/usr/bin/env python3
"""Prepare pinned Minifier assets and serve the Suite on loopback. Python 3.9+, no dependencies."""
import argparse
import functools
import hashlib
import http.server
import json
import pathlib
import socket
import sys
import webbrowser

import package_minifier as package

ROOT = pathlib.Path(__file__).resolve().parents[1]


class SuiteServer(http.server.ThreadingHTTPServer):
    allow_reuse_port = False

    def server_bind(self):
        # Winsock SO_REUSEADDR can share an occupied port; request exclusive ownership instead.
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def asset_problems(root, lock):
    records = {'vendor/shrinko8/runtime/engine.zip': {'sha256': lock['shrinko8']['bundleSha256']}}
    for name, record in lock['pyodide']['files'].items():
        if '/' in name or '\\' in name or name in ('.', '..'):
            raise ValueError('Invalid runtime asset name')
        records['vendor/pyodide/runtime/' + name] = record
    problems = []
    for name, record in records.items():
        try:
            data = (root / name).read_bytes()
            if hashlib.sha256(data).hexdigest() != record['sha256'] or ('bytes' in record and len(data) != record['bytes']):
                problems.append(name)
        except OSError:
            problems.append(name)
    return problems


def ensure_assets(root, shrinko_archive=None, pyodide_archive=None):
    lock = json.loads((root / 'vendor/minifier-lock.json').read_text(encoding='utf-8'))
    if not asset_problems(root, lock):
        print('Pinned Minifier assets verified; no download needed.', flush=True)
        return
    print('Preparing pinned Minifier assets. First setup needs Internet, or the two local archive options. No user source is uploaded.', flush=True)
    assets = package.prepare(lock, package.archive_bytes(lock['shrinko8'], shrinko_archive),
                             package.archive_bytes(lock['pyodide'], pyodide_archive))
    package.install(assets, root)
    if asset_problems(root, lock):
        raise ValueError('Installed Minifier assets failed verification')
    print('Minifier assets installed and verified.', flush=True)


class SuiteHandler(http.server.SimpleHTTPRequestHandler):
    # Windows MIME registries may map .js/.mjs to text/plain; module workers need JavaScript MIME.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}

    def send_head(self):
        port = self.server.server_port
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if port == 80:
            hosts.update({'127.0.0.1', 'localhost'})
        if self.headers.get('Host', '').lower() not in hosts:
            self.send_error(400, 'Use the localhost URL printed by the launcher')
            return None
        root = pathlib.Path(self.directory).resolve()
        target = pathlib.Path(self.translate_path(self.path)).resolve()
        try:
            relative = target.relative_to(root)
        except ValueError:
            self.send_error(404)
            return None
        if any(part.startswith('.') for part in relative.parts):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404, 'Directory listings are disabled')
        return None

    def log_message(self, format, *args):
        # Only print the startup URL/errors, not local file request paths.
        pass


def run(root, port=8000, open_browser=True, shrinko_archive=None, pyodide_archive=None):
    if not (root / 'index.html').is_file():
        raise ValueError('Suite index.html is missing; restore the complete Suite folder')
    handler = functools.partial(SuiteHandler, directory=str(root))
    # Reserve the stable address before downloading or opening anything. Never fall back to a different origin.
    with SuiteServer(('127.0.0.1', port), handler) as server:
        ensure_assets(root, shrinko_archive, pyodide_archive)
        url = f'http://127.0.0.1:{server.server_port}/index.html#minifier'
        print(f'Suite ready: {url}', flush=True)
        print('Keep this window open. Press Ctrl+C to stop. Browser storage belongs to this address.', flush=True)
        if open_browser:
            try:
                if not webbrowser.open(url, new=2):
                    print('Could not open a browser automatically. Open the URL above.', flush=True)
            except webbrowser.Error:
                print('Could not open a browser automatically. Open the URL above.', flush=True)
        server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000, help='Stable local port (default 8000); changing it changes browser storage origin')
    parser.add_argument('--no-browser', action='store_true', help='Print the URL without opening a browser')
    parser.add_argument('--shrinko-archive', help='Use the pinned Shrinko8 .tar.gz from disk')
    parser.add_argument('--pyodide-archive', help='Use the pinned Pyodide .tgz from disk')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')
    try:
        if sys.version_info < (3, 9):
            raise ValueError('Install Python 3.9 or newer to use this optional local launcher')
        run(ROOT, args.port, not args.no_browser, args.shrinko_archive, args.pyodide_archive)
    except KeyboardInterrupt:
        print('\nSuite server stopped.')
    except Exception as error:
        print(f'Could not start Suite: {error}\nClose another server on port {args.port}, or use --port with a fixed alternative.\nFor offline setup, supply --shrinko-archive and --pyodide-archive with the pinned archives. No browser was opened before setup/binding succeeded.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
