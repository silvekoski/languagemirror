"""Kielipeili ("language mirror"): how do the Finnish, Swedish, English, German, Russian and Ukrainian
Wikipedias tell the same story, and how did that change over time?

lens_chunk holds every paragraph of every language version, embedded with bge-m3 (multilingual) and
SYSTEM-VERSIONED with Wikipedia's real save times. Comparing two languages at any moment is one
statement: for each Finnish paragraph, find the closest paragraph in the other language as both stood
at time T (MATCH_SQL). Coverage = share of Finnish text that has a counterpart (cosine similarity >= TAU).
Claude's fact and framing review of each language pair is precomputed (scripts/lens_analyze.py) with
quotes checked against the stored text."""
import functools, gzip, hashlib, html, json, threading
from datetime import datetime, timezone

import pathlib

from flask import Blueprint, Response, jsonify, request, send_file

from app.db import rows

bp = Blueprint("kielipeili", __name__)
TAU = 0.60          # coverage: best match at least this similar (bge-m3 cosine, calibrated on Talvisota fi/en)
PAIR_MIN = 0.55     # aligned pair: mutual nearest neighbours and at least this similar
LANGS = ["fi", "sv", "en", "de", "ru", "uk"]
YEARS = [2008, 2012, 2016, 2020, 2024]

# For every paragraph of language A at time T: its nearest paragraph in language B at time T.
MATCH_SQL = """SELECT a.id, a.ord, a.section, a.text, a.chars,
  (SELECT b.id FROM lens_chunk FOR SYSTEM_TIME AS OF TIMESTAMP %(t)s AS b IGNORE INDEX (emb)
     WHERE b.topic = a.topic AND b.lang = %(b)s
     ORDER BY VEC_DISTANCE_COSINE(a.emb, b.emb) LIMIT 1) AS match_id,
  1 - (SELECT MIN(VEC_DISTANCE_COSINE(a.emb, b.emb))
     FROM lens_chunk FOR SYSTEM_TIME AS OF TIMESTAMP %(t)s AS b
     WHERE b.topic = a.topic AND b.lang = %(b)s) AS sim
FROM lens_chunk FOR SYSTEM_TIME AS OF TIMESTAMP %(t)s AS a
WHERE a.topic = %(topic)s AND a.lang = %(a)s
ORDER BY a.ord"""

# The score shown on the page, as one statement.
SCORE_SQL = """SELECT ROUND(100 * SUM(IF(sim >= %(tau)s, chars, 0)) / SUM(chars)) AS coverage,
       ROUND(100 * AVG(sim)) AS similarity, COUNT(*) AS paragraphs
FROM (SELECT a.chars, 1 - (SELECT MIN(VEC_DISTANCE_COSINE(a.emb, b.emb))
             FROM lens_chunk FOR SYSTEM_TIME AS OF TIMESTAMP %(t)s AS b
             WHERE b.topic = a.topic AND b.lang = %(b)s) AS sim
      FROM lens_chunk FOR SYSTEM_TIME AS OF TIMESTAMP %(t)s AS a
      WHERE a.topic = %(topic)s AND a.lang = %(a)s) s"""


def editions(topic):
    """The article's loaded language editions, longest first, and the default pairwise reference
    (Finnish when the article has a Finnish edition, otherwise the longest one)."""
    langs = [r["lang"] for r in rows("""SELECT lang, MAX(chars) c FROM lens_snapshot WHERE topic = %s
                                         GROUP BY lang ORDER BY c DESC""", (topic,))]
    return langs, ("fi" if "fi" in langs else (langs[0] if langs else "fi"))


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def moment(value):
    if not value:
        return now()
    return value if len(value) > 4 else f"{value}-01-01 00:00:00"


def _clean(rs):
    for r in rs:
        r["text"] = html.unescape(r["text"])
        r["section"] = html.unescape(r["section"])
    return rs


def matches(topic, a, b, t):
    return _clean(rows(MATCH_SQL, {"topic": topic, "a": a, "b": b, "t": t}))


def chunks(topic, lang, t):
    return _clean(rows("""SELECT id, ord, section, text, chars FROM lens_chunk FOR SYSTEM_TIME AS OF TIMESTAMP %s
                   WHERE topic = %s AND lang = %s ORDER BY ord""", (t, topic, lang)))


