"""Three Wikipedias API: the same history told in Finnish, Swedish and English.

Topics are matched by Wikidata id in current_article. The cross-language semantic distance of every
topic is computed in MariaDB (VEC_DISTANCE_COSINE between the bge-m3 vectors of the fi/sv/en
articles, a self-join on wikidata_id) by scripts/build_polyglot.py into viz_polyglot_pairs. Per topic,
the page reads the intros live and runs live vector searches across languages."""
from concurrent.futures import ThreadPoolExecutor
import decimal, functools, json, re, statistics, threading, time
from flask import Blueprint, Response, request
from app.db import rows

bp = Blueprint("polyglot", __name__)
LANGS = ("fi", "sv", "en")


def _default(o):
    if isinstance(o, decimal.Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    return str(o)


def jsonify(obj):
    return Response(json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=_default),
                    mimetype="application/json")


# ---------- overview: coverage + per-pair summary ----------

COVERAGE_SQL = """SELECT (sv_page IS NOT NULL) AS sv, (en_page IS NOT NULL) AS en, COUNT(*) AS topics
FROM viz_polyglot_pairs GROUP BY sv, en"""

ACT_BUCKETS = [(1, 10), (11, 30), (31, 100), (101, 300), (301, 1000), (1001, 10 ** 9)]


