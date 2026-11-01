#!/usr/bin/env python3
"""PICO-8 bridge for the PICO-8 Dev Suite: lets the Code Editor run carts in PICO-8.

A browser page cannot start programs, so this small local server does it. It listens on
127.0.0.1 only.

    python pico8_bridge.py [--pico8 PATH] [--root FOLDER] ... [--port 8708]

Pairing: at startup the bridge prints a random token. Paste it once into the Code Editor
(Cart -> Set Up Run...); the editor sends it in the X-Bridge-Token header. /run, /stop and
/log need that token, and /ping only reports paths to a paired caller. The token changes
every time the bridge starts. Loopback binding and CORS are not authentication: the token is.

Every request must use Host 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding).
Browser origins allowed: null (a file:// page), file://, and http(s)://127.0.0.1 or
http(s)://localhost on any port; other web origins are refused. Requests without an Origin
header (command-line clients) are allowed but still need the token.

The editor sends the cart's name and text. The bridge looks for that file (same name, same
content: the editor saves it first) in the roots - PICO-8's carts folder (root_path in
config.txt) and every --root - and runs it there, so #include, reload() and load() find their
neighbours. A cart that is not on disk is written to <carts>/_suite_run/ and run from there.
printh() output is collected for the editor's output panel.

Only the Python standard library is used.
"""

import argparse
import collections
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = 2
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'backup', 'bbs', '.vs', '.idea'}
MAX_DEPTH = 6
ALLOWED_ORIGIN = re.compile(r'^(null|file://|https?://(localhost|127\.0\.0\.1)(:\d{1,5})?)$')
TOKEN_HEADER = 'X-Bridge-Token'
MAX_BODY = 4 * 1024 * 1024  # a .p8 is far smaller, even JSON-escaped
MAX_NAME = 255
CART_NAME = re.compile(r'^[^/\\:*?"<>|\x00-\x1f\x7f]+\.p8$', re.IGNORECASE)
# path -> (method, needs token)
ROUTES = {'/ping': ('GET', False), '/log': ('GET', True), '/run': ('POST', True), '/stop': ('POST', True)}


def find_pico8(explicit):
    """pico8 executable: --pico8, PICO8 env var, PATH, the usual install folders."""
    candidates = [explicit, os.environ.get('PICO8'), shutil.which('pico8'), shutil.which('pico8.exe')]
    if os.name == 'nt':
        for base in (os.environ.get('ProgramFiles(x86)'), os.environ.get('ProgramFiles'), os.environ.get('LOCALAPPDATA')):
            if base:
                candidates.append(os.path.join(base, 'PICO-8', 'pico8.exe'))
    elif sys.platform == 'darwin':
        candidates.append('/Applications/PICO-8.app/Contents/MacOS/pico8')
    else:
        candidates += [os.path.expanduser('~/pico-8/pico8'), '/opt/pico-8/pico8']
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def pico8_home():
    if os.name == 'nt':
        return os.path.join(os.environ.get('APPDATA', ''), 'pico-8')
    if sys.platform == 'darwin':
        return os.path.expanduser('~/Library/Application Support/pico-8')
    return os.path.expanduser('~/.lexaloffle/pico-8')


def carts_root():
    """root_path from PICO-8's config.txt, else <home>/carts."""
    home = pico8_home()
    try:
        with open(os.path.join(home, 'config.txt'), encoding='utf-8', errors='replace') as f:
            for line in f:
                m = re.match(r'\s*root_path\s+(.+?)\s*$', line)
                if m and m.group(1):
                    return os.path.normpath(m.group(1))
    except OSError:
        pass
    return os.path.join(home, 'carts')


def norm(text):
    return text.replace('\r\n', '\n').replace('\r', '\n')


