"""The Authors: the people (and bots) who wrote Finland's history on Finnish Wikipedia.

Aggregates come from viz_authors_* tables (scripts/build_authors.py, one scan of `revision`); the "first words"
of an editor are read live from the system-versioned `article` table with FOR SYSTEM_TIME AS OF.
"""
import datetime as dt
import decimal
import html
import json
from functools import lru_cache
from flask import Blueprint, Response, jsonify, request
from contextlib import contextmanager
from app.db import rows
from wikitime.db import connect
import pymysql
import queue
import bisect
import threading
import unicodedata
from wikitime.wikitext import clean

bp = Blueprint("authors", __name__)
LANES = 200
TOP_BOTS = 6


def _once(fn):
    """lru_cache(1) plus a lock, so a request that arrives during the start-up warm-up waits for it
    instead of running the same heavy queries a second time."""
    cached, lock = lru_cache(maxsize=1)(fn), threading.Lock()

    def wrapper():
        with lock:
            return cached()
    return wrapper


_POOL = queue.LifoQueue()   # idle connections, reused across requests


@contextmanager
def _db():
    """All queries of one request share a pooled connection. The dev server starts a new thread per request, so
    a thread-local connection would reconnect every time, and a fresh connection to chili costs ~0.7 s."""
    try:
        con = _POOL.get_nowait()
    except queue.Empty:
        con = connect(autocommit=True)

    def q(sql, params=()):
        nonlocal con
        for attempt in (0, 1):
            try:
                with con.cursor() as cur:
                    cur.execute(sql, params)
                    if cur.description is None:
                        return []
                    cols = [d[0] for d in cur.description]
                    return [dict(zip(cols, r)) for r in cur.fetchall()]
            except (pymysql.err.OperationalError, pymysql.err.InterfaceError):
                try:
                    con.close()
                except Exception:
                    pass
                if attempt:
                    raise
                con = connect(autocommit=True)
    ok = False
    try:
        yield q
        ok = True
    finally:
        if ok and _POOL.qsize() < 4:
            _POOL.put(con)
        else:
            try:
                con.close()
            except Exception:
                pass


def _num(o):
    if isinstance(o, decimal.Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    if isinstance(o, (dt.date, dt.datetime)):
        return o.isoformat()
    raise TypeError(type(o))


def _compact(obj):
    """Compact JSON (the dev server pretty-prints jsonify, which triples the size of the big payloads)."""
    return Response(json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=_num),
                    mimetype="application/json")


def _iso(d):
    return d.isoformat() if isinstance(d, (dt.date, dt.datetime)) else d


def _mi(d):
    """Month index since 2003-01."""
    return (d.year - 2003) * 12 + d.month - 1