def alignment(topic, lang, t=None, ref="fi"):
    """Reference paragraphs (Finnish by default) paired with their nearest `lang` paragraph, and what each side has alone.
    Keys keep the name "fi" for the reference side."""
    t = moment(t)
    fi_all, other_all = chunks(topic, ref, t), chunks(topic, lang, t)
    other_by_id = {c["id"]: c for c in other_all}
    fwd = matches(topic, ref, lang, t)
    back = {m["id"]: m for m in matches(topic, lang, ref, t)}
    pairs, fi_only = [], []
    for m in fwd:
        fi = {k: m[k] for k in ("id", "ord", "section", "text", "chars")}
        sim = float(m["sim"] or 0)
        mutual = m["match_id"] in back and back[m["match_id"]]["match_id"] == m["id"]
        if mutual and sim >= PAIR_MIN and m["match_id"] in other_by_id:
            pairs.append({"fi": fi, "match": other_by_id[m["match_id"]], "sim": sim})
        elif sim < TAU:
            fi_only.append({**fi, "sim": sim})
    paired = {p["match"]["id"] for p in pairs}
    other_only = [{**other_by_id[i], "sim": float(m["sim"] or 0)} for i, m in back.items()
                  if i not in paired and float(m["sim"] or 0) < TAU and i in other_by_id]
    return {"pairs": pairs, "fi_only": fi_only, "other_only": sorted(other_only, key=lambda c: c["ord"]),
            "fi_all": fi_all, "other_all": other_all}


def score(topic, lang, t, ref="fi"):
    r = rows(SCORE_SQL, {"tau": TAU, "topic": topic, "a": ref, "b": lang, "t": t})[0]
    return {k: (float(v) if v is not None else None) for k, v in r.items()}


_HAS_REF = None


def analysis(topic, lang, ref="fi"):
    global _HAS_REF
    if _HAS_REF is None:
        _HAS_REF = bool(rows("SHOW COLUMNS FROM lens_analysis LIKE 'ref'"))
    if _HAS_REF:
        r = rows("SELECT result, model, created FROM lens_analysis WHERE topic = %s AND ref = %s AND lang = %s", (topic, ref, lang))
    else:
        r = rows("SELECT result, model, created FROM lens_analysis WHERE topic = %s AND lang = %s", (topic, lang)) if ref == "fi" else []
    if not r:
        return None
    out = json.loads(r[0]["result"])
    out["model"], out["created"] = r[0]["model"], str(r[0]["created"])
    return out


def index(coverage, agreement):
    """Kielipeili index: geometric mean of coverage (how much of the reference story is told) and agreement
    (how consistently the shared part is told). Low on either axis pulls it down."""
    if coverage is None or agreement is None:
        return None
    return round((coverage * agreement) ** 0.5)


# The lens_* tables only change when scripts/lens_build.py runs, so every API answer is cached in memory
# (gzipped JSON, keyed by path + query) and warmed for all articles when the app starts.
_CACHE = {}


def cached(fn):
    @functools.wraps(fn)
    def wrapper():
        key = (request.path, tuple(sorted(request.args.items())))   # decoded, so encodings don't split the cache
        if key not in _CACHE:
            body = json.dumps(fn(), ensure_ascii=False, default=str, separators=(",", ":")).encode()
            _CACHE[key] = (body, gzip.compress(body, 6))
        body, gz = _CACHE[key]
        if "gzip" in request.headers.get("Accept-Encoding", ""):
            return Response(gz, mimetype="application/json", headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding",
                                                                       "Cache-Control": "public, max-age=300"})
        return Response(body, mimetype="application/json", headers={"Cache-Control": "public, max-age=300"})
    return wrapper


@bp.record_once
def _warm(state):
    def run():
        import time   # wait until app/server.py has registered every blueprint and route: a request before that
        for _ in range(300):   # locks the app's setup and the later registrations fail
            if "static_files" in state.app.view_functions:
                break
            time.sleep(0.1)
        client = state.app.test_client()
        try:
            topics = client.get("/api/kielipeili/topics").get_json() or []
            for t in topics:
                client.get("/api/kielipeili/scores", query_string={"topic": t["topic"]})
                client.get("/api/kielipeili/consensus", query_string={"topic": t["topic"]})
                langs, base = editions(t["topic"])
                for lang in [l for l in langs if l != base]:
                    client.get("/api/kielipeili/align", query_string={"topic": t["topic"], "lang": lang, "ref": base})
                client.get("/api/kielipeili/timeline", query_string={"topic": t["topic"]})
                client.get("/api/kielipeili/pairs", query_string={"topic": t["topic"]})
                client.get("/api/kielipeili/align", query_string={"topic": t["topic"], "lang": "uk", "ref": "ru"})
        except Exception as e:  # noqa: BLE001 - warming is best effort
            print("kielipeili warm-up stopped:", e, flush=True)
    threading.Thread(target=run, daemon=True).start()


