"""Kielipeili engine: load any Wikipedia article in its longest language editions, score every edition against
the consensus of all editions (not against one "reference" language), and check the cited sources where
editions disagree.

Score of an edition (shown on the page with every number):
  coverage  = share of the consensus facts it tells. A consensus fact is a cluster of paragraphs that at least
              k = min(3, editions) editions tell (paragraphs linked by mutual nearest-neighbour bge-m3 matches
              with cosine >= TAU, computed in MariaDB with VEC_DISTANCE_COSINE).
  agreement = share of the checked conflicts where this edition's claim is backed by its cited source, or, when no
              source settles it, where it sides with the largest group of editions.
  sourcing  = share of its text that sits in paragraphs carrying at least one citation.
  index     = 0.5 * coverage + 0.3 * agreement + 0.2 * sourcing
"""
import json, re, subprocess, threading, time, traceback, urllib.parse, uuid
from concurrent.futures import ThreadPoolExecutor

import requests

from app import kielipeili as K
from wikitime import lenswiki as W
from wikitime.db import connect

EMBED_URL = "http://127.0.0.1:8766/embed"
MODEL = "claude-opus-5-5"          # batch scripts (lens_analyze); the live loader uses LIVE_MODEL
LIVE_MODEL = "claude-sonnet-5-5"    # about twice as fast for the conflict and source passes of an on-demand load
WEIGHTS = {"coverage": 0.5, "agreement": 0.3, "sourcing": 0.2}
N_EDITIONS = 6
COPY_SIM, COPY_SHARE = 0.80, 50

JOBS = {}            # job id -> {"state", "step", "done", "total", "topic", "error", "log": [...]}
_LOCK = threading.Lock()


# ---------- database ----------
def q(sql, args=(), many=False):
    con = connect()
    try:
        with con.cursor() as cur:
            (cur.executemany if many else cur.execute)(sql, args)
            rows = cur.fetchall() if cur.description else []
            cols = [d[0] for d in cur.description] if cur.description else []
        con.commit()
        return [dict(zip(cols, r)) for r in rows]
    finally:
        con.close()


