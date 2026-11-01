#!/usr/bin/env python3
"""PICO-8 bridge for the PICO-8 Dev Suite: lets the Code Editor run carts in PICO-8.

A browser page cannot start programs, so this small local server does it. It only listens on
127.0.0.1 and only answers pages served from file://, localhost or 127.0.0.1.

    python pico8_bridge.py [--pico8 PATH] [--root FOLDER ...] [--port 8708]

The editor sends the cart's name and text. The bridge looks for that file (same name, same
content: the editor saves it first) in the roots - PICO-8's carts folder (root_path in
config.txt) and every --root - and runs it there, so #include, reload() and load() find their
neighbours. A cart that is not on disk is written to <carts>/_suite_run/ and run from there.
printh() output is collected for the editor's output panel.

Only the Python standard library is used.
"""

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = 1
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', 'backup', 'bbs', '.vs', '.idea'}
MAX_DEPTH = 6
ALLOWED_ORIGIN = re.compile(r'^(null|file://.*|https?://(localhost|127\.0\.0\.1)(:\d+)?)$')


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

    def __init__(self, exe, roots):
        self.exe = exe
        self.roots = roots
        self.proc = None
        self.path = None
        self.log = collections.deque(maxlen=2000)
        self.seq = 0
        self.lock = threading.Lock()
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
        p = self.proc
        self.proc = None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(3)
            except subprocess.TimeoutExpired:
                p.kill()

    def run(self, name, text):
        if not self.exe:
            raise RuntimeError('pico8 executable not found: start the bridge with --pico8 PATH')
        name = os.path.basename(name) or 'cart.p8'
        path = self.find(name, text)
        temp = path is None
        if temp:
            folder = os.path.join(self.roots[0], '_suite_run')
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, name)
            with open(path, 'w', encoding='utf-8', newline='\n') as f:
                f.write(norm(text))
        self.stop()
        self.add_log(f'--- run {path}')
        kw = {}
        if os.name == 'nt':
            kw['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
        self.proc = subprocess.Popen([self.exe, '-run', path], cwd=os.path.dirname(path), stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kw)
        self.path = path
        proc = self.proc
        threading.Thread(target=self._pump, args=(proc,), daemon=True).start()
        return path, temp

    def _pump(self, proc):
        for raw in iter(proc.stdout.readline, b''):
            self.add_log(raw.decode('utf-8', errors='replace').rstrip('\r\n'))
        code = proc.wait()
        self.add_log(f'--- pico-8 exited ({code})')

    def running(self):
        return bool(self.proc and self.proc.poll() is None)


def make_handler(runner):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'PICO8Bridge/1'

        def log_message(self, fmt, *args):
            pass

        def origin_ok(self):
            origin = self.headers.get('Origin')
            return origin is None or bool(ALLOWED_ORIGIN.match(origin))

        def send_json(self, code, obj):
            body = json.dumps(obj).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            origin = self.headers.get('Origin')
            if origin and self.origin_ok():
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            # Chrome's private network access preflight
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            if not self.origin_ok():
                self.send_json(403, {'ok': False, 'error': 'origin not allowed'})
                return
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', self.headers.get('Origin') or '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Max-Age', '600')
            self.end_headers()

        def do_GET(self):
            if not self.origin_ok():
                self.send_json(403, {'ok': False, 'error': 'origin not allowed'})
                return
            url = urlparse(self.path)
            if url.path == '/ping':
                self.send_json(200, {'ok': True, 'version': VERSION, 'pico8': runner.exe, 'roots': runner.roots, 'running': runner.running(), 'path': runner.path})
            elif url.path == '/log':
                since = int((parse_qs(url.query).get('since') or ['0'])[0] or 0)
                with runner.lock:
                    lines = [(n, l) for n, l in runner.log if n > since]
                    last = runner.seq
                self.send_json(200, {'ok': True, 'lines': [l for _, l in lines], 'next': last, 'running': runner.running()})
            else:
                self.send_json(404, {'ok': False, 'error': 'unknown path'})

        def do_POST(self):
            if not self.origin_ok():
                self.send_json(403, {'ok': False, 'error': 'origin not allowed'})
                return
            url = urlparse(self.path)
            try:
                n = int(self.headers.get('Content-Length') or 0)
                data = json.loads(self.rfile.read(n) or b'{}') if n else {}
                if url.path == '/run':
                    path, temp = runner.run(str(data.get('name') or 'cart.p8'), str(data.get('text') or ''))
                    self.send_json(200, {'ok': True, 'path': path, 'temp': temp})
                elif url.path == '/stop':
                    runner.stop()
                    self.send_json(200, {'ok': True})
                else:
                    self.send_json(404, {'ok': False, 'error': 'unknown path'})
            except Exception as err:  # reported to the editor
                self.send_json(500, {'ok': False, 'error': str(err)})

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pico8', help='path to the pico8 executable')
    ap.add_argument('--root', action='append', default=[], help='folder with carts (more than one allowed)')
    ap.add_argument('--port', type=int, default=8708)
    args = ap.parse_args()

    exe = find_pico8(args.pico8)
    roots = [carts_root()] + [os.path.abspath(r) for r in args.root]
    runner = Runner(exe, roots)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(runner))
    print(f'PICO-8 bridge on http://127.0.0.1:{args.port}')
    print(f'  pico8: {exe or "NOT FOUND (use --pico8 PATH)"}')
    for r in roots:
        print(f'  carts: {r}')
    print('Keep this window open while you use Run in the Code Editor. Ctrl+C stops it.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()
        time.sleep(0.1)


if __name__ == '__main__':
    main()
