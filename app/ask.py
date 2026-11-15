"""Ask Wikipedia — as it stood on any date. Grounded, source-cited answers (RAG) over the
system-versioned history: retrieval = FOR SYSTEM_TIME AS OF + MariaDB vector search; the sources are
the article texts *as they read on that date* (also FOR SYSTEM_TIME AS OF); Claude answers only from
them, with citations pointing at the exact passage and the exact Wikipedia version (?oldid=).

GET /api/ask/stream?q=...&t=2015[&compare=1]   Server-Sent Events:
  {"type":"sources", "sources":[...]}  then {"type":"text","block":i,"text":...}*  and
  {"type":"cite","block":i,"citation":{...}}*  then {"type":"done", ...} or {"type":"error", ...}
compare=1: sources from both the chosen date and today; the answer says what changed since.
"""
import json, re, threading, time
from concurrent.futures import ThreadPoolExecutor
import anthropic
from flask import Blueprint, Response, request, stream_with_context
from app.db import rows
from app.timesearch import moment, query_vector, search_as_of
from wikitime.wikitext import clean

bp = Blueprint("ask", __name__)
MODEL = "claude-opus-5-5"
NOW = "2026-10-01 00:00:00"
_client = None
_cache, _cache_lock = {}, threading.Lock()


def client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()          # credentials: env key or the `ant auth login` profile
    return _client


def _terms(s):
    return {w[:5] for w in re.findall(r"\w+", s.lower()) if len(w) > 3}


def _snapshot_blocks(rev_id):
    """Cleaned text of a vector snapshot version, one primary-key read (scripts/build_snapshot_text.py)."""
    try:
        r = rows("SELECT title, text FROM snapshot_text WHERE rev_id=%s", (rev_id,))
    except Exception:                                  # table not built yet
        return None
    if not r:
        return None
    return r[0]["title"], [x for x in r[0]["text"].split("\n\n") if not x.startswith("## ") and len(x) > 30]


def passages(page_id, t, q, budget=4500, rev_id=None, version=None):
    """The article as it read at moment t: its lead plus the paragraphs that best match the question.
    With rev_id (the snapshot the vector search matched) the text comes from snapshot_text; otherwise it
    is read from the system-versioned article table with FOR SYSTEM_TIME AS OF t."""
    snap = _snapshot_blocks(rev_id) if rev_id else None
    if snap:
        title, blocks = snap
        r = [{"rev_id": rev_id, "title": title, "row_start": version}]
    else:
        r = rows("SELECT rev_id, title, text, row_start FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s "
                 "WHERE page_id=%s", (t, page_id))
        if not r:
            return None
        blocks = [x for k, x in clean(r[0]["text"]) if k in ("p", "li") and len(x) > 30]
    if not blocks:
        return None
    qt = _terms(q)
    lead = blocks[:2]
    rest = sorted(blocks[2:], key=lambda b: -len(qt & _terms(b)))[:6]
    keep = [b for b in blocks if b in lead or b in rest]          # keep article order
    text, out = 0, []
    for b in keep:
        if text + len(b) > budget:
            break
        out.append(b)
        text += len(b)
    return {"rev_id": r[0]["rev_id"], "title": r[0]["title"], "version": r[0]["row_start"],
            "text": "\n\n".join(out)}


_pool = ThreadPoolExecutor(max_workers=8)


TOPIC_SQL = """SELECT DISTINCT f.page_id FROM
  (SELECT lang, page_id, VEC_DISTANCE_COSINE(embedding, %s) AS d FROM article_vector ORDER BY d LIMIT 8) s
  JOIN current_article a USING (lang, page_id)
  JOIN current_article f ON f.lang = 'fi' AND f.wikidata_id = a.wikidata_id
  ORDER BY s.d"""


def retrieve(vec, t, q, k):
    """Top-k articles as of t (time-travel vector search), each with its text as it read at t, plus up to
    three topics found through today's multilingual article vectors (fi/sv/en, joined on Wikidata ids),
    so a question in English still reaches the Finnish article even when its old version ranked lower.
    The texts are fetched in parallel: each is one FOR SYSTEM_TIME AS OF read."""
    found, seen = [], set()
    for f in search_as_of(vec, t, k):
        if f["page_id"] not in seen:          # defensive: the HNSW+AS OF path can repeat rows
            seen.add(f["page_id"]); found.append(f)
    extra = [r["page_id"] for r in rows(TOPIC_SQL, (vec,)) if r["page_id"] not in seen][:3]
    if extra:
        ph = ",".join(["%s"] * len(extra))
        for r in rows(f"""SELECT page_id, title, rev_id, row_start, VEC_DISTANCE_COSINE(embedding, %s) AS distance
                          FROM article_vector_history FOR SYSTEM_TIME AS OF TIMESTAMP %s
                          WHERE page_id IN ({ph})""", (vec, t, *extra)):
            seen.add(r["page_id"]); found.append(r)
    texts = list(_pool.map(lambda f: passages(f["page_id"], t, q, rev_id=f["rev_id"], version=f["row_start"]), found))
    return [{"page_id": f["page_id"], "distance": round(f["distance"], 4), "as_of": t[:10], **p}
            for f, p in zip(found, texts) if p]


