"""Heartbeat API: the rhythm of editing. Aggregates come from the viz_heartbeat_* tables baked by
scripts/build_heartbeat.py (Helsinki local time); the day drill-down reads `revision` live and asks the
system-versioned `article` table what the day's most-edited article said before and after that day."""
import datetime as dt
import difflib
import functools
import html
import time
import json
from zoneinfo import ZoneInfo

from flask import Blueprint, Response, request
from app.db import rows
from wikitime.wikitext import clean
from scripts.build_heartbeat import is_bot

bp = Blueprint("heartbeat", __name__)
HEL, UTC = ZoneInfo("Europe/Helsinki"), dt.timezone.utc
D0 = dt.date(2003, 1, 1)
FILTERS = {"all": (0, 1, 2), "human": (0, 1), "reg": (0,), "anon": (1,), "bot": (2,)}
BUILD_SQL = """-- scripts/build_heartbeat.py streams every version once (862,076 rows) ...
SELECT page_id, ts, user, anonymous, is_revert, delta, comment, title FROM revision;
-- ... converts ts from UTC to Europe/Helsinki in Python (zoneinfo) and writes
-- viz_heartbeat_day / _day_top / _clock / _cat_month. The page then reads e.g.
SELECT d, kind, n, reverts, added, removed FROM viz_heartbeat_day ORDER BY d;
SELECT yr, kind, wd, hr, n FROM viz_heartbeat_clock;           -- Helsinki weekday x hour"""

DAY_SQL = """SELECT r.rev_id, r.ts, r.page_id, r.title, r.user, r.anonymous, r.minor,
       r.delta, r.bytes, r.is_revert, r.comment
FROM revision r
WHERE r.ts >= %s AND r.ts < %s          -- the Helsinki day as a UTC range (index on ts)
ORDER BY r.ts
-- editor kind (registered / anonymous / bot) is then filtered with the same rule as the precompute"""

ASOF_SQL = """SELECT rev_id, user, len, text
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s"""


def jsonify(obj=None, **kw):
    """Compact JSON (the dev server pretty-prints jsonify, which doubles the calendar payload)."""
    body = json.dumps(obj if obj is not None else kw, separators=(",", ":"), ensure_ascii=False, default=str)
    return Response(body, mimetype="application/json")


def _date(s):
    """Parse a YYYY-MM-DD path argument; None when it is not a date in the data's range."""
    try:
        d = dt.date.fromisoformat(s)
    except (TypeError, ValueError):
        return None
    return d if dt.date(2000, 1, 1) <= d <= dt.date(2100, 1, 1) else None


def _bad_date(s):
    return Response(json.dumps({"error": f"not a date (YYYY-MM-DD, 2000-2100): {s[:40]}"}, ensure_ascii=False),
                    status=400, mimetype="application/json")


def _filter(arg):
    return arg if arg in FILTERS else "all"


def _day_bounds(d):
    """Helsinki local day -> [start, end) in UTC (naive, as stored in revision.ts)."""
    s = dt.datetime.combine(d, dt.time(), HEL).astimezone(UTC).replace(tzinfo=None)
    e = dt.datetime.combine(d + dt.timedelta(days=1), dt.time(), HEL).astimezone(UTC).replace(tzinfo=None)
    return s, e


@functools.lru_cache(maxsize=1)
def _titles():
    return {r["page_id"]: r["title"] for r in rows("SELECT page_id, title FROM viz_heartbeat_page")}


@bp.get("/calendar")
def calendar():
    return jsonify(_calendar())


@functools.lru_cache(maxsize=1)
def _calendar():
    data = rows("SELECT d, kind, n, reverts, added, removed FROM viz_heartbeat_day ORDER BY d")
    last = max(r["d"] for r in data)
    nd = (last - D0).days + 1
    out = {k: {m: [0] * nd for m in ("n", "reverts", "added", "removed")} for k in (0, 1, 2)}
    for r in data:
        i = (r["d"] - D0).days
        for m in ("n", "reverts", "added", "removed"):
            out[r["kind"]][m][i] = int(r[m])
    return {"start": D0.isoformat(), "end": last.isoformat(), "ndays": nd,
            "kinds": {str(k): v for k, v in out.items()}, "sql": BUILD_SQL}


