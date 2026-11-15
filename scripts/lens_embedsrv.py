"""bge-m3 embedding service for Kielipeili's on-demand article loading (CPU is fine; the model loads once).
    .venv-embed/bin/python -m scripts.lens_embedsrv --port 8766
POST /embed {"texts": [...]} -> {"vectors": [[1024 floats], ...]} (normalised, same model as the stored chunks)."""
import argparse, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from sentence_transformers import SentenceTransformer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8766)
ap.add_argument("--threads", type=int, default=int(os.environ.get("EMBED_THREADS", "16")))
args = ap.parse_args()
torch.set_num_threads(args.threads)
model = SentenceTransformer("BAAI/bge-m3", device="cuda" if torch.cuda.is_available() else "cpu")
model.max_seq_length = 512
lock = threading.Lock()   # one batch at a time: the CPU is the bottleneck anyway


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        t = time.time()
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock:
            v = model.encode(body["texts"], batch_size=16, normalize_embeddings=True).tolist()
        out = json.dumps({"vectors": v, "ms": round((time.time() - t) * 1000)}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