SYSTEM = """You answer questions about Finnish history using ONLY the Finnish Wikipedia documents provided.
Each document is an article exactly as it read on a stated date (the encyclopedia's own version history).
Rules:
- Report what Wikipedia said in those versions, not your own knowledge. If the documents do not answer the
  question, say so plainly instead of filling the gap. Keep Wikipedia's neutral point of view.
- Cite: every factual claim must be supported by a citation to the documents.
- Answer in the language the question is written in (the documents are in Finnish; translate as needed).
- Be concise: at most about 180 words of plain prose: no Markdown at all (no **bold**, headings or bullet lists)."""

COMPARE = """The documents come from two moments: {then} and {now} (today). Answer in two short paragraphs:
first what Wikipedia said as of {then}, then what it says today and what changed in between (new facts,
removed or reworded claims, new articles). Cite documents from the matching moment in each paragraph."""


def build_messages(q, docs, t, compare):
    content = []
    for d in docs:
        content.append({
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": d["text"]},
            "title": f"{d['title']} — version of {str(d['version'])[:10]}",
            "context": f"Finnish Wikipedia article '{d['title']}' as it read on {d['as_of']} (rev {d['rev_id']}).",
            "citations": {"enabled": True},
        })
    ask = f"Question (answer as of {t[:10]}): {q}"
    if compare:
        ask = COMPARE.format(then=t[:10], now=NOW[:10]) + "\n\nQuestion: " + q
    content.append({"type": "text", "text": ask})
    return [{"role": "user", "content": content}]


def sse(obj):
    return f"data: {json.dumps(obj, ensure_ascii=False, default=str)}\n\n"


@bp.get("/stream")
def stream():
    q = (request.args.get("q") or "").strip()[:500]
    t = moment(request.args.get("t"))
    compare = request.args.get("compare") == "1"
    key = (q, t, compare)

    def gen():
        if not q:
            yield sse({"type": "error", "error": "empty question"}); return
        with _cache_lock:
            cached = _cache.get(key)
        if cached:                                   # replay a finished answer instantly
            for ev in cached:
                yield sse(ev)
            return
        events, t0 = [], time.time()

        def emit(ev):
            events.append(ev)
            return sse(ev)
        try:
            vec, label = query_vector(q)
        except Exception as e:                       # embedder offline / unknown article
            yield sse({"type": "error", "error": f"could not embed the question: {e.__class__.__name__}"}); return
        docs = retrieve(vec, t, q, 6)
        if compare and t[:10] != NOW[:10]:
            docs += retrieve(vec, NOW, q, 5)       # today's versions, even of the same articles
        if not docs:
            yield sse({"type": "error", "error": f"Wikipedia had no articles on this as of {t[:10]}."}); return
        yield emit({"type": "sources", "moment": t, "compare": compare, "retrieval_ms": round((time.time() - t0) * 1000),
                    "sources": [{k: d[k] for k in ("page_id", "title", "rev_id", "version", "as_of", "distance")}
                                for d in docs]})
        try:
            block = -1
            with client().beta.messages.stream(
                model=MODEL, max_tokens=4000, system=SYSTEM,
                messages=build_messages(q, docs, t, compare),
                output_config={"effort": "low"},
                betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            ) as s:
                for ev in s:
                    if ev.type == "content_block_start" and ev.content_block.type == "text":
                        block += 1
                    elif ev.type == "content_block_delta":
                        if ev.delta.type == "text_delta":
                            yield emit({"type": "text", "block": block, "text": ev.delta.text})
                        elif ev.delta.type == "citations_delta":
                            c = ev.delta.citation
                            yield emit({"type": "cite", "block": block, "citation": {
                                "doc": c.document_index, "cited_text": c.cited_text}})
                final = s.get_final_message()
            if final.stop_reason == "refusal":
                yield sse({"type": "error", "error": "The model declined to answer this question."}); return
            done = {"type": "done", "ms": round((time.time() - t0) * 1000), "model": final.model,
                    "stop_reason": final.stop_reason}
            yield emit(done)
            with _cache_lock:
                _cache[key] = events
        except anthropic.AuthenticationError:
            yield sse({"type": "error", "error": "No Claude credentials on this server (run `ant auth login` or set ANTHROPIC_API_KEY)."})
        except anthropic.RateLimitError:
            yield sse({"type": "error", "error": "Claude rate limit hit — try again in a minute."})
        except anthropic.APIStatusError as e:
            yield sse({"type": "error", "error": f"Claude API error {e.status_code}"})
        except anthropic.APIConnectionError:
            yield sse({"type": "error", "error": "Could not reach the Claude API."})

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _warm():
    """Warm the embedder, the vector table and the DB connections so the first visitor's question is fast."""
    try:
        vec, _ = query_vector("Suomen historia")
        for t in ("2010-01-01 00:00:00", NOW):
            retrieve(vec, t, "Suomen historia", 6)
    except Exception:
        pass


threading.Thread(target=_warm, daemon=True).start()