class Runner:
    """One PICO-8 process at a time, with its printh() output."""

    def __init__(self, exe, roots, launcher=None):
        self.exe = exe
        self.roots = roots
        self.launcher = launcher or subprocess.Popen  # tests inject a fake process
        self.proc = None
        self.path = None
        self.log = collections.deque(maxlen=2000)
        self.seq = 0
        self.lock = threading.Lock()  # log
        # process lifecycle: run/stop are serialized so no started process is ever lost
        self.proc_lock = threading.Lock()
        self.known = {}  # name (lower) -> path that matched before

    def add_log(self, line):
        with self.lock:
            self.seq += 1
            self.log.append((self.seq, line))

    def find(self, name, text):
        """the file called `name` whose content is `text` (newest first), or None"""
        want = norm(text)
        low = name.lower()

        def same(path):
            try:
                with open(path, encoding='utf-8', errors='replace', newline='') as f:
                    return norm(f.read()) == want
            except OSError:
                return False

        hit = self.known.get(low)
        if hit and same(hit):
            return hit
        found = []
        for root in self.roots:
            if not os.path.isdir(root):
                continue
            base_depth = root.rstrip(os.sep).count(os.sep)
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d.lower() not in SKIP_DIRS and not d.startswith('.')]
                if dirpath.count(os.sep) - base_depth >= MAX_DEPTH:
                    dirnames[:] = []
                for fn in filenames:
                    if fn.lower() == low:
                        p = os.path.join(dirpath, fn)
                        if same(p):
                            found.append(p)
        if not found:
            return None
        found.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        self.known[low] = found[0]
        return found[0]

    def stop(self):
        with self.proc_lock:
            self._stop_locked()

    def _stop_locked(self):
        p = self.proc
        self.proc = None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(3)
            except subprocess.TimeoutExpired:
                p.kill()
                try:
                    p.wait(3)
                except subprocess.TimeoutExpired:
                    self.add_log('--- pico-8 did not exit after kill')

    def run(self, name, text):
        if not self.exe:
            raise RuntimeError('pico8 executable not found: start the bridge with --pico8 PATH')
        if not CART_NAME.match(name) or len(name) > MAX_NAME or os.path.basename(name) != name:
            raise ValueError('name must be a plain .p8 file name')
        with self.proc_lock:
            path = self.find(name, text)
            temp = path is None
            if temp:
                folder = os.path.join(self.roots[0], '_suite_run')
                os.makedirs(folder, exist_ok=True)
                path = os.path.join(folder, name)
                with open(path, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(norm(text))
            self._stop_locked()
            self.add_log(f'--- run {path}')
            kw = {}
            if os.name == 'nt':
                kw['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
            proc = self.launcher([self.exe, '-run', path], cwd=os.path.dirname(path), stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kw)
            self.proc = proc
            self.path = path
            threading.Thread(target=self._pump, args=(proc,), daemon=True).start()
            return path, temp

    def _pump(self, proc):
        for raw in iter(proc.stdout.readline, b''):
            self.add_log(raw.decode('utf-8', errors='replace').rstrip('\r\n'))
        code = proc.wait()
        self.add_log(f'--- pico-8 exited ({code})')

    def running(self):
        p = self.proc
        return bool(p and p.poll() is None)


class BadRequest(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Handler(BaseHTTPRequestHandler):
    server_version = 'PICO8Bridge/2'

    def log_message(self, fmt, *args):
        pass

    @property
    def runner(self):
        return self.server.runner

    def host_ok(self):
        port = self.server.server_address[1]
        host = (self.headers.get('Host') or '').strip().lower()
        allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if port == 80:
            allowed |= {'127.0.0.1', 'localhost'}
        return host in allowed and len(self.headers.get_all('Host') or []) == 1

    def origin_ok(self):
        origins = self.headers.get_all('Origin') or []
        return not origins or (
            len(origins) == 1
            and '\r' not in origins[0]
            and '\n' not in origins[0]
            and bool(ALLOWED_ORIGIN.fullmatch(origins[0]))
        )

    def token_ok(self):
        given = self.headers.get(TOKEN_HEADER)
        return given is not None and hmac.compare_digest(given.encode('utf-8', 'replace'), self.server.token.encode('utf-8'))

    def cors_headers(self):
        origin = self.headers.get('Origin')
        if origin and self.origin_ok():
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            # Chrome's private network access preflight
            self.send_header('Access-Control-Allow-Private-Network', 'true')

    def send_json(self, code, obj, extra=None):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if code >= 400:
            # the request body may be unread: never reuse this connection
            self.close_connection = True
            self.send_header('Connection', 'close')
        self.cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, message, extra=None):
        self.send_json(code, {'ok': False, 'error': message}, extra)

    def check(self, method):
        """common validation; -> (path, query) or None after answering"""
        if not self.host_ok():
            self.fail(403, 'host not allowed')
            return None
        if not self.origin_ok():
            self.fail(403, 'origin not allowed')
            return None
        url = urlparse(self.path)
        if not self.path.startswith('/') or url.scheme or url.netloc or url.path not in ROUTES:
            self.fail(404, 'unknown path')
            return None
        want, needs_token = ROUTES[url.path]
        if method != 'OPTIONS':
            if method != want:
                self.fail(405, 'method not allowed', {'Allow': f'{want}, OPTIONS'})
                return None
            if url.query and url.path != '/log':
                self.fail(400, 'unexpected query')
                return None
            if needs_token and not self.token_ok():
                self.fail(401, 'not paired: paste the token printed by the bridge into Cart > Set Up Run')
                return None
        return url.path, url.query

    def read_json(self):
        if self.headers.get('Transfer-Encoding'):
            raise BadRequest(411, 'chunked bodies are not supported')
        ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if ctype != 'application/json':
            raise BadRequest(415, 'Content-Type must be application/json')
        lengths = self.headers.get_all('Content-Length') or []
        if not lengths:
            raise BadRequest(411, 'Content-Length required')
        if len(lengths) != 1 or not lengths[0].strip().isdigit():
            raise BadRequest(400, 'invalid Content-Length')
        n = int(lengths[0])
        if n > MAX_BODY:
            raise BadRequest(413, f'body larger than {MAX_BODY} bytes')
        raw = self.rfile.read(n)
        if len(raw) != n:
            raise BadRequest(400, 'body shorter than Content-Length')
        try:
            data = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError):
            raise BadRequest(400, 'invalid JSON') from None
        if not isinstance(data, dict):
            raise BadRequest(400, 'JSON body must be an object')
        return data

    def do_OPTIONS(self):
        if not self.check('OPTIONS'):
            return
        if not self.headers.get('Origin'):
            self.fail(400, 'preflight without Origin')
            return
        self.send_response(204)
        self.cors_headers()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', f'Content-Type, {TOKEN_HEADER}')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def do_GET(self):
        route = self.check('GET')
        if not route:
            return
        path, query = route
        runner = self.runner
        if path == '/ping':
            info = {'ok': True, 'version': VERSION, 'paired': self.token_ok()}
            if info['paired']:
                info.update(pico8=runner.exe, roots=runner.roots, running=runner.running(), path=runner.path)
            self.send_json(200, info)
            return
        since = (parse_qs(query).get('since') or ['0'])[0] or '0'
        if not since.isdigit():
            self.fail(400, 'invalid since')
            return
        since = int(since)
        with runner.lock:
            lines = [l for n, l in runner.log if n > since]
            last = runner.seq
        self.send_json(200, {'ok': True, 'lines': lines, 'next': last, 'running': runner.running()})

    def do_POST(self):
        route = self.check('POST')
        if not route:
            return
        path = route[0]
        try:
            data = self.read_json()
            if path == '/run':
                name, text = data.get('name'), data.get('text')
                if not isinstance(name, str) or not isinstance(text, str):
                    raise BadRequest(400, 'name and text must be strings')
                try:
                    cart, temp = self.runner.run(name, text)
                except ValueError as err:
                    raise BadRequest(400, str(err)) from None
                self.send_json(200, {'ok': True, 'path': cart, 'temp': temp})
            else:
                self.runner.stop()
                self.send_json(200, {'ok': True})
        except BadRequest as err:
            self.fail(err.code, str(err))
        except Exception as err:  # reported to the paired editor
            self.fail(500, str(err))


class BridgeServer(ThreadingHTTPServer):
    """HTTP server for one Runner; port 0 picks a free port (tests)."""

    daemon_threads = True

    def __init__(self, runner, token=None, port=8708, host='127.0.0.1'):
        self.runner = runner
        self.token = token or secrets.token_urlsafe(24)
        super().__init__((host, port), Handler)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pico8', help='path to the pico8 executable')
    ap.add_argument('--root', action='append', default=[], help='folder with carts (more than one allowed)')
    ap.add_argument('--port', type=int, default=8708)
    args = ap.parse_args()

    exe = find_pico8(args.pico8)
    roots = [carts_root()] + [os.path.abspath(r) for r in args.root]
    runner = Runner(exe, roots)
    server = BridgeServer(runner, port=args.port)
    print(f'PICO-8 bridge on http://127.0.0.1:{args.port}')
    print(f'  pico8: {exe or "NOT FOUND (use --pico8 PATH)"}')
    for r in roots:
        print(f'  carts: {r}')
    print()
    print(f'  Pairing token: {server.token}')
    print('  Paste it into the Code Editor: Cart > Set Up Run... (needed again whenever the bridge restarts).')
    print()
    print('Keep this window open while you use Run in the Code Editor. Ctrl+C stops it.')
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        runner.stop()
        time.sleep(0.1)


if __name__ == '__main__':
    main()