@bp.get("/topics")
@cached
def api_topics():
    out = rows("""SELECT t.topic, t.wikidata, t.titles,
                    (SELECT COUNT(DISTINCT lang) FROM lens_chunk c WHERE c.topic = t.topic) AS langs
                  FROM lens_topic t ORDER BY t.topic""")
    for r in out:
        r["titles"] = json.loads(r["titles"])
    return [r for r in out if r["langs"]]


@bp.get("/scores")
@cached
def api_scores():
    """Per language: coverage of the Finnish text, mean similarity, size, Claude's agreement score."""
    topic, t = request.args["topic"], moment(request.args.get("at"))
    langs, base = editions(topic)
    ref = request.args.get("ref") or base
    snaps = {r["lang"]: r for r in rows(
        """SELECT s.lang, s.title, s.rev_id, s.ts, s.chars, s.n_chunks FROM lens_snapshot s
           WHERE s.topic = %s AND s.ts = (SELECT MAX(ts) FROM lens_snapshot x
                                         WHERE x.topic = s.topic AND x.lang = s.lang AND x.ts <= %s)""",
        (topic, t))}
    fi_chars = (snaps.get(ref) or {}).get("chars") or 1
    out = []
    for lang in langs:
        if lang not in snaps:
            continue
        s = snaps[lang]
        sc = score(topic, lang, t, ref) if lang != ref else {"coverage": 100, "similarity": 100}
        an = analysis(topic, lang, ref) if lang != ref else None
        out.append({"lang": lang, "title": s["title"], "rev_id": s["rev_id"], "ts": str(s["ts"]),
                    "chars": s["chars"], "paragraphs": s["n_chunks"],
                    "length_ratio": round(100 * s["chars"] / fi_chars),
                    "coverage": sc["coverage"], "similarity": sc["similarity"],
                    "agreement": (an or {}).get("agreement") if lang != ref else 100,
                    "index": 100 if lang == ref else index(sc["coverage"], (an or {}).get("agreement")),
                    "summary": (an or {}).get("summary")})
    return {"topic": topic, "at": t, "tau": TAU, "ref": ref, "base": base, "languages": out}


@bp.get("/timeline")
@cached
def api_timeline():
    """Coverage of the Finnish text per language, as both versions stood on 1 January of each year."""
    topic = request.args["topic"]
    langs, base = editions(topic)
    ref = request.args.get("ref") or base
    points = [(str(y), f"{y}-01-01 00:00:00") for y in YEARS] + [("now", now())]
    series = {}
    for lang in [l for l in langs if l != ref]:
        for label, t in points:
            sc = score(topic, lang, t, ref)
            if sc["coverage"] is not None:
                series.setdefault(lang, []).append({"year": label, "t": t, **sc})
    history = len(rows("SELECT DISTINCT ts FROM lens_snapshot WHERE topic = %s", (topic,))) > len(langs)
    sizes = {}
    for lang in langs:
        for label, t in points:
            r = rows("""SELECT chars FROM lens_snapshot WHERE topic = %s AND lang = %s AND ts <= %s ORDER BY ts DESC LIMIT 1""",
                     (topic, lang, t))
            sizes.setdefault(lang, []).append({"year": label, "chars": r[0]["chars"] if r else 0})
    return {"topic": topic, "ref": ref, "series": series, "sizes": sizes, "history": history, "sql": SCORE_SQL.strip()}


@bp.get("/align")
@cached
def api_align():
    topic, lang, ref = request.args["topic"], request.args["lang"], request.args.get("ref", "fi")
    al = alignment(topic, lang, request.args.get("at"), ref)
    an = analysis(topic, lang, ref)
    slim = lambda c: {"section": c["section"], "text": c["text"]}   # only what the page shows
    # paragraph maps of both articles for the mirror: length, matched pair, and where each difference sits
    pair_of = {}
    for i, p in enumerate(al["pairs"]):
        pair_of[("fi", p["fi"]["id"])] = i
        pair_of[("x", p["match"]["id"])] = i
    norm = lambda t: " ".join((t or "").split()).rstrip("…").strip()

    def article_map(chunks, side, quote_key):
        out = [{"s": c["section"], "c": c["chars"], "p": pair_of.get((side, c["id"])), "k": [],
                "h": hashlib.sha1(c["text"].encode()).hexdigest()} for c in chunks]
        texts = [norm(c["text"]) for c in chunks]
        items = [(f, "fact") for f in (an or {}).get("facts", [])] + [(f, f.get("kind")) for f in (an or {}).get("framing", [])]
        for n, (f, kind) in enumerate(items):
            q = norm(f.get(quote_key))
            if q:
                hit = next((i for i, t in enumerate(texts) if q in t), None)
                if hit is not None:
                    out[hit]["k"].append(kind)
        return out

    return {"pairs": [{"fi": slim(p["fi"]), "match": slim(p["match"]), "sim": round(p["sim"], 3)} for p in al["pairs"]],
            "n_fi_only": len(al["fi_only"]), "n_other_only": len(al["other_only"]),
            "map": {"fi": article_map(al["fi_all"], "fi", "fi"), "other": article_map(al["other_all"], "x", "other")},
            "ref": ref, "tau": TAU, "analysis": an, "sql": MATCH_SQL.strip()}


