#!/usr/bin/env python3
"""Local demo of the deployed bundle.

Serves deploy/public/ at :8099 and proxies /api/* to the intake API at :8897, so the page's
same-origin /api/signup works exactly as it will on GoDaddy (where PHP serves those paths).

The Python API stands in for signup.php here: same JSON contract, verified byte-compatible.
Use --check to confirm both are reachable before demoing.
"""
import json, sys, urllib.request, urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent / "public"
UPSTREAM = "http://127.0.0.1:8897"

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        return str(ROOT / path.lstrip("/").split("?")[0])

    def _proxy(self, method):
        url = UPSTREAM + self.path[len("/api"):]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(url, data=body, method=method,
                                     headers={k: v for k, v in self.headers.items()
                                              if k.lower() in ("content-type", "x-intake-token")})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                payload, status = r.read(), r.status
        except urllib.error.HTTPError as e:
            payload, status = e.read(), e.code
        except Exception as e:
            payload, status = json.dumps({"detail": f"upstream unreachable: {e}"}).encode(), 502
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        self._proxy("POST") if self.path.startswith("/api/") else self.send_error(405)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy("GET")
        else:
            super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("demo: %s\n" % (fmt % args))

if __name__ == "__main__":
    print(f"demo on http://127.0.0.1:8099  (root {ROOT}, api -> {UPSTREAM})")
    ThreadingHTTPServer(("127.0.0.1", 8099), Handler).serve_forever()
