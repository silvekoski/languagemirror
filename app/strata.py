"""Knowledge Strata: an article's text as geological layers.

For one article we stream every stored version (FOR SYSTEM_TIME ALL), split ~120 sampled versions into
sentences and trace each sentence back to the edit that first wrote it. Exact or near-identical
wording keeps its original age, so the article reads like rock: text deposited in 2006 is still
2006 sediment in 2026 unless an editor erodes it. The per-article result is cached in viz_strata_*
(built lazily on the first request, or ahead of time by scripts/build_strata.py).

API (mounted at /api/strata/):
  GET articles?q=           picker: the 50 famous articles first, then by number of versions
  GET strata/<page_id>      layers + stats; 202 {"building": progress} while the build runs
  GET asof/<page_id>?t=...  the article AS OF t (FOR SYSTEM_TIME AS OF), each sentence with its origin
"""
import bisect, difflib, functools, hashlib, html, json, re, threading, time, types, zlib
from datetime import datetime, timezone

import pymysql
from flask import Blueprint, jsonify, request

from app.db import rows
from wikitime import wikitext
from wikitime.db import connect

bp = Blueprint("strata", __name__)

MAX_SAMPLES = 120
GRID_SAMPLES = 92          # evenly spaced in time; the rest go to the biggest lasting size changes
MIN_LIFE_S = 6 * 3600      # a "lasting" version survived at least 6 h (skips vandalism + its revert)
FAMOUS_DEFAULT = 1256      # Talvisota
VERSION = 6                # bump to invalidate cached builds

# ---------------------------------------------------------------- text -> sentences

def _drop_nested_fast(text, start, end):
    """Same result as wikitext._drop_nested (char-by-char scan), but jumps with str.find."""
    out, depth, i, n, ls, le = [], 0, 0, len(text), len(start), len(end)
    while i < n:
        if not depth:
            j = text.find(start, i)
            if j < 0:
                out.append(text[i:])
                break
            out.append(text[i:j]); depth = 1; i = j + ls
        else:
            js, je = text.find(start, i), text.find(end, i)
            if je < 0 and js < 0:
                break
            if js >= 0 and (je < 0 or js < je):
                depth += 1; i = js + ls
            else:
                depth -= 1; i = je + le
    return "".join(out)


# wikitext.clean, unchanged, but with the fast scanner (≈10x faster on 100 kB articles)
clean = types.FunctionType(wikitext.clean.__code__, {**vars(wikitext), "_drop_nested": _drop_nested_fast}, "clean")

_CAND = re.compile(r"[.!?…][\"»”’)\]]*\s+(?=[\"«„“(\[]?[A-ZÅÄÖÜ0-9])")
_ABBR = {"mm", "esim", "ns", "n", "ym", "yms", "jne", "tms", "vrt", "ks", "kts", "engl", "ruots", "ven", "lat",
         "saks", "ransk", "eKr", "jKr", "Kr", "eaa", "jaa", "prof", "tri", "kpl", "s", "v", "k", "synt", "o.s",
         "t", "nk", "nyk", "esim", "huom", "St", "Mr", "Dr", "vol", "nro", "no", "ts", "eli", "evp", "ent", "kok", "mr", "kenr", "ev"}
_WORD = re.compile(r"\w+")


def split_sentences(text):
    out, start = [], 0
    for m in _CAND.finditer(text):
        p = m.start()
        if text[p] == ".":
            k = max(start - 1, text.rfind(" ", start, p), text.rfind("(", start, p))
            word = text[k + 1:p].lstrip("\"«„“(")
            if (len(word) == 1 and word.isalpha()) or word in _ABBR or word.lower() in _ABBR \
                    or (word.isdigit() and len(word) <= 2) or re.fullmatch(r"(\w\.)+\w", word):
                continue
        s = text[start:m.end()].strip()
        if s:
            out.append(s)
        start = m.end()
    s = text[start:].strip()
    if s:
        out.append(s)
    return out


def norm(s):
    return " ".join(_WORD.findall(s.lower()))


def skey(n):
    return int.from_bytes(hashlib.blake2b(n.encode(), digest_size=8).digest(), "big", signed=True)


