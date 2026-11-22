#!/usr/bin/env python3
"""A caching HTTPS mirror of the PC's recordings API, for virtual-iPhone timing away from home.

The Mac's simulator normally reaches the PC on the home network. Away from it, it gets there
only through an SSH tunnel, whose bandwidth would dominate any timing. This mirror
answers on the Mac instead: one list of chosen recordings (`--list`, the PC's own
/api/videos/changes answer), and every playlist, map and segment fetched once through the
tunnel (`--upstream`), kept in `--cache` and served from there afterwards, with byte ranges.
A long poll waits as the PC's would, without changes. It is a test fixture: it never writes
anything back to the PC and serves only GET.
"""
import argparse, json, os, pathlib, re, shutil, ssl, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=19999)
parser.add_argument('--cert', required=True)
parser.add_argument('--key', required=True)
parser.add_argument('--ca', help='CA that signs the upstream certificate')
parser.add_argument('--upstream', required=True, help='e.g. https://localhost:19998')
parser.add_argument('--list', required=True, type=pathlib.Path, help='JSON: {"epoch", "revision", "videos": [...]}')
parser.add_argument('--cache', required=True, type=pathlib.Path)
parser.add_argument('--log', type=pathlib.Path)
parser.add_argument('--mbps', type=float, default=0, help='total bandwidth for all clients, like a shared Wi-Fi link (0: unlimited)')
args = parser.parse_args()

listing = json.loads(args.list.read_text())
upstream_context = ssl.create_default_context(cafile=args.ca) if args.ca else ssl.create_default_context()
locks, locks_guard = {}, threading.Lock()
log_lock = threading.Lock()
class Link:
    """One shared link: every response's bytes take their turn at `--mbps`."""
    def __init__(self, mbps):
        self.rate, self.lock, self.free = mbps * 1_000_000 / 8, threading.Lock(), time.monotonic()
    def send(self, write, body):
        for start in range(0, len(body), 32768):
            chunk = body[start:start + 32768]
            if self.rate:
                with self.lock:
                    now = time.monotonic()
                    self.free = max(self.free, now) + len(chunk) / self.rate
                    wait = self.free - now - len(chunk) / self.rate
                if wait > 0: time.sleep(wait)
            write(chunk)
link = Link(args.mbps)
TYPES = {'.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment'}

def note(**values):
    if not args.log: return
    with log_lock, args.log.open('a') as handle: handle.write(json.dumps(dict(at=round(time.time(), 3), **values)) + '\n')

def cached(path):
    """The cached copy of an upstream path, fetched once (concurrent requests wait for it)."""
    target = args.cache / urllib.parse.unquote(path).lstrip('/')
    if target.exists(): return target, False
    with locks_guard: lock = locks.setdefault(path, threading.Lock())
    with lock:
        if target.exists(): return target, False
        target.parent.mkdir(parents=True, exist_ok=True)
        began = time.monotonic()
        with urllib.request.urlopen(args.upstream + path, context=upstream_context, timeout=60) as response:
            partial = target.with_name(target.name + '.part')
            with partial.open('wb') as handle: shutil.copyfileobj(response, handle)
            os.replace(partial, target)
        note(fetched=path, ms=round((time.monotonic() - began) * 1000), bytes=target.stat().st_size)
        return target, True

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_): pass

    def send(self, status, body=b'', kind='application/json', headers=()):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        for name, value in headers: self.send_header(name, value)
        self.end_headers()
        if self.command != 'HEAD': link.send(self.wfile.write, body)

    def do_HEAD(self): self.do_GET()

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        if url.path == '/api/videos/changes':
            if query.get('epoch') == listing['epoch'] and query.get('since') is not None:
                time.sleep(min(25, float(query.get('wait', 0) or 0)))
                body = dict(epoch=listing['epoch'], revision=listing['revision'], changes=[])
            else:
                body = dict(epoch=listing['epoch'], revision=listing['revision'], videos=listing['videos'])
            return self.send(200, json.dumps(body).encode())
        if not url.path.startswith('/hls/'):
            return self.send(404, b'{"error":"not mirrored"}')
        began = time.monotonic()
        try: path, fetched = cached(url.path)
        except Exception as error:
            note(failed=url.path, error=str(error))
            return self.send(502, json.dumps(dict(error=str(error))).encode())
        size = path.stat().st_size
        kind = TYPES.get(path.suffix, 'application/octet-stream')
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', self.headers.get('Range', ''))
        start, end = 0, size - 1
        if match and (match.group(1) or match.group(2)):
            if match.group(1): start = int(match.group(1)); end = int(match.group(2)) if match.group(2) else size - 1
            else: start = max(0, size - int(match.group(2)))
            end = min(end, size - 1)
        with path.open('rb') as handle:
            handle.seek(start)
            body = handle.read(end - start + 1)
        headers = [('Accept-Ranges', 'bytes'), ('Access-Control-Allow-Origin', '*')]
        if match: headers.append(('Content-Range', f'bytes {start}-{end}/{size}'))
        self.send(206 if match else 200, body, kind, headers)
        note(served=url.path, range=self.headers.get('Range'), fetched=fetched, ms=round((time.monotonic() - began) * 1000))

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(args.cert, args.key)
server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
server.daemon_threads = True
server.socket = context.wrap_socket(server.socket, server_side=True)
print(f'Mirroring {len(listing["videos"])} recordings on https://localhost:{args.port}', flush=True)
server.serve_forever()
