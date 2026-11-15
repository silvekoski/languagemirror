"""Demo server: JSON API over MariaDB + static demo pages in web/.
    uv run python -m app.server            -> http://localhost:8000   (PORT=8101 ... to run another)
Every module app/<name>.py that defines a Flask Blueprint `bp` is mounted at /api/<name>/.
Every page web/<name>.html with <meta name="demo-title"> is listed on the hub (/api/demos)."""
import html, importlib, os, pathlib, pkgutil, re
from flask import Flask, jsonify, request, send_from_directory

ROOT = pathlib.Path(__file__).resolve().parent
WEB = ROOT.parent / "web"
app = Flask(__name__, static_folder=None)

for m in pkgutil.iter_modules([str(ROOT)]):
    if m.name in ("server", "db"):
        continue
    mod = importlib.import_module(f"app.{m.name}")
    if hasattr(mod, "bp"):
        app.register_blueprint(mod.bp, url_prefix=f"/api/{m.name}")


def _meta(text, name):
    m = re.search(rf'<meta\s+name="{name}"\s+content="([^"]*)"', text)
    return html.unescape(m.group(1)) if m else None


@app.get("/api/demos")
def demos():
    out = []
    for f in sorted(WEB.glob("*.html")):
        t = f.read_text(errors="ignore")[:4000]
        title = _meta(t, "demo-title")
        if title:
            out.append({"page": f.name, "title": title, "desc": _meta(t, "demo-desc") or "",
                        "tags": (_meta(t, "demo-tags") or "").split(","), "order": int(_meta(t, "demo-order") or 50)})
    return jsonify(sorted(out, key=lambda d: (d["order"], d["title"])))


@app.get("/")
def index():
    # languagemirror.bobs.build (or LANDING=kielipeili) opens Language Mirror; other hosts get the hub.
    if request.host.startswith("languagemirror.") or os.environ.get("LANDING") == "kielipeili":
        return send_from_directory(WEB, "kielipeili.html")
    return send_from_directory(WEB, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(WEB, path)


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 8000)), debug=True, threaded=True,
            use_reloader=os.environ.get("RELOAD", "1") == "1")