def units(raw):
    """Wikitext -> list of blocks [kind, [(sentence, norm, key), ...]]."""
    out = []
    for kind, text in clean(raw):
        text = html.unescape(text).replace("\xa0", " ")
        parts = [text] if kind == "h" else split_sentences(text)
        us = []
        for s in parts:
            n = norm(s)
            if n:
                us.append((s, n, skey(n)))
        if us:
            out.append((kind, us))
    return out


def _probe(sentence, raw):
    """Longest run of the sentence's words (>= 18 chars) that occurs verbatim in the raw wikitext."""
    if len(sentence) >= 18 and sentence in raw:
        return sentence
    words = sentence.split(" ")
    best = None
    for i in range(0, min(len(words), 24), 2):
        for j in range(min(len(words), i + 12), i, -1):
            cand = " ".join(words[i:j])
            if len(cand) < 18 or (best and len(cand) <= len(best)):
                break
            if cand in raw:
                best = cand
                break
    return best


def _ts(dt):
    return dt.replace(tzinfo=timezone.utc).timestamp()


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def is_bot(user):
    return bool(user) and user.lower().endswith("bot")

# ---------------------------------------------------------------- tables

DDL = [
    """CREATE TABLE IF NOT EXISTS viz_strata_article (
         page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255), last_rev INT UNSIGNED, version SMALLINT,
         built_at DATETIME, build_ms INT, payload MEDIUMBLOB) ENGINE=InnoDB""",
    """CREATE TABLE IF NOT EXISTS viz_strata_sentence (
         page_id INT UNSIGNED NOT NULL, skey BIGINT NOT NULL, oid SMALLINT UNSIGNED NOT NULL,
         PRIMARY KEY (page_id, skey)) ENGINE=InnoDB""",
    """CREATE TABLE IF NOT EXISTS viz_strata_index (
         page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255), versions INT, famous SMALLINT,
         KEY famous (famous, versions)) ENGINE=InnoDB""",
]


@functools.lru_cache(maxsize=1)
def ensure_tables():
    con = connect()
    try:
        with con.cursor() as cur:
            for d in DDL:
                cur.execute(d)
        con.commit()
    finally:
        con.close()
    return True

# ---------------------------------------------------------------- build

META_SQL = """SELECT rev_id, title, user, anonymous, comment, len, sha1, row_start, row_end
FROM article FOR SYSTEM_TIME ALL WHERE page_id = %s ORDER BY row_start"""
TEXT_SQL = "SELECT rev_id, text FROM article FOR SYSTEM_TIME ALL WHERE page_id = %s ORDER BY row_start"


def pick_samples(meta):
    n = len(meta)
    starts = [_ts(m["row_start"]) for m in meta]
    life = [starts[i + 1] - starts[i] for i in range(n - 1)] + [1e12]
    if n <= MAX_SAMPLES:
        return list(range(n)), life
    t0, t1 = starts[0], starts[-1]
    chosen = {0, n - 1}
    for g in range(GRID_SAMPLES):
        t = t0 + (t1 - t0) * g / (GRID_SAMPLES - 1)
        chosen.add(max(0, bisect.bisect_right(starts, t) - 1))
    changes = sorted(((abs((meta[i]["len"] or 0) - (meta[i - 1]["len"] or 0)), i) for i in range(1, n)
                      if life[i] >= MIN_LIFE_S), reverse=True)
    for _, i in changes:
        if len(chosen) >= MAX_SAMPLES:
            break
        chosen.add(i)
        if len(chosen) < MAX_SAMPLES and life[i - 1] >= MIN_LIFE_S:
            chosen.add(i - 1)
    return sorted(chosen), life


def _first_with(p, seq, lasting, life):
    """Index of the version that introduced probe p, searching the versions between two samples.
    Binary search over the lasting versions (presence is assumed to persist once written, so a vandal's
    short-lived blanking doesn't hide the real author), then step back over short-lived versions that
    already contain it (an author's version that was typo-fixed minutes later)."""
    lo, hi = 0, len(lasting) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if p in seq[lasting[mid]][1]:
            hi = mid
        else:
            lo = mid + 1
    q = lasting[lo]
    while q > 0 and life[seq[q - 1][0]] < MIN_LIFE_S and p in seq[q - 1][1]:
        q -= 1
    return seq[q][0]