def _label_rows(top):
    """Rows of viz_heartbeat_day_top for one day+filter -> a readable summary."""
    t = _titles()
    pages = [{"page_id": r["page_id"], "title": t.get(r["page_id"], str(r["page_id"])), "n": r["n"]}
             for r in sorted((r for r in top if r["what"] == "page"), key=lambda r: r["rnk"])]
    u = next((r for r in top if r["what"] == "user"), None)
    total = top[0]["total"] if top else 0
    user = {"user": u["user"], "n": u["n"], "note": u["note"]} if u else None
    # A day is "driven" by one editor when they made at least half of its edits (bots, mass edits).
    driver = user if user and total and user["n"] * 2 >= total and total >= 20 else None
    return {"total": total, "pages": pages, "user": user, "driver": driver}


@bp.get("/top/<date>")
def top(date):
    d = _date(date)
    if d is None:
        return _bad_date(date)
    return jsonify(_top(d))


@functools.lru_cache(maxsize=4096)
def _top(d):
    rs = rows("SELECT * FROM viz_heartbeat_day_top WHERE d=%s", (d,))
    out = {}
    for f in FILTERS:
        sub = [r for r in rs if r["filt"] == f]
        if sub:
            out[f] = _label_rows(sub)
    return {"date": d.isoformat(), "filters": out}


@bp.get("/tops")
def tops():
    """Labels for several days at once: ?dates=2024-11-13,2011-04-18&filter=human (max 60)."""
    f = _filter(request.args.get("filter"))
    out = {}
    for x in (request.args.get("dates") or "").split(",")[:60]:
        d = _date(x)
        if d is None:
            continue
        lab = _top(d)["filters"].get(f)
        if lab:
            out[x] = lab
    return jsonify(filter=f, days=out)


@bp.get("/peaks")
def peaks():
    """The busiest day of every year (and the overall top days) for one filter, labelled."""
    return jsonify(_peaks(_filter(request.args.get("filter"))))


@functools.lru_cache(maxsize=8)
def _peaks(f):
    kinds = FILTERS[f]
    ph = ",".join(["%s"] * len(kinds))
    per_day = rows(f"""SELECT d, SUM(n) n FROM viz_heartbeat_day WHERE kind IN ({ph}) GROUP BY d""", kinds)
    best = {}
    for r in per_day:
        y = r["d"].year
        if y not in best or r["n"] > best[y]["n"]:
            best[y] = r
    top10 = sorted(per_day, key=lambda r: -r["n"])[:12]
    days = sorted({r["d"] for r in list(best.values()) + top10})
    ph2 = ",".join(["%s"] * len(days))
    tops = rows(f"SELECT * FROM viz_heartbeat_day_top WHERE filt=%s AND d IN ({ph2})", (f, *days))
    by_d = {}
    for r in tops:
        by_d.setdefault(r["d"], []).append(r)
    lab = {d: _label_rows(by_d.get(d, [])) for d in days}
    fmt = lambda r: {"date": r["d"].isoformat(), "n": int(r["n"]), **lab[r["d"]]}
    return {"filter": f, "years": {y: fmt(r) for y, r in sorted(best.items())},
            "top": [fmt(r) for r in top10]}


@bp.get("/clock")
def clock():
    return jsonify(_clock())


@functools.lru_cache(maxsize=1)
def _clock():
    data = rows("SELECT yr, kind, wd, hr, n FROM viz_heartbeat_clock")
    years = sorted({r["yr"] for r in data})
    out = {str(k): {str(y): [0] * 168 for y in years} for k in (0, 1, 2)}
    for r in data:
        out[str(r["kind"])][str(r["yr"])][r["wd"] * 24 + r["hr"]] = int(r["n"])
    return {"years": years, "kinds": out, "sql": """SELECT yr, kind, wd, hr, n FROM viz_heartbeat_clock
-- yr/wd/hr are Helsinki local time (EET/EEST), wd 0 = Monday; kind 0 person, 1 anonymous, 2 bot"""}