@_once
def _overview():
    with _db() as rows:   # one connection for all of this request's queries
        months = rows("SELECT * FROM viz_authors_month ORDER BY month")
        meta = {r["k"]: r["v"] for r in rows("SELECT k, v FROM viz_authors_meta")}
        all_edits = int(meta["versions"])   # every version, incl. the few whose user name is hidden
        end = rows("SELECT MAX(last_ts) t FROM viz_authors_user")[0]["t"]
        if end.day < 25 and months[-1]["month"].month == end.month:   # the dump ends early in a month: drop the stub
            months = months[:-1]
        m0 = months[0]["month"]
        month_keys = [_iso(m["month"])[:7] for m in months]
        idx = {m["month"]: i for i, m in enumerate(months)}
        n = len(months)
        series = {k: [int(m[k] or 0) for m in months] for k in
                  ("edits", "reg", "bot", "anon", "anon_temp", "reg_editors", "reg_active5", "bot_editors",
                   "anon_ids", "new_reg", "reverts")}

        cohorts = sorted({r["cohort"] for r in rows("SELECT DISTINCT cohort FROM viz_authors_cohort")})
        layers = {c: {"editors": [0] * n, "active5": [0] * n, "edits": [0] * n} for c in cohorts}
        for r in rows("SELECT month, cohort, editors, active5, edits FROM viz_authors_cohort"):
            i = idx.get(r["month"])
            if i is None:
                continue
            for k in ("editors", "active5", "edits"):
                layers[r["cohort"]][k][i] = int(r[k])
        cyear = rows("SELECT year, cohort, editors, edits FROM viz_authors_cohort_year ORDER BY cohort, year")

        users = rows("""SELECT kind, COUNT(*) n, SUM(edits) edits, SUM(last_word) last_word, SUM(created) created,
                               SUM(undone) undone FROM viz_authors_user GROUP BY kind""")
        kinds = {u["kind"]: {k: int(v) for k, v in u.items() if k != "kind"} for u in users}
        total_edits = sum(series["edits"])
        pages = rows("SELECT COUNT(*) n FROM viz_authors_page")[0]
        lw_anon = rows("""SELECT COUNT(*) n FROM viz_authors_page p
                          LEFT JOIN viz_authors_user u ON u.user = p.last_user WHERE u.user IS NULL""")[0]["n"]

        # bots: the biggest ones get their own band; what they do = their most common edit summary
        bots = rows(f"""SELECT user, edits, first_ts, last_ts, last_word, pages, rnk FROM viz_authors_user
                        WHERE kind='bot' ORDER BY edits DESC LIMIT {TOP_BOTS}""")
        names = [b["user"] for b in bots]
        bot_series = {b: [0] * n for b in names}
        other = [0] * n
        for r in rows("SELECT month, user, edits FROM viz_authors_botmonth"):
            if r["month"] in idx:
                (bot_series[r["user"]] if r["user"] in bot_series else other)[idx[r["month"]]] += int(r["edits"])
        summ = {}
        if names:
            ph = ",".join(["%s"] * len(names))
            for r in rows(f"SELECT user, example, n FROM viz_authors_user_comment WHERE k=1 AND user IN ({ph})", names):
                summ[r["user"]] = {"example": r["example"], "n": int(r["n"])}
        for b in bots:
            b["first"], b["last"] = _iso(b.pop("first_ts")), _iso(b.pop("last_ts"))
            b["summary"] = summ.get(b["user"])
            b["series"] = bot_series[b["user"]]

        hours = {}
        for r in rows("SELECT kind, dow, hour, edits FROM viz_authors_hour"):
            hours.setdefault(r["kind"], [[0] * 24 for _ in range(7)])[r["dow"] - 1][r["hour"]] = int(r["edits"])

        top = rows(f"SELECT SUM(edits) e FROM (SELECT edits FROM viz_authors_user ORDER BY edits DESC LIMIT 120) t")[0]["e"]
        nreg = kinds.get("reg", {}).get("n", 0)
        top1 = rows(f"""SELECT SUM(edits) e FROM (SELECT edits FROM viz_authors_user WHERE kind='reg'
                        ORDER BY edits DESC LIMIT {max(1, nreg // 100)}) t""")[0]["e"]
        data = {
            "months": month_keys, "series": series, "cohorts": cohorts,
            "layers": {str(c): v for c, v in layers.items()}, "cohort_year": cyear,
            "kinds": kinds, "total_edits": total_edits, "all_edits": all_edits, "hidden_user": int(meta["hidden_user"]), "pages": int(pages["n"]), "last_word_anon": int(lw_anon),
            "bots": bots, "bot_other": other, "n_bots": kinds.get("bot", {}).get("n", 0),
            "hours": hours, "end": _iso(end), "top120_edits": int(top), "top1pct": {"n": max(1, nreg // 100), "edits": int(top1)},
        }
        data["callouts"] = _callouts(data)
        data["sql"] = SQL_OVERVIEW
        return data


def _year_sums(d, key):
    out = {}
    for i, m in enumerate(d["months"]):
        y = int(m[:4])
        out.setdefault(y, [0, 0])
        out[y][0] += d["series"][key][i]
        out[y][1] += d["series"]["edits"][i]
    return out


def _callouts(d):
    """Headline findings, each computed from the aggregates (no hand-written numbers)."""
    c = {}
    months, s = d["months"], d["series"]
    last_full = int(months[-1][:4]) - (0 if months[-1].endswith("-12") else 1)
    an = {y: a / e for y, (a, e) in _year_sums(d, "anon").items() if e >= 1000}
    peak_y = max(an, key=an.get)
    c["anon"] = {"peak_year": peak_y, "peak_share": an[peak_y], "last_year": last_full, "last_share": an[last_full],
                 "now_year": int(months[-1][:4]), "now_share": an.get(int(months[-1][:4]))}
    tmp = [i for i, v in enumerate(s["anon_temp"]) if v > 0]
    if tmp:
        i0 = tmp[0]
        tail = range(i0, len(months))
        c["anon"]["temp_first"] = months[i0]
        c["anon"]["temp_share_since"] = sum(s["anon_temp"][i] for i in tail) / max(1, sum(s["anon"][i] for i in tail))
    bt = {y: b / e for y, (b, e) in _year_sums(d, "bot").items() if e >= 1000}
    by = max(bt, key=bt.get)
    c["bot"] = {"peak_year": by, "peak_share": bt[by], "first_year": min(y for y, v in bt.items() if v > 0)}
    if d["bots"]:
        b = d["bots"][0]
        c["bot"]["top"] = {k: b[k] for k in ("user", "edits", "first", "last_word", "pages", "summary")}
        fi = next(i for i, v in enumerate(b["series"]) if v)
        since = range(fi, len(months))
        c["bot"]["top"]["share_since"] = sum(b["series"][i] for i in since) / max(1, sum(s["edits"][i] for i in since))
        c["bot"]["top"]["share_bot_since"] = sum(b["series"][i] for i in since) / max(1, sum(s["bot"][i] for i in since))
    kb = d["kinds"].get("bot", {})
    c["last_word"] = {"bot": kb.get("last_word", 0), "reg": d["kinds"].get("reg", {}).get("last_word", 0),
                      "anon": d["last_word_anon"], "pages": d["pages"],
                      "top": sorted(((b["user"], b["last_word"]) for b in d["bots"]), key=lambda x: -x[1])[:3]}
    a5 = s["reg_active5"]
    pi = max(range(len(a5)), key=lambda i: a5[i])
    ed = s["reg_editors"]
    pe = max(range(len(ed)), key=lambda i: ed[i])
    last12 = range(len(months) - 13, len(months) - 1)
    c["active"] = {"peak_month": months[pi], "peak": a5[pi], "peak_editors_month": months[pe], "peak_editors": ed[pe],
                   "recent_avg": sum(a5[i] for i in last12) / 12, "recent_editors_avg": sum(ed[i] for i in last12) / 12}
    size = {}
    for r in d["cohort_year"]:
        if r["year"] == r["cohort"]:
            size[r["cohort"]] = int(r["editors"])
    big = max(size, key=size.get)
    now = int(months[-1][:4])
    still = next((int(r["editors"]) for r in d["cohort_year"] if r["cohort"] == big and r["year"] == now), 0)
    c["cohort"] = {"biggest": big, "size": size[big], "still_year": now, "still": still}
    pre = [c_ for c_ in size if c_ <= 2010]
    if pre:
        lastm = len(months) - 1
        old = sum(d["layers"][str(k)]["editors"][lastm] for k in pre)
        allm = sum(d["layers"][str(k)]["editors"][lastm] for k in size)
        c["cohort"]["veterans"] = {"upto": 2010, "month": months[lastm], "n": old, "of": allm}
    c["concentration"] = {"top120": d["top120_edits"] / d["total_edits"], "top1pct_n": d["top1pct"]["n"],
                          "top1pct": d["top1pct"]["edits"] / max(1, d["kinds"].get("reg", {}).get("edits", 1)),
                          "n_reg": d["kinds"].get("reg", {}).get("n", 0)}
    return c


SQL_OVERVIEW = """-- one streaming scan of the version metadata (862,076 rows) feeds the precompute
SELECT rev_id, page_id, title, ts, user, anonymous, minor, sha1, bytes, delta, is_revert,
       LEFT(comment, 160)
FROM revision;

-- the result, served to this page: registered editors per month by first-edit year
SELECT month, cohort, editors, active5, edits FROM viz_authors_cohort;"""


@bp.get("/overview")
def overview():
    return _compact(_overview())


@_once
def _lanes():
    with _db() as rows:   # one connection for all of this request's queries
        users = rows(f"""SELECT user, kind, cohort, first_ts, last_ts, edits, pages, created, last_word, reverts, undone,
                                minor, months, rnk FROM viz_authors_user ORDER BY rnk LIMIT {LANES}""")
        cells, tops = {}, {}
        for r in rows("SELECT user, month, edits FROM viz_authors_lane ORDER BY user, month"):
            cells.setdefault(r["user"], []).append([_mi(r["month"]), int(r["edits"])])
        names = [u["user"] for u in users]
        ph = ",".join(["%s"] * len(names))
        for r in rows(f"""SELECT user, page_id, title, edits FROM viz_authors_user_page WHERE user IN ({ph})
                          ORDER BY user, edits DESC""", names):
            t = tops.setdefault(r["user"], [])
            if len(t) < 3:
                t.append([r["title"], int(r["edits"])])
        for u in users:
            u["first"], u["last"] = _iso(u.pop("first_ts")), _iso(u.pop("last_ts"))
            u["cells"] = cells.get(u["user"], [])
            u["top"] = tops.get(u["user"], [])
            for k in ("edits", "pages", "created", "last_word", "reverts", "undone", "minor"):
                u[k] = int(u[k])
        return {"users": users}


@bp.get("/lanes")
def lanes():
    return _compact(_lanes())


@bp.get("/search")
def search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify([])
    return jsonify(_search(q))


def _search(q):
    f = _fold(q)
    names = _users()[2]   # sorted by edits, descending
    hits = [n for k, _, n in names if k.startswith(f)][:12] or [n for k, _, n in names if f in k][:12]
    by = _users()[0]
    return [{k: by[n][k] for k in ("user", "kind", "edits", "cohort")} for n in hits]


EDITOR_SQL = """-- precomputed per editor (scripts/build_authors.py), one primary-key read each
SELECT * FROM viz_authors_user      WHERE user = @u;
SELECT * FROM viz_authors_user_year WHERE user = @u ORDER BY year;
SELECT * FROM viz_authors_user_page WHERE user = @u ORDER BY edits DESC;
SELECT page_id, title, edits FROM viz_authors_page
 WHERE created_by = @u ORDER BY edits DESC LIMIT 6;   -- articles they started"""


@_once
def _users():
    """viz_authors_user (15k rows) held in memory: profile headers, cohort ranks and name search need no round trip."""
    with _db() as rows:
        us = rows("SELECT * FROM viz_authors_user")
    by = {u["user"]: u for u in us}
    ranks = {}
    for u in us:
        ranks.setdefault((u["kind"], u["cohort"]), []).append(int(u["edits"]))
    for v in ranks.values():
        v.sort()
    names = sorted(((_fold(u["user"]), -int(u["edits"]), u["user"]) for u in us), key=lambda t: t[1])
    return by, ranks, names


@_once
def _pages():
    """Who started / last saved each article (viz_authors_page, 19.8k rows), indexed by editor."""
    with _db() as rows:
        ps = rows("SELECT page_id, title, edits, created_by, last_user, last_ts FROM viz_authors_page ORDER BY edits DESC")
    created, last = {}, {}
    for p in ps:
        created.setdefault(p["created_by"], []).append(p)
        last.setdefault(p["last_user"], []).append(p)
    return created, last


def _fold(x):
    """Case- and accent-insensitive key (like MariaDB's uca1400_ai_ci) for the name search."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", x or "") if not unicodedata.combining(ch)).casefold()


EDITOR_ONE = """SELECT 'y' t, JSON_OBJECT('year', year, 'edits', edits, 'minor', minor, 'reverts', reverts,
            'undone', undone, 'added', added, 'removed', removed) j FROM viz_authors_user_year WHERE user=%s
UNION ALL SELECT 'p', JSON_OBJECT('page_id', page_id, 'title', title, 'edits', edits)
            FROM viz_authors_user_page WHERE user=%s
UNION ALL SELECT 'h', JSON_ARRAY(dow, hour, edits) FROM viz_authors_user_hour WHERE user=%s
UNION ALL SELECT 'c', JSON_OBJECT('k', k, 'example', example, 'n', n) FROM viz_authors_user_comment WHERE user=%s"""


@lru_cache(maxsize=512)
def _editor(name):
    by, ranks, _ = _users()
    u = by.get(name)
    if not u:
        return None
    u = dict(u)
    for k in ("first_ts", "last_ts"):
        u[k] = _iso(u[k])
    for k in ("edits", "pages", "created", "last_word", "reverts", "undone", "minor", "added", "removed", "months"):
        u[k] = int(u[k])
    with _db() as rows:   # one round trip for the four per-editor tables
        got = {"y": [], "p": [], "h": [], "c": []}
        for r in rows(EDITOR_ONE, (name,) * 4):
            got[r["t"]].append(json.loads(r["j"]))
        if not got["p"]:   # editors with 1-2 edits: read them live (index on revision.user)
            got["p"] = [{"page_id": r["page_id"], "title": r["title"], "edits": int(r["n"])} for r in rows(
                """SELECT page_id, MAX(title) title, COUNT(*) n FROM revision WHERE user=%s GROUP BY page_id
                   ORDER BY n DESC LIMIT 6""", (name,))]
    u["years"] = sorted(({k: (v if v is not None else 0) for k, v in y.items()} for y in got["y"]),
                        key=lambda y: y["year"])
    u["pages_top"] = sorted(got["p"], key=lambda p: -p["edits"])
    if got["h"]:
        grid = [[0] * 24 for _ in range(7)]
        for dow, hour, n in got["h"]:
            grid[dow - 1][hour] = n
        u["hours"] = grid
    u["summaries"] = [{"example": c["example"], "n": c["n"]} for c in sorted(got["c"], key=lambda c: c["k"])]
    created, last = _pages()
    u["created_top"] = [{"page_id": p["page_id"], "title": p["title"], "edits": p["edits"]}
                        for p in created.get(name, [])[:6]]
    u["last_word_pages"] = [{"page_id": p["page_id"], "title": p["title"], "last_ts": _iso(p["last_ts"])}
                            for p in last.get(name, [])[:5]]
    same = ranks.get((u["kind"], u["cohort"]), [])
    u["cohort_size"] = len(same)
    u["cohort_rank"] = max(1, len(same) - bisect.bisect_left(same, u["edits"]))
    u["sql"] = EDITOR_SQL
    return u


@bp.get("/editor")
def editor():
    u = _editor(request.args.get("u", ""))
    if not u:
        return jsonify(error="no such editor"), 404
    return jsonify(u)


FIRST_SQL = """-- the first version of the article, exactly as it stood when this editor saved it
SELECT rev_id, user, LENGTH(text) AS len, text
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s;"""


@lru_cache(maxsize=256)
def _first_words(name):
    with _db() as rows:   # one connection for all of this request's queries
        cands = rows("""SELECT page_id, title, edits FROM viz_authors_page
                        WHERE created_by=%s ORDER BY edits DESC LIMIT 400""", (name,))
        have = set()
        for i in range(0, len(cands), 100):   # which of them have their text history loaded (bulk load may be running)
            ids = [c["page_id"] for c in cands[i:i + 100]]
            have |= {r["page_id"] for r in rows(
                f"SELECT DISTINCT page_id FROM article FOR SYSTEM_TIME ALL WHERE page_id IN ({','.join(['%s'] * len(ids))})",
                ids)}
            if len(have) >= 5:
                break
        for c in [c for c in cands if c["page_id"] in have][:5]:
            first = rows("SELECT rev_id, ts, user FROM revision WHERE page_id=%s ORDER BY ts, rev_id LIMIT 1",
                         (c["page_id"],))[0]
            ts = first["ts"].strftime("%Y-%m-%d %H:%M:%S.%f")
            v = rows(FIRST_SQL, (ts, c["page_id"]))
            if not v or v[0]["rev_id"] != first["rev_id"]:
                continue
            now = rows("SELECT rev_id, LENGTH(text) len FROM article WHERE page_id=%s", (c["page_id"],))
            blocks = [html.unescape(t) for k, t in clean(v[0]["text"] or "") if k == "p" and len(t) > 40]
            text = " ".join(blocks)[:700]
            if not text:
                continue
            return {"page_id": c["page_id"], "title": c["title"], "rev_id": first["rev_id"], "ts": first["ts"].isoformat(),
                    "len": int(v[0]["len"] or 0), "now_len": int(now[0]["len"]) if now else None,
                    "now_rev": now[0]["rev_id"] if now else None, "versions": int(c["edits"]), "text": text,
                    "sql": FIRST_SQL.replace("%s", f"'{ts}'", 1).replace("%s", str(c["page_id"]), 1)}
        return {"none": True, "created": len(cands)}


@bp.get("/firstwords")
def first_words():
    return jsonify(_first_words(request.args.get("u", "")))


def _warm():
    """Fill the caches for the first page view (overview, lanes, the default profile) when the server starts."""
    try:
        _overview()
        top = _lanes()["users"]
        _users()
        _pages()
        if top:
            _editor(top[0]["user"])
            _first_words(top[0]["user"])
    except Exception as e:   # the page still works, just slower on its first load
        print("authors: cache warm-up failed:", e)


threading.Thread(target=_warm, daemon=True).start()