PROGRESS = {}
_LOCKS = {}
_LOCKS_GUARD = threading.Lock()


def build(page_id, log=None):
    """Compute the strata of one article and store them in viz_strata_*. Returns the payload."""
    ensure_tables()
    t_start = time.perf_counter()
    prog = PROGRESS.setdefault(page_id, {})
    prog.update(phase="listing versions", done=0, total=0)
    meta = rows(META_SQL, (page_id,))
    if not meta:
        raise LookupError("no text history for this article")
    n = len(meta)
    sample_idx, life = pick_samples(meta)
    is_sample = set(sample_idx)
    pos = {m["rev_id"]: i for i, m in enumerate(meta)}
    # a version is "undone" when one of the next versions (within a week) restores its parent's exact text
    undone = [False] * n
    for i in range(1, n):
        t0, parent = _ts(meta[i]["row_start"]), meta[i - 1]["sha1"]
        for j in range(i + 1, min(n, i + 11)):
            if _ts(meta[j]["row_start"]) - t0 > 7 * 86400:
                break
            if parent and meta[j]["sha1"] == parent:
                undone[i] = True
                break
    prog.update(phase="reading versions", total=n)

    origins, oid_of = [], {}           # origin records; key -> oid
    origin_by_rev = {}                 # (rev index, exact) -> oid
    first_text = {}                    # key -> sentence text when first seen (for oldest-sentence stat)
    deposited = {}                     # key -> chars (first wording) for survival stats

    def origin_for(i, exact, lo=None):
        k = (i, exact)
        if k not in origin_by_rev:
            m = meta[i]
            origin_by_rev[k] = len(origins)
            origins.append({"t": _iso(m["row_start"]), "rev": m["rev_id"], "user": m["user"] or "",
                            "anon": int(m["anonymous"]), "bot": int(is_bot(m["user"])), "exact": int(exact),
                            "lo": _iso(meta[lo]["row_start"]) if lo is not None else None,
                            "comment": (m["comment"] or "")[:160]})
        return origin_by_rev[k]

    samples, erosions = [], []
    prev = None                        # (index, raw, units, total chars)
    buffer = []                        # (index, raw) of versions after the previous sample
    try:
        con = connect(cursorclass=pymysql.cursors.SSCursor, ssl_disabled=True)   # local socket, skip TLS cost
    except Exception:
        con = connect(cursorclass=pymysql.cursors.SSCursor)
    try:
        cur = con.cursor()
        cur.execute(TEXT_SQL, (page_id,))
        done = 0
        for rev_id, raw in cur:
            done += 1
            if done % 25 == 0:
                prog["done"] = done
            i = pos.get(rev_id)
            if i is None:
                continue
            if i not in is_sample:
                buffer.append((i, raw))
                continue
            us = units(raw)
            flat = [u for _, b in us for u in b]
            if prev is None:
                for s, nk, k in flat:
                    if k not in oid_of:
                        oid_of[k] = origin_for(i, True)
                        first_text[k], deposited[k] = s, len(s)
            else:
                pi, praw, pus = prev[0], prev[1], prev[2]
                cur_keys = {k for _, _, k in flat}
                removed = [(s, nk, k) for _, b in pus for s, nk, k in b if k not in cur_keys]
                removed_sets = [({w for w in nk.split() if len(w) >= 5}, nk, k) for _, nk, k in removed]
                inv = {}
                for ri, (ws, _, _) in enumerate(removed_sets):
                    for w in ws:
                        inv.setdefault(w, []).append(ri)
                seq = buffer + [(i, raw)]
                lasting = [q for q, (bi, _) in enumerate(seq) if life[bi] >= MIN_LIFE_S or q == len(seq) - 1]
                for s, nk, k in flat:
                    if k in oid_of:
                        continue
                    # 1) near-identical rewording of a sentence that just disappeared -> keeps its age
                    words = {w for w in nk.split() if len(w) >= 5}
                    best, best_r = None, 0.0
                    shared = {}
                    for w in words:
                        for ri in inv.get(w, ()):
                            shared[ri] = shared.get(ri, 0) + 1
                    for ri, c in shared.items():
                        ws, rn, rk = removed_sets[ri]
                        if c / (len(words) + len(ws) - c) < 0.5:
                            continue
                        sm = difflib.SequenceMatcher(None, nk, rn, autojunk=False)
                        if sm.real_quick_ratio() < 0.85 or sm.quick_ratio() < 0.85:
                            continue
                        r = sm.ratio()
                        if r > best_r:
                            best, best_r = rk, r
                    if best is not None and best_r >= 0.85:
                        oid_of[k] = oid_of[best]
                        continue
                    # 2) find the edit that wrote it: walk back through the unsampled versions
                    p = _probe(s, raw)
                    if p is not None and p in praw:
                        old = next((pk for _, b in pus for ps, pn, pk in b if p in ps), None)
                        if old is not None:      # re-split / re-formatted older text
                            oid_of[k] = oid_of[old]
                            continue
                    if p is None:     # exact only when no unsampled version lies in between
                        oid_of[k] = origin_for(i, not buffer, pi if buffer else None)
                    else:
                        oid_of[k] = origin_for(_first_with(p, seq, lasting, life), True)
                    first_text[k], deposited[k] = s, len(s)
            total = sum(len(s) for s, _, _ in flat)
            # erosion: a big loss since the last sample -> find the lasting edit that removed the most
            if prev is not None and prev[3] - total > max(400, 0.04 * prev[3]):
                cands = [(bi, braw) for bi, braw in buffer + [(i, raw)] if not undone[bi]]
                lens = {bi: len(braw) for bi, braw in cands}
                lens[prev[0]] = len(prev[1])
                worst = min(cands, key=lambda c: lens[c[0]] - lens.get(c[0] - 1, lens[c[0]])) if cands else None
                wi = worst[0] if worst else None
                before = None if wi is None else \
                    next((braw for bi, braw in [(prev[0], prev[1])] + buffer if bi == wi - 1), None)
                if before is not None:
                    lost = sum(len(s) for _, b in units(before) for s, _, _ in b) - \
                        sum(len(s) for _, b in units(worst[1]) for s, _, _ in b)
                    if lost > 0:
                        m = meta[wi]
                        erosions.append({"t": _iso(m["row_start"]), "rev": m["rev_id"], "user": m["user"] or "",
                                         "anon": int(m["anonymous"]), "lost": lost,
                                         "comment": (m["comment"] or "")[:160]})
            by_year = {}
            for s, _, k in flat:
                y = origins[oid_of[k]]["t"][:4]
                by_year[y] = by_year.get(y, 0) + len(s)
            m = meta[i]
            samples.append({"t": _iso(m["row_start"]), "rev": m["rev_id"], "user": m["user"] or "",
                            "chars": total, "n": len(flat), "y": by_year})
            prev = (i, raw, us, total)
            buffer = []
        prog["done"] = n
    finally:
        con.close()

    prog.update(phase="saving")
    last_units = [u for _, b in prev[2] for u in b]
    today_total = sum(len(s) for s, _, _ in last_units) or 1
    today_year, surv, by_user, by_kind = {}, {}, {}, {"registered": 0, "anonymous": 0, "bot": 0}
    seen = set()
    for s, _, k in last_units:
        o = origins[oid_of[k]]
        y = o["t"][:4]
        today_year[y] = today_year.get(y, 0) + len(s)
        if k not in seen:
            seen.add(k)
            surv[y] = surv.get(y, 0) + deposited.get(k, len(s))
        if o["exact"]:
            by_user[o["user"]] = by_user.get(o["user"], 0) + len(s)
        kind = "bot" if o["bot"] else "anonymous" if o["anon"] else "registered"
        by_kind[kind] += len(s)
    dep_year = {}
    for k, c in deposited.items():
        y = origins[oid_of[k]]["t"][:4]
        dep_year[y] = dep_year.get(y, 0) + c
    # the oldest sentences still standing (skip headings and very short bits)
    today_keys = {k: s for s, _, k in last_units if len(s) >= 40}
    oldest = sorted(today_keys, key=lambda k: (origins[oid_of[k]]["t"], -len(today_keys[k])))[:3]
    # biggest deposits: the edits that wrote the most text (distinct sentences, first wording)
    dep_by_oid = {}
    for k, c in deposited.items():
        dep_by_oid[oid_of[k]] = dep_by_oid.get(oid_of[k], 0) + c
    surv_by_oid = {}
    for s, _, k in last_units:
        surv_by_oid[oid_of[k]] = surv_by_oid.get(oid_of[k], 0) + len(s)
    deposits = [{"oid": o, "chars": c, "surviving": surv_by_oid.get(o, 0)}
                for o, c in sorted(dep_by_oid.items(), key=lambda x: -x[1]) if origins[o]["exact"]][:5]
    last = meta[-1]
    payload = {
        "page_id": page_id, "title": last["title"], "versions": n, "first": _iso(meta[0]["row_start"]),
        "last": _iso(last["row_start"]), "last_rev": last["rev_id"],
        "samples": samples, "origins": origins,
        "today": {"chars": today_total, "sentences": len(last_units), "by_year": today_year,
                  "by_kind": by_kind, "editors": len({origins[oid_of[k]]["user"] for _, _, k in last_units if origins[oid_of[k]]["exact"]}),
                  "top_users": sorted(by_user.items(), key=lambda x: -x[1])[:8]},
        "deposited_by_year": dep_year, "surviving_by_year": surv,
        "sentences_traced": len(oid_of), "untraced_origins": sum(1 for o in origins if not o["exact"]),
        "oldest": [{"text": today_keys[k], "oid": oid_of[k]} for k in oldest],
        "deposits": deposits, "erosions": sorted(erosions, key=lambda e: -e["lost"])[:5],
        "build_ms": 0,
    }
    payload["build_ms"] = int((time.perf_counter() - t_start) * 1000)
    blob = zlib.compress(json.dumps(payload, separators=(",", ":")).encode(), 6)
    con = connect()
    try:
        with con.cursor() as cur:
            cur.execute("DELETE FROM viz_strata_sentence WHERE page_id=%s", (page_id,))
            items = list(oid_of.items())
            for a in range(0, len(items), 2000):
                cur.executemany("INSERT INTO viz_strata_sentence (page_id, skey, oid) VALUES (%s,%s,%s)",
                                [(page_id, k, o) for k, o in items[a:a + 2000]])
            cur.execute("""REPLACE INTO viz_strata_article (page_id, title, last_rev, version, built_at, build_ms, payload)
                           VALUES (%s,%s,%s,%s,UTC_TIMESTAMP(),%s,%s)""",
                        (page_id, last["title"], last["rev_id"], VERSION, payload["build_ms"], blob))
        con.commit()
    finally:
        con.close()
    prog.update(phase="done")
    if log:
        log(f"{page_id} {last['title']}: {n} versions, {len(samples)} samples, {len(oid_of)} sentences, "
            f"{payload['build_ms']} ms")
    return payload


