"""Bridge security and lifecycle tests: python -m unittest discover -s tests -p 'test_*.py' -v

A fake process launcher stands in for PICO-8; nothing real is executed.
"""

import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import pico8_bridge as bridge  # noqa: E402

TOKEN = 'test-token-0123456789'


class FakeProc:
    """Popen stand-in: one printh line, then blocks until terminated."""

    def __init__(self, args, **kw):
        self.args = args
        self.kw = kw
        self.returncode = None
        self.done = threading.Event()
        self.lines = [b'hello from fake pico-8\n']
        self.stdout = self

    def readline(self):
        if self.lines:
            return self.lines.pop(0)
        self.done.wait()
        return b''

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15
        self.done.set()

    kill = terminate

    def wait(self, timeout=None):
        self.done.wait(timeout)
        return self.returncode


class BridgeTest(unittest.TestCase):
    def setUp(self):
        # scratch carts folder next to the tests (cleaned up), not the system temp dir
        self.root = tempfile.mkdtemp(prefix='.bridge-test-', dir=os.path.dirname(os.path.abspath(__file__)))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.procs = []

        def launcher(args, **kw):
            time.sleep(0.01)  # widen the window for races between /run and /stop
            p = FakeProc(args, **kw)
            self.procs.append(p)
            return p

        self.runner = bridge.Runner('fake-pico8', [self.root], launcher=launcher)
        self.server = bridge.BridgeServer(self.runner, token=TOKEN, port=0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.runner.stop)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, body=None, headers=None, token=TOKEN, origin='null'):
        hdrs = {}
        if origin:
            hdrs['Origin'] = origin
        if token:
            hdrs[bridge.TOKEN_HEADER] = token
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
            hdrs['Content-Type'] = 'application/json'
        hdrs.update(headers or {})
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=hdrs)
            res = conn.getresponse()
            data = res.read()
            return res.status, dict(res.getheaders()), json.loads(data) if data else None
        finally:
            conn.close()

    def run_cart(self, **kw):
        return self.request('POST', '/run', {'name': 'demo.p8', 'text': 'pico-8 cartridge\n'}, **kw)

    def test_rejects_unpaired_and_foreign_callers(self):
        self.assertEqual(self.run_cart(token=None)[0], 401)
        self.assertEqual(self.run_cart(token='wrong')[0], 401)
        self.assertEqual(self.request('POST', '/stop', {}, token=None)[0], 401)
        self.assertEqual(self.request('GET', '/log', token=None)[0], 401)
        # a valid token does not help a web origin or an unexpected Host (DNS rebinding)
        self.assertEqual(self.run_cart(origin='https://evil.example')[0], 403)
        self.assertEqual(self.run_cart(origin='http://127.0.0.1.evil.example')[0], 403)
        self.assertEqual(self.run_cart(headers={'Host': f'evil.example:{self.port}'})[0], 403)
        self.assertEqual(self.request('OPTIONS', '/run', origin='https://evil.example', token=None)[0], 403)
        # unpaired /ping proves the bridge is there, but reveals no local paths
        status, _, j = self.request('GET', '/ping', token=None)
        self.assertEqual((status, j), (200, {'ok': True, 'version': bridge.VERSION, 'paired': False}))
        self.assertEqual(self.procs, [])
        self.assertEqual(os.listdir(self.root), [])

    def test_origin_rejects_header_line_breaks(self):
        class Headers:
            def __init__(self, origin):
                self.origin = origin

            def get_all(self, name):
                return [self.origin] if name == 'Origin' else []

        for origin in ('http://localhost\n', 'http://localhost\r\n'):
            handler = type('HandlerStub', (), {'headers': Headers(origin)})()
            self.assertFalse(bridge.Handler.origin_ok(handler))

    def test_rejects_malformed_requests(self):
        def raw(headers, body=b''):
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
            try:
                conn.putrequest('POST', '/run')
                for k, v in {'Origin': 'null', bridge.TOKEN_HEADER: TOKEN, 'Content-Type': 'application/json', **headers}.items():
                    conn.putheader(k, v)
                conn.endheaders(body)
                return conn.getresponse().status
            finally:
                conn.close()

        self.assertEqual(raw({}), 411)  # no Content-Length
        self.assertEqual(raw({'Content-Length': 'abc'}), 400)
        self.assertEqual(raw({'Content-Length': '-1'}), 400)
        self.assertEqual(raw({'Content-Length': str(bridge.MAX_BODY + 1)}, b'{}'), 413)
        self.assertEqual(self.request('POST', '/run', '{}', headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('POST', '/run', '{nope', headers={'Content-Type': 'application/json'})[0], 400)
        self.assertEqual(self.request('POST', '/run', ['demo.p8'])[0], 400)
        self.assertEqual(self.request('POST', '/run', {'name': 'demo.p8', 'text': 5})[0], 400)
        for name in ('../demo.p8', 'sub/demo.p8', 'c:demo.p8', 'evil.bat', ''):
            self.assertEqual(self.request('POST', '/run', {'name': name, 'text': ''})[0], 400, name)
        self.assertEqual(self.request('GET', '/run')[0], 405)
        self.assertEqual(self.request('GET', '/log?since=x')[0], 400)
        self.assertEqual(self.request('GET', '/nope')[0], 404)
        self.assertEqual(self.procs, [])
        self.assertEqual(os.listdir(self.root), [])

    def test_paired_suite_runs_and_stops(self):
        status, headers, _ = self.request('OPTIONS', '/run', token=None, headers={
            'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-bridge-token'})
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'null')
        self.assertIn(bridge.TOKEN_HEADER, headers['Access-Control-Allow-Headers'])

        status, _, j = self.request('GET', '/ping', origin='http://localhost:8000')
        self.assertEqual((status, j['paired'], j['pico8'], j['roots']), (200, True, 'fake-pico8', [self.root]))

        status, headers, j = self.run_cart()
        self.assertEqual(status, 200, j)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'null')
        cart = os.path.join(self.root, '_suite_run', 'demo.p8')
        self.assertEqual((j['path'], j['temp']), (cart, True))
        self.assertTrue(os.path.isfile(cart))
        self.assertEqual(self.procs[0].args, ['fake-pico8', '-run', cart])

        deadline = time.time() + 5
        while time.time() < deadline:
            log = self.request('GET', '/log?since=0')[2]
            if 'hello from fake pico-8' in log['lines']:
                break
            time.sleep(0.02)
        self.assertIn('hello from fake pico-8', log['lines'])
        self.assertTrue(log['running'])

        self.assertEqual(self.request('POST', '/stop', {})[0], 200)
        self.assertIsNotNone(self.procs[0].poll())
        self.assertFalse(self.request('GET', '/log')[2]['running'])

    def test_concurrent_runs_and_stops_leave_no_orphans(self):
        results = []

        def worker(i):
            if i % 3 == 2:
                results.append(self.request('POST', '/stop', {})[0])
            else:
                results.append(self.run_cart()[0])

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(20)
        self.assertEqual(results, [200] * 12)
        alive = [p for p in self.procs if p.poll() is None]
        self.assertLessEqual(len(alive), 1)
        if alive:
            self.assertIs(self.runner.proc, alive[0])
        self.assertEqual(self.request('POST', '/stop', {})[0], 200)
        self.assertEqual([p for p in self.procs if p.poll() is None], [])


if __name__ == '__main__':
    unittest.main()