@bp.get("/ridges")
def ridges():
    return jsonify(_ridges(_filter(request.args.get("filter"))))


@functools.lru_cache(maxsize=8)
def _ridges(f):
    cats = rows("SELECT * FROM viz_heartbeat_cat ORDER BY rnk_edits")
    cm = rows("SELECT category, m, n, top_page_id, top_n FROM viz_heartbeat_cat_month WHERE filt=%s", (f,))
    nm = rows("SELECT MAX(m) + 1 nm FROM viz_heartbeat_cat_month")[0]["nm"]
    t = _titles()
    series = {c["category"]: {"n": [0] * nm, "tp": [0] * nm, "tn": [0] * nm} for c in cats}
    used = set()
    for r in cm:
        s = series[r["category"]]
        s["n"][r["m"]], s["tp"][r["m"]], s["tn"][r["m"]] = int(r["n"]), r["top_page_id"], int(r["top_n"])
        used.add(r["top_page_id"])
    return {"filter": f, "months": nm, "start": "2003-01", "cats": [
        {"category": c["category"], "articles": c["articles"], "edits": c["edits"],
         "edits_human": c["edits_human"], "rnk_edits": c["rnk_edits"], "rnk_articles": c["rnk_articles"],
         "series": series[c["category"]]} for c in cats],
        "titles": {p: t.get(p, str(p)) for p in used},
        "sql": f"""SELECT * FROM viz_heartbeat_cat ORDER BY rnk_edits;   -- the {len(cats)} biggest fi categories
SELECT category, m, n, top_page_id, top_n                -- m = months since 2003-01 (Helsinki)
FROM viz_heartbeat_cat_month WHERE filt = '{f}';"""}


@bp.get("/day/<date>")
def day(date):
    d = _date(date)
    if d is None:
        return _bad_date(date)
    return jsonify(_day(d, _filter(request.args.get("filter"))))


@functools.lru_cache(maxsize=256)
def _day(d, f):
    s, e = _day_bounds(d)
    kinds = FILTERS[f]
    sql = DAY_SQL
    t0 = time.perf_counter()
    edits = rows(sql, (s, e))
    ms = (time.perf_counter() - t0) * 1000
    for r in edits:
        r["kind"] = 1 if r["anonymous"] else (2 if is_bot(r["user"]) else 0)
    edits = [r for r in edits if r["kind"] in kinds]
    by_page, by_user = {}, {}
    hours = [[0, 0, 0] for _ in range(24)]
    for r in edits:
        loc = r["ts"].replace(tzinfo=UTC).astimezone(HEL)
        r["local"] = loc.strftime("%H:%M")
        hours[loc.hour][r["kind"]] += 1
        r["comment"] = (r["comment"] or "")[:200]
        r["ts"] = r["ts"].isoformat()
        p = by_page.setdefault(r["page_id"], {"page_id": r["page_id"], "title": r["title"], "n": 0,
                                              "delta": 0, "reverts": 0, "users": set()})
        p["n"] += 1
        p["delta"] += r["delta"] or 0
        p["reverts"] += r["is_revert"] or 0
        p["users"].add(r["user"])
        p["title"] = r["title"]
        u = by_user.setdefault(r["user"], {"user": r["user"], "n": 0, "kind": r["kind"]})
        u["n"] += 1
    pages = sorted(by_page.values(), key=lambda p: (-p["n"], p["title"]))
    for p in pages:
        p["users"] = len(p["users"])
    users = sorted(by_user.values(), key=lambda u: (-u["n"], u["user"] or ""))
    show = sql.replace("%s", f"'{s:%Y-%m-%d %H:%M:%S}'", 1).replace("%s", f"'{e:%Y-%m-%d %H:%M:%S}'", 1)
    out = {"date": d.isoformat(), "filter": f, "utc_from": s.isoformat(), "utc_to": e.isoformat(),
           "total": len(edits), "hours": hours, "reverts": sum(r["is_revert"] or 0 for r in edits),
           "pages": pages[:60], "users": users[:12], "nusers": len(users),
           "npages": len(pages), "edits": edits[:300], "ms": round(ms, 1), "sql": show}
    # The most-edited article that day, before and after, from the system-versioned table.
    out["asof"] = _asof(pages[0]["page_id"], s, e) if pages else None
    return out