def _lock(page_id):
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(page_id, threading.Lock())


def _build_bg(page_id):
    lk = _lock(page_id)
    if not lk.acquire(blocking=False):
        return
    try:
        build(page_id)
    except Exception as e:  # surfaced through /strata/<id>
        PROGRESS.setdefault(page_id, {}).update(phase="error", error=str(e))
    finally:
        lk.release()

# ---------------------------------------------------------------- cache readers


def _stamp(page_id):
    """(last_rev, built_at) of the current cached build, or None. A cheap primary-key lookup, so a build made by
    another process (scripts/build_strata.py) is picked up and payload + sentence map always match."""
    r = rows("SELECT last_rev, version, built_at FROM viz_strata_article WHERE page_id=%s", (page_id,))
    if not r or r[0]["version"] != VERSION:
        return None
    return r[0]["last_rev"], r[0]["built_at"]


@functools.lru_cache(maxsize=16)
def _payload(page_id, built_at):
    r = rows("SELECT payload FROM viz_strata_article WHERE page_id=%s", (page_id,))
    return json.loads(zlib.decompress(r[0]["payload"]))


@functools.lru_cache(maxsize=8)
def _smap(page_id, built_at):
    return {r["skey"]: r["oid"] for r in rows("SELECT skey, oid FROM viz_strata_sentence WHERE page_id=%s", (page_id,))}


