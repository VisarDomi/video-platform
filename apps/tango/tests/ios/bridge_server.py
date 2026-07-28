#!/usr/bin/env python3
"""Portable HTTPS command bridge for an iOS userscript."""

import argparse
import http.server
import json
import os
import socket
import ssl
import subprocess
import shutil
import threading
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent.parent
STATE_DIR = REPO_ROOT / ".ios-debug"
DEBUG_USERSCRIPT = ROOT / "tango-explorer-debug.user.js"
MAX_BODY = 128 * 1024
MAX_ITEMS = 500

lock = threading.Lock()
commands = []
results = []
clients = {}
boots = []


def lan_ip() -> str:
    override = os.environ.get("IOS_DEBUG_HOST")
    if override:
        return override
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("1.1.1.1", 80))
        return sock.getsockname()[0]
    finally:
        sock.close()


def certificate_paths():
    cert = os.environ.get("IOS_DEBUG_CERT")
    key = os.environ.get("IOS_DEBUG_KEY")
    if cert and key:
        return Path(cert).expanduser(), Path(key).expanduser()
    return STATE_DIR / "cert.pem", STATE_DIR / "key.pem"


def root_ca_path():
    override = os.environ.get("IOS_DEBUG_CA")
    return Path(override).expanduser() if override else STATE_DIR / "rootCA.pem"


def setup(port: int) -> None:
    host = lan_ip()
    cert, key = certificate_paths()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.run(["mkcert", "-install"], check=True)
    subprocess.run([
        "mkcert",
        "-cert-file", str(cert),
        "-key-file", str(key),
        "localhost", "127.0.0.1", host,
    ], check=True)
    caroot = subprocess.run(["mkcert", "-CAROOT"], check=True, text=True, capture_output=True).stdout.strip()
    shutil.copyfile(Path(caroot) / "rootCA.pem", root_ca_path())
    print(f"Certificate: {cert}")
    print(f"iPhone CA profile: https://{host}:{port}/api/cert")
    print(f"iPhone debugger:   https://{host}:{port}/tango-explorer-debug.user.js")
    print("Start the bridge with `npm run tests:server`, then open those URLs on the iPhone.")


class Handler(http.server.BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        super().end_headers()

    def send_json(self, payload, status=200):
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def read_json(self):
        try:
            length = min(int(self.headers.get("content-length", "0")), MAX_BODY)
            return json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def local(self):
        return self.client_address[0] in {"127.0.0.1", "::1"}

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/tango-explorer-debug.user.js":
            source = DEBUG_USERSCRIPT.read_text()
            encoded = source.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return

        if parsed.path == "/__debug_info":
            if not self.local():
                self.send_error(403, "Local requests only")
                return
            host = lan_ip()
            port = self.server.server_port
            self.send_json({
                "host": host,
                "port": port,
                "debuggerUrl": f"https://{host}:{port}/tango-explorer-debug.user.js",
                "certificateUrl": f"https://{host}:{port}/api/cert",
            })
            return

        if parsed.path == "/api/cert":
            ca = root_ca_path()
            if not ca.exists():
                self.send_error(404, "Root CA unavailable; run npm run tests:setup")
                return
            encoded = ca.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="manga-reader-mkcert-rootCA.pem"')
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return

        if parsed.path == "/__debug_poll":
            client = query.get("client", [""])[0]
            if not client:
                self.send_json({"error": "client is required"}, 400)
                return
            try:
                after = int(query.get("after", ["0"])[0])
            except ValueError:
                after = 0
            with lock:
                is_new = client not in clients
                clients[client] = {
                    "client": client,
                    "href": query.get("href", [""])[0],
                    "title": query.get("title", [""])[0],
                    "userAgent": query.get("userAgent", [""])[0],
                    "lastSeen": time.time(),
                }
                cursor = commands[-1]["id"] if commands else 0
                pending = [] if is_new else [
                    item for item in commands
                    if item["id"] > after and item["target"] in {"*", client}
                ]
            self.send_json({"commands": pending, "cursor": cursor})
            return

        if parsed.path == "/__debug_boot":
            with lock:
                boots.append({
                    "client": query.get("client", [""])[0],
                    "href": query.get("href", [""])[0],
                    "userAgent": query.get("userAgent", [""])[0],
                    "lastSeen": time.time(),
                })
                del boots[:-MAX_ITEMS]
            self.send_response(204)
            self.end_headers()
            return

        if parsed.path == "/__debug_state":
            if not self.local():
                self.send_error(403, "Local requests only")
                return
            with lock:
                self.send_json({
                    "clients": list(clients.values()),
                    "commands": list(commands),
                    "results": list(results),
                    "boots": list(boots),
                })
            return

        self.send_error(404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        payload = self.read_json()

        if parsed.path == "/__debug_command":
            if not self.local():
                self.send_error(403, "Local requests only")
                return
            if not isinstance(payload, dict) or not isinstance(payload.get("code"), str):
                self.send_json({"error": "JSON body with string 'code' required"}, 400)
                return
            with lock:
                previous_id = commands[-1]["id"] if commands else 0
                command_id = max(previous_id + 1, int(time.time() * 1000))
                command = {
                    "id": command_id,
                    "target": str(payload.get("target") or "*"),
                    "code": payload["code"],
                    "createdAt": time.time(),
                }
                commands.append(command)
                del commands[:-MAX_ITEMS]
            self.send_json(command, 201)
            return

        if parsed.path == "/__debug_result":
            if not isinstance(payload, dict):
                self.send_json({"error": "JSON object required"}, 400)
                return
            payload["receivedAt"] = time.time()
            with lock:
                results.append(payload)
                del results[:-MAX_ITEMS]
            self.send_response(204)
            self.end_headers()
            return

        self.send_error(404)

    def log_message(self, _format, *_args):
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true")
    parser.add_argument("--port", type=int, default=int(os.environ.get("IOS_DEBUG_PORT", "36666")))
    args = parser.parse_args()
    if args.setup:
        setup(args.port)
        return

    cert, key = certificate_paths()
    if not cert.exists() or not key.exists():
        raise SystemExit("Missing HTTPS certificate. Run: npm run tests:setup")
    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