def _paras(text):
    return [html.unescape(t) for k, t in clean(text or "") if k in ("p", "li") and len(t) > 30]


def _word_diff(a, b, keep=8):
    """Word-level diff of two paragraphs -> [[op, text]], op '=' / '+' / '-'; long unchanged runs elided."""
    wa, wb = a.split(), b.split()
    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, wa, wb, autojunk=False).get_opcodes():
        if op == "equal":
            run = wa[i1:i2]
            if len(run) > 2 * keep + 2:
                first = not out
                last = i2 == len(wa)
                head = [] if first else run[:keep]
                tail = [] if last else run[-keep:]
                out += [["=", " ".join(x)] for x in (head,) if x] + [["…", ""]] + [["=", " ".join(x)] for x in (tail,) if x]
            else:
                out.append(["=", " ".join(run)])
        else:
            if i2 > i1:
                out.append(["-", " ".join(wa[i1:i2])])
            if j2 > j1:
                out.append(["+", " ".join(wb[j1:j2])])
    return out


def _changes(before, after, limit=4):
    """Paragraphs new/gone between two versions; a rewritten paragraph is paired with its old form."""
    bset, aset = set(before), set(after)
    added = [p for p in after if p not in bset]
    removed = [p for p in before if p not in aset]
    pool, out = list(removed), []
    for p in added:
        best, br = None, 0.5
        for q in pool:
            sm = difflib.SequenceMatcher(None, q.split(), p.split(), autojunk=False)
            if sm.real_quick_ratio() > br and sm.quick_ratio() > br and sm.ratio() > br:
                best, br = q, sm.ratio()
        if best is not None:
            pool.remove(best)
            out.append({"type": "edit", "diff": _word_diff(best, p)})
        else:
            out.append({"type": "add", "text": p[:420]})
    out += [{"type": "del", "text": q[:300]} for q in pool]
    n_edit = sum(c["type"] == "edit" for c in out)
    return out[:limit], {"edited": n_edit, "added": len(added) - n_edit, "removed": len(pool)}


@functools.lru_cache(maxsize=256)
def _asof(page_id, s, e):
    sql = ASOF_SQL.replace("%s", f"'{e - dt.timedelta(microseconds=1):%Y-%m-%d %H:%M:%S.%f}'", 1) \
        .replace("%s", str(page_id), 1)
    if not rows("SELECT 1 FROM article FOR SYSTEM_TIME ALL WHERE page_id=%s LIMIT 1", (page_id,)):
        return {"page_id": page_id, "has_text": False, "sql": sql}
    t0 = time.perf_counter()
    before = rows(ASOF_SQL, (s - dt.timedelta(microseconds=1), page_id))
    after = rows(ASOF_SQL, (e - dt.timedelta(microseconds=1), page_id))
    ms = (time.perf_counter() - t0) * 1000
    if not after:
        return {"page_id": page_id, "has_text": False, "sql": sql}
    a = after[0]
    b = before[0] if before else None
    pa, pb = _paras(a["text"]), _paras(b["text"]) if b else []
    changes, counts = _changes(pb, pa)
    return {"page_id": page_id, "has_text": True, "ms": round(ms, 1), "sql": sql,
            "before": {"rev_id": b["rev_id"], "len": b["len"]} if b else None,
            "after": {"rev_id": a["rev_id"], "len": a["len"]},
            "changes": changes, "counts": counts,
            "lead": pa[0][:420] if pa else ""}
