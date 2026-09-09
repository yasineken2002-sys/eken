"""Loopback-only synthetic demo. No real authentication, delivery or bank API."""
import argparse
import json
import secrets
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from kundklarlaggning import Denied, Postgres, PRINCIPALS, Service, b_inputs, originals

STATIC = Path(__file__).with_name('kundklarlaggning_demo')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Denied()
        result[key] = value
    return result


class Demo(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, service, port=8873):
        super().__init__(('127.0.0.1', port), Handler)
        self.service = service
        self.origin = 'http://127.0.0.1:' + str(self.server_port)
        self.boot_key = secrets.token_urlsafe(32)
        self.sessions = {}
        self.session_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log query tokens or raw customer/SQL content.

    def send(self, status, value, mime='application/json; charset=utf-8', cookie=None):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def session(self):
        cookie = SimpleCookie()
        cookie.load(self.headers.get('Cookie', ''))
        sid = cookie.get('demo_session')
        with self.server.session_lock:
            session = self.server.sessions.get(sid.value if sid else '')
            if not session or session['expires'] <= time.monotonic():
                raise Denied()
            return dict(session)

    def body(self):
        if self.headers.get('Content-Type') != 'application/json' or self.headers.get('Transfer-Encoding'):
            raise Denied()
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 16384:
            raise Denied()
        value = json.loads(self.rfile.read(size), object_pairs_hook=unique_object)
        if not isinstance(value, dict):
            raise Denied()
        return value

    def handle_request(self, post=False):
        try:
            if self.headers.get('Host') != self.server.origin.removeprefix('http://'):
                raise Denied()
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            if post and self.headers.get('Origin') != self.server.origin:
                raise Denied()
            if not post and url.path in ('/', '/demo', '/customer', '/style.css', '/app.js'):
                name = {'/style.css': 'style.css', '/app.js': 'app.js'}.get(url.path, 'index.html')
                mime = {'style.css': 'text/css', 'app.js': 'text/javascript', 'index.html': 'text/html'}[name]
                self.send(200, (STATIC/name).read_bytes(), mime+'; charset=utf-8')
                return
            data = self.body() if post else None
            if post and url.path == '/api/demo-login':
                if set(data) != {'key', 'persona'} or not isinstance(data['key'], str) or not secrets.compare_digest(data['key'], self.server.boot_key):
                    raise Denied()
                actor = PRINCIPALS.get(data['persona'])
                if actor is None:
                    raise Denied()
                sid = secrets.token_urlsafe(32)
                session = {'actor': actor, 'csrf': secrets.token_urlsafe(32), 'expires': time.monotonic()+1200}
                with self.server.session_lock:
                    self.server.sessions = {k: v for k, v in self.server.sessions.items() if v['expires'] > time.monotonic()}
                    self.server.sessions[sid] = session
                self.send(200, {'testOnly': True}, cookie='demo_session='+sid+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=1200')
                return
            session = self.session()
            actor = session['actor']
            if post and not secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), session['csrf']):
                raise Denied()
            s = self.server.service
            if not post and url.path == '/api/me':
                result = {'person': actor[1], 'organization': actor[0], 'role': actor[2], 'csrf': session['csrf'], 'authentication': 'SIMULATED'}
            elif not post and url.path == '/api/mailbox':
                result = s.mailbox(actor)
            elif not post and url.path == '/api/staff':
                result = s.staff(actor)
            elif not post and url.path == '/api/customer':
                if set(query) != {'case', 'token'} or any(len(v) != 1 or len(v[0]) > 200 for v in query.values()):
                    raise Denied()
                result = s.customer(query['case'][0], query['token'][0], actor)
            elif post and url.path in ('/api/route', '/api/capture'):
                if set(data) != {'case'} or not isinstance(data['case'], str) or len(data['case']) > 200:
                    raise Denied()
                result = {'status': (s.route if url.path == '/api/route' else s.capture)(data['case'], actor)}
            elif post and url.path == '/api/reply':
                if set(data) != {'case','token','request','answer'} or any(not isinstance(data[k], str) or len(data[k]) > 200 for k in ('case','token','request')):
                    raise Denied()
                result = s.reply(data['case'], data['token'], data['request'], data['answer'], actor)
            else:
                raise Denied()
            self.send(200, result)
        except (Denied, ValueError, TypeError, KeyError, RuntimeError, OverflowError):
            self.send(403, {'error': 'Begäran kunde inte godkännas. Kontakta personal via din vanliga kontaktväg.', 'testOnly': True})

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request(True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8873)
    args = parser.parse_args()
    pg = Postgres()
    server = None
    stop = threading.Event()
    try:
        pg.start()
        service = Service(pg).bootstrap()
        for k in [*originals(), *b_inputs()]:
            service.route(k)
        server = Demo(service, args.port)
        def expire():
            while not stop.wait(10):
                service.expire()
        threading.Thread(target=expire, daemon=True).start()
        print('ENDAST TESTDATA. Simulerad inloggning och beviskälla. Inga riktiga utskick.', flush=True)
        print('Öppna via privat lokal tunnel (gör INTE porten publik):', flush=True)
        print(server.origin+'/demo?key='+server.boot_key, flush=True)
        print('Nyckeln styr alla demopersoner. Dela den inte. Ctrl+C tar bort endast denna testcontainer.', flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        if server:
            server.server_close()
        pg.close()


if __name__ == '__main__':
    main()
