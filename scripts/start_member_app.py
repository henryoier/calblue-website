#!/usr/bin/env python3
"""Local member-app preview on an allowed Auth origin; program assets only."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import argparse
import webbrowser
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def allowed(self):
        path=unquote(urlsplit(self.path).path)
        if path in ('/','/app/'): path='/app/index.html'
        if path=='/app/tests/': path='/app/tests/index.html'
        candidate=(ROOT/path.lstrip('/')).resolve()
        if not candidate.is_relative_to(ROOT) or any(part.startswith('.') for part in Path(path).parts): return False
        relative=candidate.relative_to(ROOT)
        if relative.as_posix() in ('styles.css','club-office/model.js','assets/favicon.svg','assets/calblue-logo-web.jpg') or (relative.parts[0]=='app' and candidate.suffix in ('.js','.html','.css')):
            self.path='/'+relative.as_posix(); return True
        return False
    def do_GET(self):
        if not self.allowed(): self.send_error(404); return
        super().do_GET()
    def do_HEAD(self):
        if not self.allowed(): self.send_error(404); return
        super().do_HEAD()
    def end_headers(self):
        self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff'); self.send_header('Referrer-Policy','no-referrer'); self.send_header('X-Frame-Options','DENY'); super().end_headers()
    def log_message(self,*args): pass
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--port',type=int,choices=[8080,8091],default=8080);parser.add_argument('--no-browser',action='store_true');args=parser.parse_args()
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler);url=f'http://localhost:{args.port}/app/'
    print(url,flush=True)
    if not args.no_browser:webbrowser.open(url)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
