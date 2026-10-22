#!/usr/bin/env python3
"""Serve only the local club office's program files, never private data or Git files."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import argparse
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {"/app/js/dom.js", "/assets/favicon.svg", "/assets/calblue-logo-web.jpg"}
ALLOWED.update("/club-office/" + name for name in ["index.html", "register.html", "pay.html", "pay.js", "office.css", "office.js", "register.js", "crypto.js", "model.js", "storage.js", "shared.js", "README.md"])

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path in {"/", "/club-office/"}:
            self.path = "/club-office/index.html"
        elif path not in ALLOWED:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        path = unquote(urlsplit(self.path).path)
        if path in {"/", "/club-office/"}:
            self.path = "/club-office/index.html"
        elif path not in ALLOWED:
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def log_message(self, *args):
        pass

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/club-office/"
    print(f"CalBlue club office: {url}\nKeep this window open. Ctrl+C stops the local server.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    main()
