# api/decode.py
# Vercel Python serverless function wrapping the `googlenewsdecoder` package.
# Normalizes the package's {status, decoded_url, message} into the same
# {ok, status, sourceUrl, error} contract as the JS version, so your
# Power Automate steps don't need to change.
#
# Deploy checklist:
#   1. Put this file at   api/decode.py
#   2. Add a requirements.txt at the project root containing:  googlenewsdecoder
#   3. Set a FLOW_SECRET env var in Vercel (the shared secret PA sends).
#   4. Endpoint becomes:  https://<your-app>.vercel.app/api/decode

import json
import os
from http.server import BaseHTTPRequestHandler

from googlenewsdecoder import gnewsdecoder


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        # Shared-secret gate so this isn't an open decoder.
        if self.headers.get("x-api-key", "") != os.environ.get("FLOW_SECRET", ""):
            return self._send(401, {"ok": False, "error": "unauthorized"})

        length = int(self.headers.get("content-length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except Exception:
            data = {}

        url = (data.get("url") or "").strip()
        if not url:
            return self._send(400, {"ok": False, "error": "missing url"})

        try:
            result = gnewsdecoder(url, interval=1)  # interval throttles to dodge 429s
            if result.get("status"):
                return self._send(
                    200,
                    {"ok": True, "status": "decoded", "sourceUrl": result["decoded_url"]},
                )
            return self._send(
                200,
                {
                    "ok": False,
                    "status": "failed",
                    "sourceUrl": None,
                    "error": result.get("message", "decode failed"),
                },
            )
        except Exception as e:
            # 200 with ok:false so Power Automate reads the body instead of throwing.
            return self._send(
                200,
                {"ok": False, "status": "failed", "sourceUrl": None, "error": str(e)},
            )