def load_payload(page_id):
    st = _stamp(page_id)
    return (st[0], _payload(page_id, st[1])) if st else None


def sentence_map(page_id):
    st = _stamp(page_id)
    return _smap(page_id, st[1]) if st else {}


def current_rev(page_id):
    r = rows("SELECT rev_id FROM article WHERE page_id=%s", (page_id,))
    return r[0]["rev_id"] if r else None

# ---------------------------------------------------------------- API


@bp.get("/strata/<int:page_id>")
def strata(page_id):
    ensure_tables()
    cached = load_payload(page_id)
    cur = current_rev(page_id)
    if cur is None:
        return jsonify(error="This article has no stored text history (yet)."), 404
    if cached and cached[0] == cur:
        return jsonify(cached[1])
    p = PROGRESS.get(page_id, {})
    if p.get("phase") == "error" and request.args.get("retry") != "1":
        return jsonify(error=p.get("error"), hint="add ?retry=1 to build again"), 503
    if not _lock(page_id).locked():
        PROGRESS[page_id] = {"phase": "starting", "done": 0, "total": 0}
        threading.Thread(target=_build_bg, args=(page_id,), daemon=True).start()
    t = rows("SELECT title FROM article WHERE page_id=%s", (page_id,))
    return jsonify(building=PROGRESS.get(page_id, {}), title=t[0]["title"] if t else ""), 202


