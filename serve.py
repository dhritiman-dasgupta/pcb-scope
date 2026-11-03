#!/usr/bin/env python3
"""Serve web/ on 127.0.0.1 with caching disabled (browser mode; the Mac app has its own built-in server)."""
import functools, http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
handler = functools.partial(NoCache, directory=os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
