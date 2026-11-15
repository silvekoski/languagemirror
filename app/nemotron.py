"""Framing check: how do two Wikipedia language editions frame the same event?

Kielipeili's MariaDB alignment (app/kielipeili.py: alignment) finds paragraph pairs that tell the same part of
the story in two editions, as both stood at one moment (FOR SYSTEM_TIME AS OF). This step sends the shared
passages that are told most differently (lowest cosine among mutual nearest neighbours) to a language model,
which says, per pair, whether the facts or only the framing differ and quotes the decisive words from both
revisions. Every quote is then checked as an exact substring of the stored revision text; failed quotes go back
to the model once with the paragraph to copy from (a self-check repair round), and what still fails is flagged,
never shown as evidence.

Engines: NVIDIA Nemotron 3.5 Super VL through the NVIDIA Build API (OpenAI-compatible; default when
NVIDIA_API_KEY is set) or Claude (anthropic SDK, the engine the rest of the app uses). Without either, the
endpoint answers with a clear "not configured" state and the rest of Kielipeili is unaffected.

    GET /api/nemotron/status
    GET /api/nemotron/frame?topic=Suomen sisällissota&lang=ru&ref=fi&at=2024&engine=nemotron&n=4
"""
import hashlib, json, os, random, re, threading, time

import requests
from flask import Blueprint, jsonify, request

bp = Blueprint("nemotron", __name__)

NEMOTRON_LABEL = "NVIDIA Nemotron 3.5 Super VL"
CLAUDE_MODEL = "claude-opus-5-5"
TIMEOUT = 60          # seconds per HTTP call
RETRIES = 4           # attempts on 429 / 5xx / network errors, exponential backoff
MAX_PAIRS = 6
MAX_CHARS = 1400      # per paragraph sent to the model
KINDS = ("none", "fact", "emphasis", "loaded", "omission", "audience")
LANG_NAMES = {"fi": "Finnish", "sv": "Swedish", "en": "English", "de": "German", "ru": "Russian", "uk": "Ukrainian",
              "fr": "French", "et": "Estonian", "pl": "Polish", "no": "Norwegian", "da": "Danish", "es": "Spanish"}


class EngineError(Exception):
    """The model could not be reached or gave no usable answer. `status` is the HTTP status to return."""
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


# ---------- Nemotron client (OpenAI-compatible chat completions) ----------
def base_url():
    return os.environ.get("NEMOTRON_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/")


def model():
    return os.environ.get("NEMOTRON_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b")


def nemotron_configured():
    return bool(os.environ.get("NVIDIA_API_KEY", "").strip())


def claude_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def default_engine():
    """Nemotron when its key is set; otherwise Claude, which the app also reaches through an `ant auth login` profile
    (a missing credential then shows as a clear error on the step, not a crash)."""
    return "nemotron" if nemotron_configured() else "claude"


_cache, _cache_lock = {}, threading.Lock()