ASOF_SQL = """SELECT rev_id, title, user, anonymous, comment, len, text, row_start, row_end
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s
LIMIT 1"""


@bp.get("/asof/<int:page_id>")
def asof(page_id):
    t = request.args.get("t", "")
    when = None
    if t:
        s = t.replace("T", " ").rstrip("Z")[:19]
        for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y-%m", "%Y"):
            try:
                when = datetime.strptime(s, f)
                break
            except ValueError:
                pass
        if when is None:
            return jsonify(error="t must be YYYY-MM-DDTHH:MM:SS (or a date)"), 400
    if when is None:
        when = datetime.now(timezone.utc).replace(tzinfo=None)
    ts = when.strftime("%Y-%m-%d %H:%M:%S")
    q0 = time.perf_counter()
    r = rows(ASOF_SQL, (ts, page_id))
    ms = (time.perf_counter() - q0) * 1000
    sql = ASOF_SQL.replace("%s", f"'{ts}'", 1).replace("%s", str(page_id))
    if not r:
        msg = "The article did not exist yet at that moment." if current_rev(page_id) else \
            "This article has no stored text history (yet)."
        return jsonify(error=msg, sql=sql, ms=round(ms, 1)), 404
    v = r[0]
    smap = sentence_map(page_id)
    blocks = []
    for kind, us in units(v["text"]):
        blocks.append({"k": kind, "s": [[s, smap.get(k, -1)] for s, _, k in us]})
    return jsonify(rev=v["rev_id"], title=v["title"], user=v["user"], anon=v["anonymous"], comment=v["comment"],
                   len=v["len"], start=_iso(v["row_start"]),
                   end=None if v["row_end"].year >= 2038 else _iso(v["row_end"]),
                   blocks=blocks, sql=sql, ms=round(ms, 1))


FAMOUS_SQL = "SELECT page_id, title, versions, famous FROM viz_strata_index"


@functools.lru_cache(maxsize=1)
def _index():
    try:
        r = rows(FAMOUS_SQL)
    except pymysql.err.ProgrammingError:
        r = []
    if not r:  # not prebuilt yet: the stored articles, without version counts
        r = [dict(x, versions=None, famous=None) for x in rows("SELECT page_id, title FROM article")]
    r.sort(key=lambda x: (x["famous"] is None, -(x["versions"] or 0)))
    return r


@bp.get("/articles")
def articles():
    ensure_tables()
    q = request.args.get("q", "").strip().lower()
    idx = _index()
    if q:
        hits = [x for x in idx if q in x["title"].lower()]
        hits.sort(key=lambda x: (not x["title"].lower().startswith(q), x["famous"] is None, -(x["versions"] or 0)))
        return jsonify(hits[:40])
    return jsonify(idx[:80])
