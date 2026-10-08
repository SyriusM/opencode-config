#!/usr/bin/env python3
# Atrapa serwera OpenAI-compatible (SSE): dwa wywołania `read` na nieistniejącym pliku (próg lesson-draft = 2), potem tekst.
import http.server, json, os, sys, time

LOG = "/tmp/atrapa.log"

def chunk(delta, finish=None):
    return {"id": "x", "object": "chat.completion.chunk", "created": int(time.time()), "model": "atrapa",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(s):
        s.send_response(200); s.send_header("Content-Type", "application/json"); s.end_headers()
        s.wfile.write(json.dumps({"object": "list", "data": [{"id": "atrapa", "object": "model"}]}).encode())

    def do_POST(s):
        body = json.loads(s.rfile.read(int(s.headers.get("Content-Length", 0))) or b"{}")
        msgs = body.get("messages", [])
        po_narzedziu = sum(m.get("role") == "tool" for m in msgs) >= 2
        with open("/tmp/atrapa-body.jsonl", "a") as f:
            f.write(json.dumps(body, ensure_ascii=False) + "\n")
        with open(LOG, "a") as f:
            f.write(json.dumps({"n": len(msgs), "tool": po_narzedziu, "stream": body.get("stream"),
                                "tools": [t["function"]["name"] for t in body.get("tools", [])],
                                "palace": "ZNACZNIK-PALACE" in json.dumps(msgs, ensure_ascii=False)}) + "\n")
        s.send_response(200); s.send_header("Content-Type", "text/event-stream"); s.end_headers()
        if po_narzedziu:
            parts = [chunk({"role": "assistant", "content": "Pliku nie ma. "}), chunk({"content": "Koniec."}),
                     chunk({}, "stop")]
        else:
            args = json.dumps({"path": os.path.expanduser("~/demo/nie-istnieje.txt")})
            parts = [chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                            "function": {"name": "read", "arguments": args}}]}), chunk({}, "tool_calls")]
        for p in parts:
            s.wfile.write(f"data: {json.dumps(p)}\n\n".encode()); s.wfile.flush()
        s.wfile.write(b"data: [DONE]\n\n"); s.wfile.flush()

    def log_message(*a): pass

http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8080), H).serve_forever()
