#!/usr/bin/env python3
"""Private, read-only phone dashboard, independent of the heavy worker."""
import argparse
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
from pathlib import Path
import signal
import ssl
import threading
import time
import traceback
from urllib.parse import urlsplit

from collector import snapshot, read_services, latest_worker_step

WEB = Path(__file__).with_name("web")
ASSETS = {"/": ("index.html", "text/html; charset=utf-8"),
          "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8"),
          "/sw.js": ("sw.js", "text/javascript; charset=utf-8"),
          "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
          "/icon.svg": ("icon.svg", "image/svg+xml"),
          "/icon-192.png": ("icon-192.png", "image/png"),
          "/icon-512.png": ("icon-512.png", "image/png"),
          "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png")}


def allowed_client(address):
    try:
        ip = ipaddress.ip_address(address)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return ip.is_loopback or ip in ipaddress.ip_network("100.64.0.0/10") or (
            ip.version == 4 and any(ip in ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")))
    except ValueError:
        return False


class Snapshot:
    def __init__(self, data_root, downloads_root, reader=snapshot):
        self.data_root, self.downloads_root, self.reader = Path(data_root), Path(downloads_root), reader
        self.lock = threading.Lock()
        self.last_read = 0
        self.cached = self.last_good = self.resources = None
        self.last_error = None

    def get(self):
        with self.lock:
            if self.cached is not None and time.monotonic() - self.last_read < 5:
                return self.cached
            try:
                services, self.resources = read_services(self.resources)
                value = self.reader(self.data_root, self.downloads_root, services=services, worker_step=latest_worker_step())
                self.last_good = value
                self.last_error = None
                self.cached = (200, {"ok": True, "snapshot": value})
            except Exception as error:
                # A missing/busy/broken data source must not turn into live zeroes.
                origin = traceback.extract_tb(error.__traceback__)[-1]
                signature = (type(error).__name__, Path(origin.filename).name, origin.lineno)
                if self.last_error != signature:
                    # Source location only: exception text may include private data.
                    print("Dashboard snapshot unavailable:", signature[0], f"at {signature[1]}:{signature[2]}", flush=True)
                    self.last_error = signature
                self.cached = (503, {"ok": False, "message": "Live pipeline data is unavailable.", "snapshot": self.last_good})
            self.last_read = time.monotonic()
            return self.cached


class Handler(BaseHTTPRequestHandler):
    server_version = "Pipeline"

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def reply(self, status, body, mime="application/json; charset=utf-8"):
        compressed = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 2048
        if compressed:
            body = gzip.compress(body, compresslevel=3)
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

    def do_GET(self):
        if not allowed_client(self.client_address[0]):
            return self.reply(403, b'{"message":"Private network only"}')
        path = urlsplit(self.path).path
        if path == "/api/dashboard":
            status, data = self.server.snapshot.get()
            return self.reply(status, json.dumps(data, separators=(",", ":"), allow_nan=False).encode())
        if path in ASSETS:
            filename, mime = ASSETS[path]
            try:
                return self.reply(200, (self.server.assets / filename).read_bytes(), mime)
            except OSError:
                return self.reply(404, b'{"message":"Asset unavailable"}')
        return self.reply(404, b'{"message":"Not found"}')

    do_HEAD = do_GET

    def do_POST(self):
        self.reply(405, b'{"message":"This dashboard is read-only"}')

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST


def create_server(host, port, data_root, downloads_root, *, assets=WEB, reader=snapshot):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.snapshot = Snapshot(data_root, downloads_root, reader)
    server.assets = Path(assets)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--data-root", type=Path, default=Path.home() / ".local/share/video-services")
    parser.add_argument("--downloads-root", type=Path, default=Path.home() / "Videos/downloads")
    parser.add_argument("--cert-dir", type=Path, default=Path.home() / ".local/share/mkcert/pwa")
    parser.add_argument("--http", action="store_true", help="Loopback-only browser/test server")
    args = parser.parse_args()
    if args.http and args.host not in ("127.0.0.1", "::1", "localhost"):
        parser.error("Plain HTTP is limited to loopback")
    server = create_server(args.host, args.port, args.data_root, args.downloads_root)
    if not args.http:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.cert_dir / "cert.pem", args.cert_dir / "key.pem")
        server.socket = context.wrap_socket(server.socket, server_side=True)
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'Pipeline dashboard: {"http" if args.http else "https"}://{args.host}:{args.port}/', flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