@functools.lru_cache(maxsize=1)
def _overview():
    t0 = time.perf_counter()
    combos = rows(COVERAGE_SQL)
    sets = {l: r["n"] for l, r in zip(LANGS, rows(
        "SELECT lang, COUNT(*) n FROM current_article GROUP BY lang ORDER BY FIELD(lang,'fi','sv','en')"))}
    # topics whose Finnish article has no Wikidata id cannot be matched at all
    no_wd = rows("SELECT COUNT(*) n FROM current_article WHERE lang='fi' AND wikidata_id IS NULL")[0]["n"]
    themes = rows("""SELECT theme, MIN(theme_fi) theme_fi, COUNT(*) n,
                            SUM(sv_page IS NOT NULL) sv, SUM(en_page IS NOT NULL) en,
                            SUM(sv_page IS NOT NULL AND en_page IS NOT NULL) both3,
                            AVG(d_fi_en) d_fi_en, AVG(d_fi_sv) d_fi_sv
                     FROM viz_polyglot_pairs GROUP BY theme ORDER BY n DESC""")
    activity = []
    for lo, hi in ACT_BUCKETS:
        r = rows("""SELECT COUNT(*) n, SUM(sv_page IS NOT NULL) sv, SUM(en_page IS NOT NULL) en,
                           SUM(sv_page IS NOT NULL AND en_page IS NOT NULL) both3
                    FROM viz_polyglot_pairs WHERE versions BETWEEN %s AND %s""", (lo, hi))[0]
        activity.append({"label": f"{lo}–{hi}" if hi < 10 ** 9 else f"{lo}+", **r})
    years = rows("""SELECT first_year label, COUNT(*) n, SUM(sv_page IS NOT NULL) sv, SUM(en_page IS NOT NULL) en,
                           SUM(sv_page IS NOT NULL AND en_page IS NOT NULL) both3
                    FROM viz_polyglot_pairs WHERE first_year IS NOT NULL GROUP BY first_year ORDER BY first_year""")
    stats = {r["k"]: json.loads(r["v"]) for r in rows("SELECT k, v FROM viz_polyglot_stats")}
    pairs = {}
    for a, b in (("fi", "en"), ("fi", "sv"), ("sv", "en")):
        ds = [r["d"] for r in rows(f"SELECT d_{a}_{b} d FROM viz_polyglot_pairs WHERE d_{a}_{b} IS NOT NULL ORDER BY d")]
        hist = [0] * 30
        for d in ds:
            hist[min(29, int(d / 0.7 * 30))] += 1
        p = {"n": len(ds), "median": statistics.median(ds), "p10": ds[len(ds) // 10], "p90": ds[len(ds) * 9 // 10],
             "hist": hist, "hist_max": 0.7, "fit": stats["fit"].get(f"{a}_{b}")}
        if a == "fi":
            rk = rows(f"""SELECT SUM(rank_{b} = 1) top1, SUM(rank_{b} <= 10) top10, COUNT(rank_{b}) n,
                                 (SELECT COUNT(*) FROM current_article WHERE lang=%s) pool
                          FROM viz_polyglot_pairs""", (b,))[0]
            p.update(rank=rk, baseline=stats["baseline"].get(f"fi_{b}"))
        pairs[f"{a}_{b}"] = p
    return {"sets": sets, "combos": combos, "no_wikidata": no_wd, "themes": themes, "activity": activity,
            "years": years, "pairs": pairs, "coverage_sql": COVERAGE_SQL, "pairs_sql": stats.get("pairs_sql"),
            "ms": round((time.perf_counter() - t0) * 1000)}


@bp.get("/overview")
def overview():
    return jsonify(_overview())


# ---------- points: every topic that exists in at least two languages ----------

@functools.lru_cache(maxsize=1)
def _points():
    rs = rows("""SELECT fi_page, sv_page, en_page, fi_title, sv_title, en_title, fi_len, sv_len, en_len,
                        d_fi_en, d_fi_sv, d_sv_en, r_fi_en, r_fi_sv, r_sv_en, rank_en, rank_sv,
                        theme, versions, first_year
                 FROM viz_polyglot_pairs WHERE sv_page IS NOT NULL OR en_page IS NOT NULL
                 ORDER BY fi_page""")
    themes = sorted({r["theme"] for r in rs})
    ti = {t: i for i, t in enumerate(themes)}
    cols = {k: [] for k in rs[0]}
    for r in rs:
        for k, v in r.items():
            if k == "theme":
                v = ti[v]
            elif isinstance(v, float):
                v = round(v, 4)
            cols[k].append(v)
    cols["themes"] = themes
    cols["n"] = len(rs)
    return json.dumps(cols, separators=(",", ":"), ensure_ascii=False, default=_default)


@bp.get("/points")
def points():
    return Response(_points(), mimetype="application/json",
                    headers={"Cache-Control": "public, max-age=600"})


# ---------- one topic: intros side by side, live distances and cross-language searches ----------

TOPIC_SQL = """-- the same topic in three languages, matched by Wikidata id; distances computed live
SELECT a.lang, b.lang AS other,
       VEC_DISTANCE_COSINE(va.embedding, vb.embedding) AS distance
FROM current_article a
JOIN current_article b  ON b.wikidata_id = a.wikidata_id AND b.lang > a.lang
JOIN article_vector va ON va.lang = a.lang AND va.page_id = a.page_id
JOIN article_vector vb ON vb.lang = b.lang AND vb.page_id = b.page_id
WHERE a.wikidata_id = '{wd}'"""

NEAREST_SQL = """-- which {to} articles are nearest in meaning to the {frm} article? (vector index)
SELECT s.page_id, a.title, s.distance
FROM (SELECT page_id, VEC_DISTANCE_COSINE(embedding, @{frm}) AS distance
      FROM article_vector WHERE lang = '{to}'
      ORDER BY distance LIMIT {k}) s
JOIN current_article a ON a.lang = '{to}' AND a.page_id = s.page_id
ORDER BY s.distance"""

RANK_SQL = """-- how many {to} articles are closer to the {frm} article than its own {to} version? (exact, brute force)
SELECT COUNT(*) + 1 AS rank_of_counterpart, (SELECT COUNT(*) FROM article_vector WHERE lang = '{to}') AS pool
FROM article_vector
WHERE lang = '{to}' AND VEC_DISTANCE_COSINE(embedding, @{frm}) < {d:.6f}"""

_MD = [(re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"), (re.compile(r"[*_`]{1,3}"), ""),
       (re.compile(r"\s+"), " ")]


def intro(text, limit=900):
    """First paragraphs of the clean Markdown, before the first section heading."""
    out = []
    for line in (text or "").split("\n")[1 if (text or "").startswith("#") else 0:]:
        s = line.strip()
        if s.startswith("#"):
            if out:
                break
            continue
        if not s or s.startswith(("|", "{", "!")):
            continue
        for rx, rep in _MD:
            s = rx.sub(rep, s)
        out.append(s.strip())
        if sum(map(len, out)) > limit:
            break
    t = " ".join(out)
    if len(t) > limit:
        cut = t.rfind(". ", 0, limit)
        t = t[:cut + 1] if cut > limit * 0.5 else t[:limit].rsplit(" ", 1)[0] + " …"
    return t


_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="polyglot")


@functools.lru_cache(maxsize=1)
def _vector_pool():
    return {r["lang"]: r["n"] for r in rows("SELECT lang, COUNT(*) n FROM article_vector GROUP BY lang")}


@functools.lru_cache(maxsize=512)
def _topic(fi_page):
    t0 = time.perf_counter()
    p = rows("SELECT * FROM viz_polyglot_pairs WHERE fi_page=%s", (fi_page,))
    if not p:
        return None
    p = p[0]
    pages = {l: p[f"{l}_page"] for l in LANGS if p[f"{l}_page"]}

    def article(l, pid):
        a = rows("""SELECT a.title, a.url, a.date_modified, CHAR_LENGTH(a.text) len, LEFT(a.text, 6000) text,
                           v.embedding FROM current_article a JOIN article_vector v USING (lang, page_id)
                    WHERE a.lang=%s AND a.page_id=%s""", (l, pid))
        if not a:
            return None
        a = a[0]
        return {"page_id": pid, "title": a["title"], "url": a["url"], "len": a["len"],
                "modified": a["date_modified"], "intro": intro(a["text"]), "_v": a["embedding"]}

    def distances():
        q0 = time.perf_counter()
        d = {f'{r["lang"]}_{r["other"]}': r["distance"]
             for r in rows(TOPIC_SQL.replace("'{wd}'", "%s"), (p["wikidata_id"],))} if p["wikidata_id"] else {}
        return d, (time.perf_counter() - q0) * 1000

    # the articles and the live distances are independent round trips: fetch them together
    fa = {l: _POOL.submit(article, l, pid) for l, pid in pages.items()}
    fd = _POOL.submit(distances)
    arts = {l: f.result() for l, f in fa.items() if f.result()}
    dist, dist_ms = fd.result()
    # canonical keys fi_en / fi_sv / sv_en (the SQL orders languages alphabetically: en < fi < sv)
    key = {"en_fi": "fi_en", "fi_sv": "fi_sv", "en_sv": "sv_en"}
    dist = {key[k]: v for k, v in dist.items()}

    # the cross-language vector searches and exact rank counts are independent: run them in parallel on
    # the long-lived worker threads (each keeps its own DB connection; a fresh one costs ~0.7 s)
    jobs = {}

    def search(frm, to, k=6):
        q0 = time.perf_counter()
        found = rows(f"""SELECT s.page_id, a.title, s.distance FROM (
                           SELECT page_id, VEC_DISTANCE_COSINE(embedding, %s) AS distance
                           FROM article_vector WHERE lang = %s ORDER BY distance LIMIT {k}) s
                         JOIN current_article a ON a.lang = %s AND a.page_id = s.page_id
                         ORDER BY s.distance""", (arts[frm]["_v"], to, to))
        return found, (time.perf_counter() - q0) * 1000

    def rank(frm, to, d):
        q0 = time.perf_counter()
        r = rows("""SELECT COUNT(*) + 1 AS rk FROM article_vector
                    WHERE lang = %s AND VEC_DISTANCE_COSINE(embedding, %s) < %s""",
                 (to, arts[frm]["_v"], d - 1e-9))[0]
        return {"rank": r["rk"], "ms": round((time.perf_counter() - q0) * 1000)}

    for frm in arts:
        for to in LANGS:
            if to == frm or (frm != "fi" and to != "fi"):
                continue          # fi -> sv, fi -> en, sv -> fi, en -> fi
            jobs[("n", frm, to)] = _POOL.submit(search, frm, to)
            pair = "_".join(sorted((frm, to), key=LANGS.index))
            if to in arts and pair in dist:
                jobs[("r", frm, to)] = _POOL.submit(rank, frm, to, dist[pair])
    nearest, ranks, qms = {}, {}, []
    for (kind, frm, to), f in jobs.items():
        if kind == "n":
            nearest[f"{frm}_{to}"], ms = f.result()
            qms.append(ms)
        else:
            ranks[f"{frm}_{to}"] = f.result()
    for a in arts.values():
        a.pop("_v")
    pool = _vector_pool()
    meta = {k: p[k] for k in ("wikidata_id", "theme", "theme_fi", "versions", "editors", "first_year",
                              "r_fi_en", "r_fi_sv", "r_sv_en")}
    sample_d = dist.get("fi_en", dist.get("fi_sv", 0.2))
    sql = ((TOPIC_SQL.format(wd=p["wikidata_id"]) if p["wikidata_id"] else
            "-- this Finnish article has no Wikidata id, so it cannot be matched to other languages") + ";\n\n" + NEAREST_SQL.format(frm="fi", to="en", k=6) + ";\n\n"
           + RANK_SQL.format(frm="fi", to="en" if "en" in arts else "sv", d=sample_d) + ";")
    return {"fi_page": fi_page, "articles": arts, "distances": dist, "nearest": nearest, "ranks": ranks,
            "pool": pool, "meta": meta, "sql": sql, "ms": {
                "distances": round(dist_ms, 1), "vector_searches": [round(x) for x in qms],
                "total": round((time.perf_counter() - t0) * 1000)}}


@bp.get("/topic/<int:fi_page>")
def topic(fi_page):
    t = _topic(fi_page)
    if t is None:
        return jsonify({"error": "unknown topic"}), 404
    return jsonify(t)


@bp.get("/topic/<path:bad>")
def topic_bad(bad):
    return jsonify({"error": "topic must be a Finnish page_id"}), 404


@bp.get("/search")
def search():
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify([])
    lit = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")   # match % and _ literally
    like = f"%{lit}%"
    return jsonify(rows("""SELECT fi_page, fi_title, sv_title, en_title FROM viz_polyglot_pairs
                           WHERE (sv_page IS NOT NULL OR en_page IS NOT NULL)
                             AND (fi_title LIKE %s OR sv_title LIKE %s OR en_title LIKE %s)
                           ORDER BY (fi_title LIKE %s OR en_title LIKE %s) DESC, versions DESC LIMIT 12""",
                        (like, like, like, lit + "%", lit + "%")))


def _warm():
    try:
        _overview(), _points()
        # the page opens on the most divergent non-stub fi<->en topic of the theme whose distances exceed
        # the length gap most (same rule as polyglot.js): precompute it so the first view answers instantly,
        # which also opens the worker threads' DB connections
        d = rows("""SELECT fi_page FROM viz_polyglot_pairs
                    WHERE theme = (SELECT theme FROM viz_polyglot_pairs WHERE d_fi_en IS NOT NULL
                                     AND theme NOT REGEXP 'Other|Uncategorised'
                                   GROUP BY theme HAVING COUNT(*) >= 50 ORDER BY AVG(r_fi_en) DESC LIMIT 1)
                      AND d_fi_en IS NOT NULL AND LEAST(fi_len, en_len) >= 500
                    ORDER BY d_fi_en DESC LIMIT 1""")
        if d:
            _topic(d[0]["fi_page"])
    except Exception:       # the DB may not be up yet; the first request will compute it
        pass


_t = threading.Timer(2.0, _warm)
_t.daemon = True
_t.start()