@bp.get("/pairs")
@cached
def api_pairs():
    """Who resembles whom, per snapshot year: share of language a's text that has a counterpart in language b
    (precomputed by scripts/lens_pairs.py with SCORE_SQL for every ordered pair and year)."""
    topic = request.args["topic"]
    if not rows("SHOW TABLES LIKE 'lens_pair'"):
        return {"topic": topic, "years": [], "cov": {}}
    out, years = {}, []
    for r in rows("SELECT year, a, b, coverage FROM lens_pair WHERE topic = %s ORDER BY year = 'now', year", (topic,)):
        if r["year"] not in years:
            years.append(r["year"])
        out.setdefault(r["year"], {}).setdefault(r["a"], {})[r["b"]] = r["coverage"]
    return {"topic": topic, "years": years, "langs": editions(topic)[0], "cov": out}


# ---------- consensus scoring, dynamic loading, source checks (app/lens_engine.py) ----------
@bp.post("/load")
def api_load():
    from app import lens_engine as E
    body = request.get_json(force=True, silent=True) or {}
    text = (body.get("q") or "").strip()
    if not text:
        return jsonify({"error": "type an article title or paste a Wikipedia URL"}), 400
    running = [j for j in E.JOBS.values() if j["state"] == "running" and j["kind"] == "load"]
    if len(running) >= 2:
        return jsonify({"error": "two articles are loading already; try again in a minute"}), 429
    jid = E.start_job("load", E.load_article, text, int(body.get("n") or E.N_EDITIONS), body.get("lang") or "en")
    return jsonify({"job": jid})


@bp.post("/add")
def api_add():
    from app import lens_engine as E
    body = request.get_json(force=True, silent=True) or {}
    topic, langs = body.get("topic"), [l for l in (body.get("langs") or []) if isinstance(l, str) and len(l) <= 3]
    if not topic or not langs:
        return jsonify({"error": "topic and langs needed"}), 400
    return jsonify({"job": E.start_job("load", E.add_editions, topic, langs)})


@bp.get("/job")
def api_job():
    from app import lens_engine as E
    j = E.JOBS.get(request.args.get("id", ""))
    return jsonify(j or {"state": "missing"})


@bp.get("/consensus")
@cached
def api_consensus():
    from app import lens_engine as E
    return E.summary(request.args["topic"]) or {"missing": True}


@bp.get("/gaps")
def api_gaps():
    """Every unmatched paragraph of a language pair, classified (missing content / no equivalent concept / audience context)
    with an English gist. Computed once per pair by Claude in the background, then cached."""
    from app import lens_engine as E
    topic, ref, lang = request.args["topic"], request.args.get("ref", "fi"), request.args["lang"]
    got = E.get_gaps(topic, ref, lang)
    if got is None:
        E.ensure_gaps_job(topic, ref, lang)
        return jsonify({"pending": True})
    return jsonify(got)


@bp.get("/translate")
def api_translate():
    """Full English translation of one paragraph (by its sha1), cached."""
    from app import lens_engine as E
    out = E.translate_para(request.args["topic"], request.args["lang"], request.args["h"])
    return jsonify(out or {"error": "paragraph not found"})


@bp.get("/story")
def api_story():
    """How the editions changed over time: Claude's narrative from the coverage timeline, sizes and pair moves (cached)."""
    from app import lens_engine as E
    topic = request.args["topic"]
    got = E.get_story(topic)
    if got is None:
        E.ensure_story_job(topic)
        return jsonify({"pending": True})
    return jsonify(got)


DUMP = pathlib.Path(__file__).resolve().parent.parent / "web" / "data" / "lens.sql.gz"


@bp.get("/dump")
def api_dump():
    """mariadb-dump --dump-history of the lens_* tables, served as a plain gzip file. An explicit mimetype keeps
    Flask from sending Content-Encoding: gzip, which proxies would otherwise decompress on the fly."""
    return send_file(DUMP, mimetype="application/gzip", as_attachment=True, download_name="lens.sql.gz")
