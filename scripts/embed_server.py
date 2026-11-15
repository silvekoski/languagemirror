"""Query embedder for time-travel search: bge-m3 (sentence-transformers, no Ollama) behind a tiny HTTP API.
Runs as a Slurm job on chili for the hackathon:
    cj run -n wt-embedsrv -c 4 -m 6G -t 2-00:00 -- .venv-gpu/bin/python -m scripts.embed_server --port 8765
POST /embed {"texts": [...]} -> {"vectors": [[1024 floats], ...]}   (normalised, same model as the snapshots)"""
import argparse, json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from sentence_transformers import SentenceTransformer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8765)
ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
args = ap.parse_args()
torch.set_num_threads(4)
model = SentenceTransformer("BAAI/bge-m3", device=args.device)
model.max_seq_length = 512


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        t = time.time()
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        v = model.encode(body["texts"][:16], normalize_embeddings=True).tolist()
        out = json.dumps({"vectors": v, "ms": round((time.time() - t) * 1000)}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")


print(f"embed server on :{args.port} ({args.device})", flush=True)
ThreadingHTTPServer(("0.0.0.0", args.port), H).serve_forever()