def _key(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def nemotron_chat(messages, max_tokens=3000, temperature=0.2, sleep=time.sleep):
    """One chat completion. Retries 429/5xx/timeouts with exponential backoff (honours Retry-After), caches by
    input hash so a repeated click costs no request (free tier: about 40 requests a minute)."""
    key = os.environ.get("NVIDIA_API_KEY", "").strip()
    if not key:
        raise EngineError("Nemotron is not configured on this server (NVIDIA_API_KEY is not set).", 503)
    payload = {"model": model(), "messages": messages, "max_tokens": max_tokens, "temperature": temperature}
    ck = _key("nemotron", payload)
    with _cache_lock:
        if ck in _cache:
            return _cache[ck]
    last = None
    for attempt in range(RETRIES):
        try:
            r = requests.post(f"{base_url()}/chat/completions", json=payload, timeout=TIMEOUT,
                              headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
        except requests.RequestException as e:
            last = f"network error: {e.__class__.__name__}"
        else:
            if r.status_code == 200:
                try:
                    text = r.json()["choices"][0]["message"].get("content") or ""
                except (ValueError, KeyError, IndexError, TypeError):
                    raise EngineError("Nemotron returned an unreadable response.")
                with _cache_lock:
                    _cache[ck] = text
                return text
            if r.status_code in (401, 403):
                raise EngineError("Nemotron rejected the API key (NVIDIA_API_KEY).", 503)
            last = f"HTTP {r.status_code}"
            if r.status_code != 429 and r.status_code < 500:
                raise EngineError(f"Nemotron request failed: {last} {r.text[:200]}")
            retry_after = r.headers.get("Retry-After", "")
            if retry_after.isdigit() and attempt < RETRIES - 1:
                sleep(min(int(retry_after), 20))
                continue
        if attempt < RETRIES - 1:
            sleep(min(2 ** attempt + random.random(), 20))
    raise EngineError(f"Nemotron is unavailable right now ({last}); try again in a minute.", 503)


def claude_chat(messages, max_tokens=3000):
    import anthropic
    ck = _key("claude", messages)
    with _cache_lock:
        if ck in _cache:
            return _cache[ck]
    system = "\n".join(m["content"] for m in messages if m["role"] == "system")
    try:
        msg = anthropic.Anthropic(timeout=TIMEOUT * 2, max_retries=3).messages.create(
            model=CLAUDE_MODEL, max_tokens=max_tokens, system=system,
            messages=[m for m in messages if m["role"] != "system"])
    except anthropic.AuthenticationError:
        raise EngineError("No Claude credentials on this server (ANTHROPIC_API_KEY).", 503)
    except anthropic.APIError as e:
        raise EngineError(f"Claude is unavailable right now ({e.__class__.__name__}).", 503)
    except TypeError:   # the SDK found no credentials at all
        raise EngineError("No Claude credentials on this server (ANTHROPIC_API_KEY).", 503)
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    with _cache_lock:
        _cache[ck] = text
    return text


def chat(engine, messages):
    return nemotron_chat(messages) if engine == "nemotron" else claude_chat(messages)


def parse_json(text):
    """The JSON object in a model answer, without reasoning blocks or code fences."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the answer")
    return json.loads(text[start:end + 1])


# ---------- grounding ----------
def norm(s):
    return " ".join((s or "").replace(" ", " ").split()).strip(" \"'«»„“”…")


def grounded(quote, paragraph):
    q = norm(quote)
    return bool(q) and len(q) >= 8 and q in norm(paragraph)


SYSTEM = """You compare how two language editions of a Wikipedia article tell the same part of a story.
You are careful and literal. You never invent text: every quote is copied character for character from the
paragraph it belongs to. Answer with one JSON object only, no prose, no code fences."""

PROMPT = """Article: "{topic}". Edition A is {ref_name} ({ref}), edition B is {lang_name} ({lang}), both as they read on {date}.
A multilingual embedding model matched the paragraph pairs below as telling the same part of the story.

For each pair decide what differs:
- "none": same facts, same framing.
- "fact": different numbers, dates, names, outcomes or causes for the same thing.
- "emphasis": same facts, but one edition stresses or develops a different side.
- "loaded": evaluative or one-sided wording in one edition (say which words).
- "omission": one edition leaves out a point the other makes.
- "audience": context added for readers of that language (legitimate, not bias).

For each pair return: "n" (the pair number), "event" (5-10 English words naming what the pair is about), "kind",
"explanation" (1-2 English sentences, concrete), "quote_a" (the decisive words, copied EXACTLY from paragraph A,
10-160 characters, original language), "quote_b" (the same for paragraph B), "quote_b_en" (English translation of quote_b).
Then "summary": 2-3 English sentences on how B frames this story compared with A overall.

Return ONLY: {{"pairs": [{{"n": int, "event": str, "kind": str, "explanation": str, "quote_a": str, "quote_b": str, "quote_b_en": str}}], "summary": str}}

{blocks}"""

REPAIR = """Some quotes you gave are not exact substrings of their paragraph. For each item below, copy the decisive
words again EXACTLY, character for character, from the paragraph shown (10-160 characters). If no exact quote
supports your point, return an empty string for it.
Return ONLY: {{"fixes": [{{"n": int, "side": "a"|"b", "quote": str}}]}}

{items}"""


def _blocks(pairs):
    out = []
    for i, p in enumerate(pairs, 1):
        out.append(f"### Pair {i} (section A: {p['ref']['section'] or '-'}; section B: {p['other']['section'] or '-'})\n"
                   f"[A]\n{p['ref']['text'][:MAX_CHARS]}\n[B]\n{p['other']['text'][:MAX_CHARS]}")
    return "\n\n".join(out)


def compare(engine, topic, ref, lang, date, pairs, chat_fn=None):
    """Ask the model, check every quote against the revision text, repair failed quotes once, report both passes."""
    chat_fn = chat_fn or (lambda msgs: chat(engine, msgs))
    messages = [{"role": "system", "content": SYSTEM},
                {"role": "user", "content": PROMPT.format(topic=topic, ref=ref, lang=lang, date=date,
                                                          ref_name=LANG_NAMES.get(ref, ref), lang_name=LANG_NAMES.get(lang, lang),
                                                          blocks=_blocks(pairs))}]
    t0 = time.monotonic()
    raw = chat_fn(messages)
    try:
        data = parse_json(raw)
    except ValueError:   # one retry with an explicit reminder; models sometimes wrap the JSON in prose
        messages += [{"role": "assistant", "content": raw[:4000]},
                     {"role": "user", "content": "That was not valid JSON. Return ONLY the JSON object."}]
        try:
            data = parse_json(chat_fn(messages))
        except ValueError:
            raise EngineError("The model did not return valid JSON twice; try again.")
    calls = 1 + (len(messages) > 2)
    items = []
    for it in data.get("pairs") or []:
        try:
            n = int(it.get("n"))
        except (TypeError, ValueError):
            continue
        if not 1 <= n <= len(pairs) or any(x["n"] == n for x in items):
            continue
        kind = str(it.get("kind") or "").lower()
        items.append({"n": n, "event": str(it.get("event") or "")[:120], "kind": kind if kind in KINDS else "emphasis",
                      "explanation": str(it.get("explanation") or "")[:600],
                      "quote_a": str(it.get("quote_a") or ""), "quote_b": str(it.get("quote_b") or ""),
                      "quote_b_en": str(it.get("quote_b_en") or "")[:400]})

    def check():
        bad = []
        for it in items:
            p = pairs[it["n"] - 1]
            it["ok_a"] = grounded(it["quote_a"], p["ref"]["text"])
            it["ok_b"] = grounded(it["quote_b"], p["other"]["text"])
            bad += [(it, "a")] * (not it["ok_a"] and it["kind"] != "none") + [(it, "b")] * (not it["ok_b"] and it["kind"] != "none")
        return bad

    def tally():
        quotes = [ok for it in items if it["kind"] != "none" for ok in (it["ok_a"], it["ok_b"])]
        return {"verified": sum(quotes), "quotes": len(quotes)}

    bad = check()
    first = tally()
    if bad:
        listing = "\n\n".join(
            f"n={it['n']} side={side}: you wrote \"{it['quote_' + side]}\"\nParagraph {side.upper()}:\n"
            f"{pairs[it['n'] - 1]['ref' if side == 'a' else 'other']['text'][:MAX_CHARS]}" for it, side in bad)
        try:
            fixes = parse_json(chat_fn([{"role": "system", "content": SYSTEM},
                                        {"role": "user", "content": REPAIR.format(items=listing)}])).get("fixes") or []
            calls += 1
        except (ValueError, EngineError):
            fixes = []
        by_n = {it["n"]: it for it in items}
        for f in fixes:
            it = by_n.get(f.get("n") if isinstance(f.get("n"), int) else -1)
            if it and f.get("side") in ("a", "b"):
                it["quote_" + f["side"]] = str(f.get("quote") or "")
        check()
    final = tally()
    for it in items:   # a quote that still fails is not evidence: keep the claim, drop the words
        it["repaired"] = bool(bad)
        for side in ("a", "b"):
            if not it["ok_" + side]:
                it["unverified_" + side] = it["quote_" + side]
                it["quote_" + side] = ""
    return {"items": sorted(items, key=lambda x: x["n"]), "summary": str(data.get("summary") or "")[:1200],
            "check": {"first_pass": first, "after_repair": final, "repair_round": bool(bad)},
            "calls": calls, "seconds": round(time.monotonic() - t0, 1)}


# ---------- data from Kielipeili ----------
def pick_pairs(pairs, n, min_chars=200):
    """The shared passages told most differently: mutual nearest neighbours with the lowest cosine, long enough to
    carry framing, back in article order."""
    cands = [p for p in pairs if min(p["fi"]["chars"], p["match"]["chars"]) >= min_chars] or list(pairs)
    chosen = sorted(cands, key=lambda p: p["sim"])[:n]
    return sorted(chosen, key=lambda p: p["fi"]["ord"])


def revisions(topic, t):
    from app.db import rows
    out = rows("""SELECT s.lang, s.rev_id, s.title, s.ts FROM lens_snapshot s WHERE s.topic = %s
                  AND s.ts = (SELECT MAX(ts) FROM lens_snapshot x WHERE x.topic = s.topic AND x.lang = s.lang AND x.ts <= %s)""",
               (topic, t))
    return {r["lang"]: {"rev_id": r["rev_id"], "title": r["title"], "ts": str(r["ts"]),
                        "url": f"https://{r['lang']}.wikipedia.org/?oldid={r['rev_id']}"} for r in out}


def engine_label(engine):
    return NEMOTRON_LABEL if engine == "nemotron" else f"Claude ({CLAUDE_MODEL})"


@bp.get("/status")
def api_status():
    return jsonify({"nemotron": nemotron_configured(), "claude": claude_configured(), "default": default_engine(),
                    "model": model(), "label": NEMOTRON_LABEL})


_results = {}


@bp.get("/frame")
def api_frame():
    from app import kielipeili as K
    topic, lang = request.args.get("topic"), request.args.get("lang")
    if not topic or not lang:
        return jsonify({"error": "topic and lang are needed"}), 400
    ref = request.args.get("ref") or K.editions(topic)[1]
    if ref == lang:
        return jsonify({"error": "pick two different editions"}), 400
    engine = request.args.get("engine") or default_engine()
    if engine not in ("nemotron", "claude"):
        return jsonify({"error": "engine must be nemotron or claude",
                        "configured": False}), 400
    if engine == "nemotron" and not nemotron_configured():
        return jsonify({"error": "Nemotron is not configured on this server (NVIDIA_API_KEY is not set). Pick Claude, "
                                 "or set the key and restart.", "engine": engine, "label": NEMOTRON_LABEL,
                        "configured": False}), 503
    n = max(1, min(MAX_PAIRS, int(request.args.get("n") or 4)))
    t = K.moment(request.args.get("at"))
    rk = (topic, lang, ref, t[:10], engine, n)
    if rk in _results:
        return jsonify({**_results[rk], "cached": True})
    al = K.alignment(topic, lang, t, ref)
    pairs = [{"ref": p["fi"], "other": p["match"], "sim": p["sim"]} for p in pick_pairs(al["pairs"], n)]
    if not pairs:
        return jsonify({"error": "these two editions share no aligned paragraphs at this moment"}), 404
    try:
        res = compare(engine, topic, ref, lang, t[:10], pairs)
    except EngineError as e:
        return jsonify({"error": str(e), "engine": engine, "label": engine_label(engine)}), e.status
    revs = revisions(topic, t)
    for it in res["items"]:
        p = pairs[it["n"] - 1]
        it.update(sim=round(p["sim"], 3), section_a=p["ref"]["section"], section_b=p["other"]["section"],
                  text_a=p["ref"]["text"], text_b=p["other"]["text"])
    out = {**res, "topic": topic, "lang": lang, "ref": ref, "at": t, "engine": engine, "label": engine_label(engine),
           "model": model() if engine == "nemotron" else CLAUDE_MODEL, "revisions": {k: revs.get(k) for k in (ref, lang)},
           "n_pairs_aligned": len(al["pairs"])}
    _results[rk] = out
    return jsonify(out)