def ensure_tables():
    q("""CREATE TABLE IF NOT EXISTS lens_ref (topic VARCHAR(100) NOT NULL, lang VARCHAR(12) NOT NULL, sha1 CHAR(40) NOT NULL,
         refs JSON NOT NULL, PRIMARY KEY (topic, lang, sha1))""")
    q("""CREATE TABLE IF NOT EXISTS lens_edition (topic VARCHAR(100) NOT NULL, lang VARCHAR(12) NOT NULL, title VARCHAR(255),
         prose_chars INT, picked BOOL, PRIMARY KEY (topic, lang))""")
    q("""CREATE TABLE IF NOT EXISTS lens_consensus (topic VARCHAR(100) PRIMARY KEY, result JSON NOT NULL,
         created TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
    q("""CREATE TABLE IF NOT EXISTS lens_factcheck (topic VARCHAR(100) PRIMARY KEY, result JSON NOT NULL,
         created TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")


def topic_langs(topic):
    return [r["lang"] for r in q("SELECT DISTINCT lang FROM lens_chunk WHERE topic = %s ORDER BY lang", (topic,))]


# ---------- jobs ----------
def start_job(kind, fn, *args):
    jid = uuid.uuid4().hex[:10]
    JOBS[jid] = {"id": jid, "kind": kind, "state": "running", "step": "starting", "done": 0, "total": 0,
                 "topic": None, "error": None, "started": time.time()}

    def run():
        try:
            fn(JOBS[jid], *args)
            JOBS[jid]["state"] = "done"
        except Exception as e:  # noqa: BLE001 - surfaced to the page
            JOBS[jid].update(state="error", error=str(e)[:400])
            traceback.print_exc()
    threading.Thread(target=run, daemon=True).start()
    return jid


def step(job, text, done=0, total=0):
    if job is None:
        return
    job.update(step=text, done=done, total=total)
    print(f"[lens job {job['id']}] {text} {done}/{total}", flush=True)


# ---------- loading an article ----------
def embed(texts, job=None):
    out = []
    if job:
        step(job, "Embedding paragraphs with bge-m3", 0, len(texts))   # show the stage at once, not after the first batch
    for i in range(0, len(texts), 24):
        r = requests.post(EMBED_URL, json={"texts": texts[i:i + 24]}, timeout=900)
        r.raise_for_status()
        out += r.json()["vectors"]
        if job:
            step(job, "Embedding paragraphs with bge-m3", len(out), len(texts))
    return out


def load_article(job, text, n=N_EDITIONS, default_lang="en"):
    ensure_tables()
    lang, title = W.parse_input(text, default_lang)
    step(job, f"Finding every language edition of “{title}” on Wikidata")
    item = W.resolve(lang, title)
    if not item or not item["titles"]:
        raise ValueError(f"No Wikipedia article “{title}” in {lang}")
    topic = item["label"][:100]
    job["topic"] = topic
    if q("SELECT 1 FROM lens_topic WHERE topic = %s", (topic,)) and q("SELECT 1 FROM lens_chunk WHERE topic = %s LIMIT 1", (topic,)):
        step(job, "Already loaded")
        if not q("SELECT 1 FROM lens_consensus WHERE topic = %s", (topic,)) or not q("SELECT 1 FROM lens_factcheck WHERE topic = %s", (topic,)):
            score_topic(job, topic)        # an interrupted load: finish the scores and the disagreement check
        return
    step(job, f"Measuring all {len(item['titles'])} editions (prose length)", 0, len(item["titles"]))
    pages = measure(job, item["titles"])
    ranked = sorted(pages.values(), key=lambda r: -r["prose"])
    ranked = [r for r in ranked if len(r["lang"]) <= 3]          # lens_* lang columns are CHAR(3)
    picked = [r for r in ranked[:n] if r["prose"] > 500]
    q("DELETE FROM lens_edition WHERE topic = %s", (topic,))
    q("INSERT INTO lens_edition VALUES (%s,%s,%s,%s,%s)",
      [(topic, r["lang"], r["title"], r["prose"], r in picked) for r in ranked], many=True)

    store(job, topic, item["qid"], picked)
    score_topic(job, topic, check=False)
    fill_independent(job, topic, n, pages)
    score_topic(job, topic)


def measure(job, titles):
    """Fetch every edition (with retries) and measure its prose length."""
    step(job, f"Measuring all {len(titles)} editions (prose length)", 0, len(titles))
    got = W.fetch_many(titles)
    for r in got.values():
        r["chunks"] = W.chunks(r["wikitext"])
        r["prose"] = sum(len(c[1]) for c in r["chunks"])
    step(job, f"Measured {len(got)} of {len(titles)} editions", len(got), len(titles))
    return got


def redundant(topic):
    """Editions that are near-copies of a longer edition that is itself kept."""
    res = q("SELECT result FROM lens_consensus WHERE topic = %s", (topic,))
    if not res:
        return set()
    r = json.loads(res[0]["result"])
    size = {p["lang"]: p["chars"] for p in r["langs"]}
    copies = {}
    for c in r.get("copies", []):
        copies.setdefault(c["a"], set()).add(c["b"]); copies.setdefault(c["b"], set()).add(c["a"])
    kept, red = [], set()
    for l in sorted(size, key=lambda l: -size[l]):
        if any(o in kept for o in copies.get(l, ())):
            red.add(l)
        else:
            kept.append(l)
    return red


def fill_independent(job, topic, n, pages, cap=9):
    """Copies do not take a slot: add the next-longest editions until n independent ones (at most cap in total)."""
    for _ in range(3):
        have = set(topic_langs(topic))
        indep = len(have) - len(redundant(topic))
        need = min(n - indep, cap - len(have))
        cand = [r for r in sorted(pages.values(), key=lambda r: -r["prose"])
                if r["lang"] not in have and len(r["lang"]) <= 3 and r["prose"] > 2000][:max(need, 0)]
        if not cand:
            return
        step(job, "Copies do not count: adding " + ", ".join(r["lang"] for r in cand))
        store(job, topic, None, cand)
        score_topic(job, topic, check=False)


def add_editions(job, topic, langs):
    """Add language editions to a loaded article by hand (the page's '+' chips), then score again."""
    titles = {r["lang"]: r["title"] for r in q("SELECT lang, title FROM lens_edition WHERE topic = %s", (topic,)) if r["lang"] in langs}
    job["topic"] = topic
    pages = measure(job, titles)
    store(job, topic, None, [p for p in pages.values() if p["prose"] > 0])
    score_topic(job, topic)


def store(job, topic, qid, picked):
    """Embed and insert the paragraphs of the given editions (current versions, Wikipedia's real save times)."""
    rows = [(r, sec, txt, refs) for r in picked for sec, txt, refs in r["chunks"]]
    vecs = embed([t for _, _, t, _ in rows], job)
    step(job, "Storing paragraphs in MariaDB (system-versioned, vector index)")
    con = connect(); cur = con.cursor()
    cur.execute("SELECT COALESCE(MAX(id), 0) FROM lens_chunk FOR SYSTEM_TIME ALL")
    nid = cur.fetchone()[0]
    cur.execute("SET system_versioning_insert_history = 1")
    import numpy as np
    ords = {}
    for (r, sec, txt, refs), v in zip(rows, vecs):
        nid += 1
        o = ords.get(r["lang"], 0); ords[r["lang"]] = o + 1
        cur.execute("""INSERT INTO lens_chunk (id, topic, lang, ord, section, text, chars, sha1, rev_id, emb, row_start)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (nid, topic, r["lang"], o, sec, txt, len(txt), W.sha(txt), r["rev_id"],
                     np.asarray(v, dtype="<f4").tobytes(), r["ts"]))
        if refs:
            cur.execute("REPLACE INTO lens_ref VALUES (%s,%s,%s,%s)", (topic, r["lang"], W.sha(txt), json.dumps(refs, ensure_ascii=False)))
    for r in picked:
        cur.execute("REPLACE INTO lens_snapshot VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                    (topic, r["lang"], r["ts"], r["rev_id"], r["title"], r["prose"], len(r["chunks"]), True))
        cur.execute("UPDATE lens_edition SET picked = 1, prose_chars = %s WHERE topic = %s AND lang = %s", (r["prose"], topic, r["lang"]))
    cur.execute("SELECT titles, wikidata FROM lens_topic WHERE topic = %s", (topic,))
    old = cur.fetchone()
    titles = json.loads(old[0]) if old else {}
    titles.update({r["lang"]: r["title"] for r in picked})
    cur.execute("REPLACE INTO lens_topic VALUES (%s,%s,%s)", (topic, qid or (old[1] if old else None), json.dumps(titles, ensure_ascii=False)))
    con.commit(); con.close()


def refresh_editions(job, topic, n=N_EDITIONS):
    """Re-measure every edition of an already loaded article (e.g. after fetch failures), then fill independent slots."""
    qid = (q("SELECT wikidata FROM lens_topic WHERE topic = %s", (topic,)) or [{}])[0].get("wikidata")
    item = W.resolve_qid(qid) if qid else None
    if not item:
        return
    have = {r["lang"]: r for r in q("SELECT * FROM lens_edition WHERE topic = %s", (topic,))}
    missing = {l: t for l, t in item["titles"].items() if l not in have}
    pages = measure(job, missing) if missing else {}
    q("INSERT IGNORE INTO lens_edition VALUES (%s,%s,%s,%s,%s)",
      [(topic, r["lang"], r["title"], r["prose"], False) for r in pages.values()], many=True)
    unpicked = {r["lang"]: r["title"] for r in q("SELECT lang, title FROM lens_edition WHERE topic = %s AND NOT picked", (topic,))}
    allp = {**{l: {"lang": l, "title": t, "prose": have[l]["prose_chars"]} for l, t in unpicked.items() if l in have}, **pages}
    # fill_independent needs chunks for the ones it adds: fetch those lazily
    order = sorted(allp.values(), key=lambda r: -r["prose"])
    for _ in range(3):
        langs = set(topic_langs(topic))
        indep = len(langs) - len(redundant(topic))
        need = min(n - indep, 9 - len(langs))
        cand = [r for r in order if r["lang"] not in langs and len(r["lang"]) <= 3 and r["prose"] > 2000][:max(need, 0)]
        if not cand:
            break
        step(job, "Copies do not count: adding " + ", ".join(r["lang"] for r in cand))
        full = measure(job, {r["lang"]: r["title"] for r in cand})
        store(job, topic, None, list(full.values()))
        score_topic(job, topic, check=False)
    score_topic(job, topic)


def backfill_refs(topic_dir="data/lens/raw"):
    """Citations for the 9 curated articles: re-chunk their current wikitext (legacy mode = identical texts)."""
    import pathlib
    ensure_tables()
    rows = []
    for f in pathlib.Path(topic_dir).glob("*/*/current.json"):
        topic, lang = f.parts[-3], f.parts[-2]
        page = json.loads(f.read_text())["query"]["pages"][0]
        if "revisions" not in page:
            continue
        for sec, txt, refs in W.chunks(page["revisions"][0]["slots"]["main"].get("content", ""), legacy=True):
            if refs:
                rows.append((topic, lang, W.sha(txt), json.dumps(refs, ensure_ascii=False)))
    q("REPLACE INTO lens_ref VALUES (%s,%s,%s,%s)", rows, many=True)
    return len(rows)


# ---------- consensus ----------
def clusters_for(topic, langs, t):
    """Union-find over mutual nearest-neighbour paragraph matches (cosine >= TAU) between every pair of editions."""
    chunks = {l: K.chunks(topic, l, t) for l in langs}
    best = {}
    for a in langs:
        for b in langs:
            if a != b:
                for m in K.matches(topic, a, b, t):
                    best[(a, m["id"], b)] = (m["match_id"], float(m["sim"] or 0))
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for (a, i, b), (j, s) in best.items():
        if s >= K.TAU and best.get((b, j, a), (None,))[0] == i:
            parent[find((a, i))] = find((b, j))
    groups = {}
    for l in langs:
        for c in chunks[l]:
            groups.setdefault(find((l, c["id"])), []).append((l, c))
    return chunks, list(groups.values()), best


def score_topic(job, topic, check=True):
    step(job, "Scoring editions against the consensus of all editions")
    t = K.now()
    langs = topic_langs(topic)
    chunks, groups, best = clusters_for(topic, langs, t)
    k = min(3, len(langs))
    cons = [g for g in groups if len({l for l, _ in g}) >= k]
    refs = {(r["lang"], r["sha1"]) for r in q("SELECT lang, sha1 FROM lens_ref WHERE topic = %s", (topic,))}
    snaps = {r["lang"]: r for r in q("""SELECT s.* FROM lens_snapshot s WHERE topic = %s AND is_current""", (topic,))}
    per = []
    for l in langs:
        total = sum(c["chars"] for c in chunks[l]) or 1
        told = sum(1 for g in cons if any(x == l for x, _ in g))
        uniq = sum(c["chars"] for g in groups if len({x for x, _ in g}) == 1 for x, c in g if x == l)
        cited = sum(c["chars"] for c in chunks[l] if (l, W.sha(c["text"])) in refs)
        per.append({"lang": l, "title": (snaps.get(l) or {}).get("title"), "rev_id": (snaps.get(l) or {}).get("rev_id"),
                    "chars": total, "paragraphs": len(chunks[l]),
                    "coverage": round(100 * told / len(cons)) if cons else None,
                    "consensus_told": told, "unique_share": round(100 * uniq / total),
                    "sourcing": round(100 * cited / total) if refs else None})
    # near-copies (translations): at least half the text matches at cosine >= COPY_SIM, averaged over both directions.
    # Calibrated on known cases: ru/uk Lapland War and Civil War 64-86%, independent editions 0-43%.
    cover, close = {}, {}
    for a in langs:
        for b in langs:
            if a != b and chunks[a]:
                tot = sum(c["chars"] for c in chunks[a]) or 1
                cover[(a, b)] = 100 * sum(c["chars"] for c in chunks[a] if best.get((a, c["id"], b), (0, 0))[1] >= K.TAU) / tot
                close[(a, b)] = 100 * sum(c["chars"] for c in chunks[a] if best.get((a, c["id"], b), (0, 0))[1] >= COPY_SIM) / tot
    copies = [{"a": a, "b": b, "overlap": round((close[(a, b)] + close[(b, a)]) / 2)}
              for i, a in enumerate(langs) for b in langs[i + 1:] if (close.get((a, b), 0) + close.get((b, a), 0)) / 2 >= COPY_SHARE]
    for p in per:
        p["copies"] = [c["b"] if c["a"] == p["lang"] else c["a"] for c in copies if p["lang"] in (c["a"], c["b"])]
    # "who resembles whom" for articles without precomputed history: today's cell values
    q("CREATE TABLE IF NOT EXISTS lens_pair (topic VARCHAR(100) NOT NULL, a CHAR(3) NOT NULL, b CHAR(3) NOT NULL, "
      "year VARCHAR(4) NOT NULL, coverage DOUBLE, similarity DOUBLE, PRIMARY KEY (topic, a, b, year))")
    if not q("SELECT 1 FROM lens_pair WHERE topic = %s AND year <> 'now' LIMIT 1", (topic,)):
        q("REPLACE INTO lens_pair VALUES (%s,%s,%s,'now',%s,NULL)", [(topic, a, b, v) for (a, b), v in cover.items()], many=True)
    result = {"topic": topic, "k": k, "n_consensus": len(cons), "n_clusters": len(groups), "langs": per, "copies": copies,
              "weights": WEIGHTS, "tau": K.TAU}
    q("REPLACE INTO lens_consensus (topic, result) VALUES (%s,%s)", (topic, json.dumps(result, ensure_ascii=False)))
    K._CACHE.clear()
    if job is not None and check:
        factcheck(job, topic, chunks, groups)


# ---------- conflicts + sources ----------
def claude_json(prompt, timeout=900):
    out = subprocess.run(["claude", "-p", "--model", LIVE_MODEL, "--output-format", "json"], input=prompt,
                         capture_output=True, text=True, timeout=timeout)
    text = json.loads(out.stdout)["result"].strip()
    text = re.sub(r"^```(?:json)?|```$", "", text).strip()
    return json.loads(text[text.find("{"):text.rfind("}") + 1])


CONFLICT_PROMPT = """You compare language editions of the Wikipedia article "{topic}". Editions: {langs}.
Below are groups of paragraphs that a multilingual embedding model matched across editions (same part of the story).
No edition is the reference: Wikipedia's ground truth is the cited sources, not any one language.

For each group, decide whether the editions really disagree, and list only real disagreements:
- "fact": different numbers, dates, names, places, outcomes or causes for the same thing.
- "definition": a difference that comes from defining or periodising something differently (e.g. when a war started), not an error.
- "framing": the same facts told with evaluative or one-sided wording, or a key point dropped.
For every disagreement give each participating edition's version: a short English "claim", and a "quote" copied
EXACTLY (character for character, max 200 chars) from that edition's paragraph, plus "quote_en".
"groups": lists of editions that agree with each other on this point.

Also write "report": 3-5 plain sentences on how the editions differ overall and the likely reasons (audience,
national perspective, copying between editions, sources), and "angles": one short line per edition on its focus.

Return ONLY JSON, no prose:
{{"report": str, "angles": {{"<lang>": str}},
 "conflicts": [{{"group": int, "label": str, "kind": "fact"|"definition"|"framing", "note": str,
   "versions": [{{"lang": str, "claim": str, "quote": str, "quote_en": str}}], "groups": [[str]]}}]}}
Max 12 conflicts, most important first.

{groups}
"""

SOURCE_PROMPT = """Check whether cited sources support claims made by different Wikipedia language editions about "{topic}".
Disagreement: {label} ({note})

{blocks}

For each edition and each CITED source, answer: "supports" (the source states the edition's claim), "contradicts" (the
source states something incompatible), or "silent" (the excerpt does not address it). Quote the decisive words from the
source in "evidence" (max 160 chars, original language).
Then judge each edition's claim against the INDEPENDENT sources taken together: "supports", "contradicts" or "unclear"
(e.g. the sources disagree among themselves, or do not address the point), with the web source numbers you relied on.
Weigh scholarly and archival sources above opinion pieces. Then "resolution": one sentence on which claim the sources back.
Return ONLY JSON: {{"versions": [{{"lang": str, "sources": [{{"n": int, "verdict": str, "evidence": str}}]}}],
 "independent": [{{"lang": str, "verdict": "supports"|"contradicts"|"unclear", "refs": [int], "note": str}}], "resolution": str}}
"""


# ---------- Context.dev: browser-rendered scraping and independent web research ----------
CTX_URL = "https://api.context.dev/v1"
NOT_INDEPENDENT = re.compile(r"(wikipedia\.org|wikiwand\.|wikimedia\.org|wikidata\.org|dbpedia\.|wiki2\.|everybodywiki|alchetron|"
                             r"academic-accelerator|wikizero|infogalactic|kiwix|ruwiki\.|wiki\.ng|justapedia)", re.I)


def ctx(path, body, timeout=30):
    import os
    key = os.environ.get("CONTEXT_DEV_API_KEY")
    if not key:
        return None
    try:
        r = requests.post(CTX_URL + path, json=body, timeout=timeout, headers={"Authorization": f"Bearer {key}"})
        return r.json() if r.status_code == 200 else None
    except Exception:  # noqa: BLE001
        return None


def ctx_scrape(url):
    d = ctx("/web/scrape", {"url": url, "formats": {"markdown": True}})
    md = ((d or {}).get("markdown") or {})
    if md.get("success") and md.get("data") and "verifying your browser" not in md["data"][:400].lower():
        return re.sub(r"\s+", " ", md["data"])[:200_000]
    return None


WEB_SCHEMA = {"type": "object", "required": ["findings"], "properties": {"findings": {"type": "array", "items": {
    "type": "object", "required": ["claim", "source_url", "quote"], "properties": {
        "claim": {"type": "string"}, "source_url": {"type": "string"}, "source_title": {"type": "string"}, "quote": {"type": "string"}}}}}}


def web_research(topic, c):
    """Independent sources for one disagreement, found on the live web by Context.dev (Wikipedia and mirrors excluded)."""
    claims = "; ".join(f"the {v['lang']} edition says: {v.get('claim')}" for v in c.get("versions", []))
    task = (f"Topic: {topic}. Wikipedia language editions disagree about '{c.get('label')}': {claims}. "
            "Find what independent sources (historians, scholarly works, archives, official records, reputable news or "
            "encyclopedias) say about this exact point. Do not use wikipedia.org or any Wikipedia mirror. For each source give "
            "what it states, the URL, the title and a short exact quote from the page.")
    d = ctx("/web/answers", {"task": task, "mode": "fast", "json_format": WEB_SCHEMA,
                              "timeoutOpts": {"behavior": "return-partial", "milliseconds": 25000}}, timeout=45)
    out = []
    for f in ((d or {}).get("json_content") or {}).get("findings", []) or []:
        u = f.get("source_url") or ""
        if u.startswith("http") and not NOT_INDEPENDENT.search(u) and u not in {x["url"] for x in out}:
            out.append({"url": u, "title": (f.get("source_title") or "")[:160], "claim": (f.get("claim") or "")[:400],
                        "quote": (f.get("quote") or "")[:400]})
    return out[:5]


def page_text(url):
    t = ctx_scrape(url)            # a real browser: JavaScript pages, archives, most bot walls
    if t:
        return t
    try:
        r = requests.get(url, timeout=8, headers={"User-Agent": W.UA}, allow_redirects=True)
        if r.status_code != 200 or "html" not in r.headers.get("content-type", "text/html"):
            return None
        t = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", r.text)
        t = re.sub(r"<[^>]+>", " ", t)
        import html as H
        return re.sub(r"\s+", " ", H.unescape(t)).strip()[:200_000]
    except Exception:  # noqa: BLE001 - dead links are common
        return None


def windows(text, needles, size=1200, k=2):
    words = {w for w in re.findall(r"\w{4,}|\d{2,}", " ".join(needles).lower())}
    if not text or not words:
        return []
    parts = [text[i:i + size] for i in range(0, len(text), size // 2)]
    scored = sorted(parts, key=lambda p: -sum(1 for w in words if w in p.lower()))
    return [p for p in scored[:k] if any(w in p.lower() for w in words)]


def factcheck(job, topic, chunks, groups):
    langs = sorted(chunks)
    multi = [g for g in groups if len({l for l, _ in g}) >= 2]
    multi.sort(key=lambda g: (-len({l for l, _ in g}), -sum(c["chars"] for _, c in g)))
    multi = multi[:22]
    blocks = []
    for gi, g in enumerate(multi):
        per = {}
        for l, c in g:
            per.setdefault(l, []).append(c["text"])
        body = "\n".join(f"  [{l}] " + " ".join(ts)[:700] for l, ts in sorted(per.items()))
        blocks.append(f"GROUP {gi}\n{body}")
    step(job, "Claude: finding where the editions disagree")
    res = claude_json(CONFLICT_PROMPT.format(topic=topic, langs=", ".join(langs), groups="\n\n".join(blocks)))
    refs = {(r["lang"], r["sha1"]): json.loads(r["refs"]) for r in q("SELECT lang, sha1, refs FROM lens_ref WHERE topic = %s", (topic,))}
    norm = lambda s: " ".join((s or "").split())
    conflicts = res.get("conflicts", [])
    # attach the paragraph and its citations to every version
    for c in conflicts:
        g = multi[c["group"]] if isinstance(c.get("group"), int) and c["group"] < len(multi) else []
        for v in c.get("versions", []):
            cand = [ch for l, ch in g if l == v["lang"]] or chunks.get(v["lang"], [])
            hit = next((ch for ch in cand if norm(v.get("quote")).rstrip("…") and norm(v.get("quote")).rstrip("…") in norm(ch["text"])), None)
            v["verified"] = hit is not None
            ch = hit or (cand[0] if cand else None)
            v["refs"] = refs.get((v["lang"], W.sha(ch["text"])), []) if ch else []
            v["section"] = ch["section"] if ch else ""
    conflicts = _check_all(job, topic, conflicts)
    # agreement per edition. Near-copies vote once: copying is not confirmation.
    agree, groups_of = agree_counts(topic, langs, conflicts)
    result = {"report": res.get("report"), "angles": res.get("angles", {}), "conflicts": conflicts, "agree": agree,
              "copy_groups": groups_of}
    q("REPLACE INTO lens_factcheck (topic, result) VALUES (%s,%s)", (topic, json.dumps(result, ensure_ascii=False)))
    try:
        attach_books(topic, job)
    except Exception as e:  # noqa: BLE001 - book links are a bonus
        print("book links failed:", e, flush=True)
    K._CACHE.clear()
    step(job, "Done")


def recheck_sources(topic, job=None, workers=4):
    """Re-run the source check of stored disagreements with Context.dev (scraped citations + independent web sources)."""
    f = q("SELECT result FROM lens_factcheck WHERE topic = %s", (topic,))
    if not f:
        return
    fc = json.loads(f[0]["result"])
    conflicts = fc.get("conflicts", [])
    if job is None:
        job = {"id": "recheck", "state": "running"}
    langs = topic_langs(topic)
    _check_all(job, topic, conflicts)
    fc["agree"], fc["copy_groups"] = agree_counts(topic, langs, conflicts)
    q("REPLACE INTO lens_factcheck (topic, result) VALUES (%s,%s)", (topic, json.dumps(fc, ensure_ascii=False)))
    attach_books(topic)
    K._CACHE.clear()


def wikitext_of(topic, lang):
    """Current wikitext of one edition: the curated raw snapshot if we have it, else the stored revision from Wikipedia."""
    import pathlib
    f = pathlib.Path("data/lens/raw") / topic / lang / "current.json"
    if f.exists():
        page = json.loads(f.read_text())["query"]["pages"][0]
        if "revisions" in page:
            return page["revisions"][0]["slots"]["main"].get("content", "")
    rev = q("SELECT rev_id FROM lens_snapshot WHERE topic = %s AND lang = %s AND is_current ORDER BY ts DESC LIMIT 1", (topic, lang))
    if not rev:
        return ""
    return W.http_get(f"https://{lang}.wikipedia.org/w/index.php?oldid={rev[0]['rev_id']}&action=raw") or ""


def attach_books(topic, job=None):
    """Google Books links for every cited book in the disputed claims (ISBN, the article's bibliography, Open Library)."""
    from wikitime import lensbooks as B
    f = q("SELECT result FROM lens_factcheck WHERE topic = %s", (topic,))
    if not f:
        return 0
    fc = json.loads(f[0]["result"])
    langs = {v["lang"] for c in fc.get("conflicts", []) for v in c.get("versions", [])}
    bibs = {l: B.bibliography(wikitext_of(topic, l)) for l in langs}
    ol, n = {}, 0
    step(job, "Finding the cited books on Google Books")
    for c in fc.get("conflicts", []):
        for v in c.get("versions", []):
            for r in v.get("refs", [])[:4]:
                if r.get("url") and r.get("kind") == "web":
                    continue
                r["books"] = B.resolve(r, bibs.get(v["lang"], []), ol)
                n += bool(r["books"])
    q("REPLACE INTO lens_factcheck (topic, result) VALUES (%s,%s)", (topic, json.dumps(fc, ensure_ascii=False)))
    K._CACHE.clear()
    return n


def agree_counts(topic, langs, conflicts):
    cons = q("SELECT result FROM lens_consensus WHERE topic = %s", (topic,))
    copy_pairs = json.loads(cons[0]["result"]).get("copies", []) if cons else []
    root = {l: l for l in langs}

    def find(x):
        while root.get(x, x) != x:
            x = root[x]
        return x
    for cp in copy_pairs:
        root[find(cp["a"])] = find(cp["b"])
    votes = lambda g: len({find(l) for l in g})
    agree = {l: [0, 0] for l in langs}
    for c in conflicts:
        gs = c.get("groups", []) or []
        sizes = sorted((votes(g) for g in gs), reverse=True)
        top = max(gs, key=votes) if gs else []
        clear_majority = len(sizes) > 1 and sizes[0] > sizes[1]
        for v in c.get("versions", []):
            l = v["lang"]
            if l not in agree:
                continue
            if v.get("status") in ("supported", "web-supported"):
                agree[l][0] += 1
            elif v.get("status") in ("contradicted", "web-contradicted"):
                agree[l][1] += 1
            elif clear_majority:
                agree[l][0 if l in top else 1] += 1
    return agree, {l: find(l) for l in langs}


def rescore(topic):
    """Recompute consensus numbers and agreement from the stored conflicts (no Claude calls)."""
    score_topic(None, topic, check=False)
    f = q("SELECT result FROM lens_factcheck WHERE topic = %s", (topic,))
    if f:
        fc = json.loads(f[0]["result"])
        fc["agree"], fc["copy_groups"] = agree_counts(topic, topic_langs(topic), fc.get("conflicts", []))
        q("REPLACE INTO lens_factcheck (topic, result) VALUES (%s,%s)", (topic, json.dumps(fc, ensure_ascii=False)))
    K._CACHE.clear()


def _check_all(job, topic, conflicts):
    """Fetch cited sources (Context.dev scrape first), research independent sources, let Claude judge, per conflict."""
    step(job, "Fetching the cited sources of disputed claims", 0, len(conflicts))

    def check(ci):
        c = conflicts[ci]
        texts, n, jobs = [], 0, []
        for v in c.get("versions", []):
            v["sources"] = []
            for r in v["refs"][:3]:
                n += 1
                src = {"n": n, "kind": r["kind"], "title": r.get("title") or r.get("text", "")[:120], "url": r.get("url")}
                if r.get("url") and r["kind"] in ("web", "news", "journal", "other", "book"):
                    jobs.append((v, r, src))
                v["sources"].append(src)
        # read every cited page and search the web for independent sources at the same time
        with ThreadPoolExecutor(8) as px:
            web_f = px.submit(web_research, topic, c)
            pages = list(px.map(lambda job: page_text(job[1]["url"]), jobs))
            c["web"] = web_f.result()
        for (v, r, src), page in zip(jobs, pages):
            win = windows(page, [v.get("quote", ""), v.get("claim", "")])
            src["checked"] = bool(win)
            if win:
                texts.append(f"[source {src['n']}] cited by {v['lang']} ({r['url']}):\n" + "\n…\n".join(win))
        indep = "\n\n".join(f"[web {i + 1}] {w['title']} ({w['url']}): {w['claim']} Quote: “{w['quote']}”"
                             for i, w in enumerate(c["web"]))
        if texts or indep:
            claims = "\n".join(f"- {v['lang']} edition claims: {v.get('claim')} (quote: {v.get('quote')})" for v in c["versions"])
            try:
                out = claude_json(SOURCE_PROMPT.format(topic=topic, label=c.get("label"), note=c.get("note"),
                                                       blocks=claims + "\n\nCITED SOURCES\n" + ("\n\n".join(texts) or "(none could be read)")
                                                       + "\n\nINDEPENDENT SOURCES (found on the web by Context.dev, cited by no edition)\n"
                                                       + (indep or "(none found)")), timeout=600)
                verdict = {(x["lang"], s["n"]): s for x in out.get("versions", []) for s in x.get("sources", [])}
                for v in c["versions"]:
                    for s in v["sources"]:
                        if (v["lang"], s["n"]) in verdict:
                            s.update(verdict[(v["lang"], s["n"])])
                web_v = {x.get("lang"): x for x in out.get("independent", []) if isinstance(x, dict)}
                for v in c["versions"]:
                    if v["lang"] in web_v:
                        v["web"] = {"verdict": web_v[v["lang"]].get("verdict"), "note": web_v[v["lang"]].get("note", "")[:240],
                                    "refs": web_v[v["lang"]].get("refs", [])}
                c["resolution"] = out.get("resolution")
            except Exception as e:  # noqa: BLE001
                c["resolution_error"] = str(e)[:200]
        for v in c["versions"]:
            vs = [s.get("verdict") for s in v["sources"]]
            wv = (v.get("web") or {}).get("verdict")
            v["status"] = ("supported" if "supports" in vs else "contradicted" if "contradicts" in vs else
                           "web-supported" if wv == "supports" else "web-contradicted" if wv == "contradicts" else
                           "cited-unconfirmed" if v["sources"] else "uncited")
        step(job, "Fetching the cited sources of disputed claims", ci + 1, len(conflicts))
        return c
    with ThreadPoolExecutor(12) as ex:   # Context.dev allows 50 concurrent requests; Claude calls run side by side
        conflicts = list(ex.map(check, range(len(conflicts))))
    return conflicts


# ---------- gaps, translations, the story over time ----------
FAST_MODEL = "claude-sonnet-5-5"
_PENDING = set()


def claude_json_model(prompt, model, timeout=600):
    out = subprocess.run(["claude", "-p", "--model", model, "--output-format", "json"], input=prompt,
                         capture_output=True, text=True, timeout=timeout)
    text = json.loads(out.stdout)["result"].strip()
    text = re.sub(r"^```(?:json)?|```$", "", text).strip()
    return json.loads(text[text.find("{"):text.rfind("}") + 1])


def _ensure_side_tables():
    q("CREATE TABLE IF NOT EXISTS lens_gaps (topic VARCHAR(100), ref CHAR(3), lang CHAR(3), result JSON NOT NULL, "
      "created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (topic, ref, lang))")
    q("CREATE TABLE IF NOT EXISTS lens_trans (sha1 CHAR(40) PRIMARY KEY, lang VARCHAR(12), en MEDIUMTEXT NOT NULL)")
    q("CREATE TABLE IF NOT EXISTS lens_story (topic VARCHAR(100) PRIMARY KEY, result JSON NOT NULL, "
      "created TIMESTAMP DEFAULT CURRENT_TIMESTAMP)")


GAPS_PROMPT = """Two language editions of the Wikipedia article "{topic}": {a_name} and {b_name}. A multilingual embedding model found
no counterpart in the other edition for the paragraphs below. For each paragraph decide why it has no counterpart:
- "content": the other edition simply does not tell this (missing facts, events, people, analysis).
- "concept": it is mostly about a term, name or concept that has no direct equivalent in the other language or culture
  (so the match failed on wording, not on substance) — e.g. a local institution, an idiom, a party name.
- "context": background a foreign or local reader needs (explaining geography, terms, who someone is), not new substance.
Give each a short English "gist" (max 18 words) and, for "concept", the term in "term".
Return ONLY JSON: {{"items": [{{"id": str, "kind": "content"|"concept"|"context", "gist": str, "term": str}}]}}

{items}
"""


def get_gaps(topic, ref, lang):
    _ensure_side_tables()
    r = q("SELECT result FROM lens_gaps WHERE topic = %s AND ref = %s AND lang = %s", (topic, ref, lang))
    return json.loads(r[0]["result"]) if r else None


def compute_gaps(topic, ref, lang):
    al = K.alignment(topic, lang, ref=ref)
    paired = {p["fi"]["id"] for p in al["pairs"]} | {p["match"]["id"] for p in al["pairs"]}
    items = [(ref, c) for c in al["fi_all"] if c["id"] not in paired] + [(lang, c) for c in al["other_all"] if c["id"] not in paired]
    out = {}
    for i in range(0, len(items), 40):
        part = items[i:i + 40]
        block = "\n\n".join(f"[id {W.sha(c['text'])[:12]}] ({l}, section: {c['section'] or '-'}) {c['text'][:450]}" for l, c in part)
        names = {"fi": "Finnish"}
        res = claude_json_model(GAPS_PROMPT.format(topic=topic, a_name=ref, b_name=lang, items=block), FAST_MODEL)
        for it in res.get("items", []):
            out[str(it.get("id", ""))[:12]] = {"kind": it.get("kind"), "gist": it.get("gist", ""), "term": it.get("term", "")}
    result = {"topic": topic, "ref": ref, "lang": lang, "items": out}
    q("REPLACE INTO lens_gaps (topic, ref, lang, result) VALUES (%s,%s,%s,%s)", (topic, ref, lang, json.dumps(result, ensure_ascii=False)))
    return result


def ensure_gaps_job(topic, ref, lang):
    key = ("gaps", topic, ref, lang)
    if key in _PENDING:
        return
    _PENDING.add(key)

    def run():
        try:
            compute_gaps(topic, ref, lang)
        except Exception as e:  # noqa: BLE001
            print("gaps failed:", e, flush=True)
        finally:
            _PENDING.discard(key)
    threading.Thread(target=run, daemon=True).start()


def translate_para(topic, lang, h):
    _ensure_side_tables()
    hit = q("SELECT en FROM lens_trans WHERE sha1 = %s", (h,))
    # the page's paragraph ids are sha1 of the decoded text (as the API serves it), so match on that
    found = next((c for c in K.chunks(topic, lang, K.now()) if W.sha(c["text"]) == h), None)
    if not found:
        return None
    rows = [found]
    text = found["text"]
    if hit:
        return {"text": text, "section": rows[0]["section"], "en": hit[0]["en"]}
    if lang == "en":
        en = text
    else:
        out = subprocess.run(["claude", "-p", "--model", FAST_MODEL],
                             input=f"Translate this {lang} Wikipedia paragraph into plain English. Output only the translation.\n\n{text}",
                             capture_output=True, text=True, timeout=240)
        en = out.stdout.strip()
    if en:
        q("REPLACE INTO lens_trans VALUES (%s,%s,%s)", (h, lang, en))
    return {"text": text, "section": rows[0]["section"], "en": en}


STORY_PROMPT = """You write a short, factual account of how the language editions of the Wikipedia article "{topic}" changed over time.
Data (from snapshots on 1 January of each year, and today):
COVERAGE of the {ref_name} article by each edition, in % (share of the {ref_name} text that has a counterpart):
{coverage}
ARTICLE SIZE (characters of prose) per edition and year:
{sizes}
EDITION PAIRS THAT MOVED CLOSER (both directions averaged, % of text with a counterpart):
{moves}

Write:
- "headline": one sentence, the most striking change.
- "story": 3-5 items, each {{"when": "2012-2016" or a year, "text": one or two plain sentences}}: what grew, what shrank, which
  editions converged (possibly copying or translating each other), and plausible reasons. Only claim what the numbers show;
  say "may" for reasons.
Return ONLY JSON: {{"headline": str, "story": [{{"when": str, "text": str}}]}}
"""


def get_story(topic):
    _ensure_side_tables()
    r = q("SELECT result FROM lens_story WHERE topic = %s", (topic,))
    return json.loads(r[0]["result"]) if r else None


def compute_story(topic):
    langs = topic_langs(topic)
    snaps = q("SELECT lang, ts, chars FROM lens_snapshot WHERE topic = %s ORDER BY ts", (topic,))
    if len({str(s["ts"])[:4] for s in snaps}) < 3:
        result = {"topic": topic, "headline": None, "story": [], "no_history": True}
    else:
        base = "fi" if "fi" in langs else max(langs, key=lambda l: max((s["chars"] for s in snaps if s["lang"] == l), default=0))
        pts = [(str(y), f"{y}-01-01 00:00:00") for y in K.YEARS] + [("now", K.now())]
        cov = "\n".join(f"{l}: " + ", ".join(f"{lab} {K.score(topic, l, t, base)['coverage'] or 0:.0f}" for lab, t in pts)
                        for l in langs if l != base)
        size = "\n".join(f"{l}: " + ", ".join(f"{lab} {next((s['chars'] for s in reversed(snaps) if s['lang'] == l and str(s['ts']) <= t), 0)}"
                                              for lab, t in pts) for l in langs)
        pairs = q("SELECT a, b, year, coverage FROM lens_pair WHERE topic = %s", (topic,))
        sym = {}
        for p in pairs:
            sym.setdefault((min(p["a"], p["b"]), max(p["a"], p["b"]), p["year"]), []).append(p["coverage"] or 0)
        moves = []
        for (a, b, y), v in sym.items():
            if y == "now":
                first = min((yy for (aa, bb, yy) in sym if (aa, bb) == (a, b) and yy != "now" and all(x > 0 for x in sym[(aa, bb, yy)])), default=None)
                if first:
                    d = sum(v) / len(v) - sum(sym[(a, b, first)]) / len(sym[(a, b, first)])
                    if d >= 10:
                        moves.append(f"{a}-{b}: {sum(sym[(a, b, first)]) / 2:.0f}% in {first} -> {sum(v) / len(v):.0f}% now")
        res = claude_json_model(STORY_PROMPT.format(topic=topic, ref_name=base, coverage=cov, sizes=size,
                                                    moves="\n".join(moves) or "(none above 10 points)"), MODEL)
        result = {"topic": topic, "ref": base, **res}
    q("REPLACE INTO lens_story (topic, result) VALUES (%s,%s)", (topic, json.dumps(result, ensure_ascii=False)))
    return result


def ensure_story_job(topic):
    key = ("story", topic)
    if key in _PENDING:
        return
    _PENDING.add(key)

    def run():
        try:
            compute_story(topic)
        except Exception as e:  # noqa: BLE001
            print("story failed:", e, flush=True)
        finally:
            _PENDING.discard(key)
    threading.Thread(target=run, daemon=True).start()


def summary(topic):
    """Consensus scores + fact check merged, with the index computed from the visible parts."""
    c = q("SELECT result FROM lens_consensus WHERE topic = %s", (topic,))
    if not c:
        return None
    res = json.loads(c[0]["result"])
    f = q("SELECT result, created FROM lens_factcheck WHERE topic = %s", (topic,))
    fc = json.loads(f[0]["result"]) if f else None
    for p in res["langs"]:
        g, b = (fc or {}).get("agree", {}).get(p["lang"], [0, 0])
        p["agree_good"], p["agree_bad"] = g, b
        p["agreement"] = round(100 * (g + 1) / (g + b + 2)) if fc else None   # neutral prior: one conflict cannot swing it
        parts = {"coverage": p["coverage"], "agreement": p["agreement"], "sourcing": p["sourcing"]}
        have = {k: v for k, v in parts.items() if v is not None}
        wsum = sum(WEIGHTS[k] for k in have) or 1
        p["index"] = round(sum(WEIGHTS[k] * v for k, v in have.items()) / wsum) if have else None
    res["langs"].sort(key=lambda p: -(p["index"] or 0))
    res["factcheck"] = fc
    res["editions"] = q("SELECT lang, title, prose_chars, picked FROM lens_edition WHERE topic = %s ORDER BY prose_chars DESC", (topic,))
    return res
