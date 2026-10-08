# bridge/mock_gateway.py — 本地模拟 HTTP 决策网关（联调 Godot HTTP 模式用）
# 用法: python mock_gateway.py [端口] [token]
#   GET /        -> {"ok":true,"service":"mock-gateway"}
#   POST /decision -> 校验 x-gateway-key，返回固定决策 JSON
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18099
TOKEN = sys.argv[2] if len(sys.argv) > 2 else "dev123"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, {"ok": True, "service": "mock-gateway"})

    def do_POST(self):
        if self.path != "/decision":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        key = self.headers.get("x-gateway-key", "")
        if key != TOKEN:
            self._send(401, {"type": "error", "reason": "unauthorized"})
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            state = json.loads(raw or b"{}")
        except Exception:
            state = {}
        decision = {
            "fleet_id": "recon",
            "action": "attack",
            "target": [1200.0, 800.0],
            "reason": "模拟网关决策",
            "got_player_hp": state.get("player_fleet", {}).get("total_hp", 0),
        }
        self._send(200, decision)

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock-gateway] %s\n" % (fmt % args))
        sys.stderr.flush()


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
