"""Kielipeili, step 3: Claude reads the aligned paragraphs of each language pair (Finnish = reference) and
flags conflicting facts and framing differences. Every quote must be an exact substring of the stored
chunk text; we check that here and mark each item verified or not. Results go to lens_analysis.
Uses the `claude` CLI (headless).    uv run python -m scripts.lens_analyze [--topic T] [--lang L] [--force]"""
import argparse, json, re, subprocess
from concurrent.futures import ThreadPoolExecutor

from app import kielipeili as K
from wikitime.db import connect

MODEL = "claude-opus-5-5"
NAMES = {"fi": "Finnish", "sv": "Swedish", "en": "English", "de": "German", "ru": "Russian", "uk": "Ukrainian"}

PROMPT = """You compare two language versions of the same Wikipedia article. The {ref_name} version is the reference.
Article: {topic}. Other language: {lang_name}.

Below are paragraph pairs that a multilingual embedding model aligned (FI = {ref_name} paragraph, XX = its nearest
{lang_name} paragraph, sim = cosine similarity), then {ref_name} paragraphs with no {lang_name} counterpart, then
{lang_name} paragraphs with no {ref_name} counterpart.

Find, for a reader who wants to know how the {lang_name} Wikipedia presents this topic differently:
1. "facts": concrete factual disagreements on the same point (numbers, dates, names, outcomes, causes).
2. "framing": the same events told differently. Classify each as
   "audience" (acceptable: extra context because the readership differs, e.g. explaining local terms),
   "emphasis" (what is foregrounded or played down), "loaded" (evaluative or one-sided wording, blame,
   euphemism), or "omission" (an important point present in one version and absent in the other).
3. "missing": up to 5 of the most significant {ref_name} points absent from the {lang_name} version.
4. "only_here": up to 5 of the most significant points that only the {lang_name} version has.

Rules:
- Every "fi" and "other" quote MUST be copied exactly, character for character, from the paragraphs below
  (a short contiguous span, max 200 characters). Never paraphrase inside a quote. Use "" if there is no quote.
- Add English translations in "fi_en" and "other_en".
- Prefer the few differences that matter most (max 8 facts, max 10 framing). No trivia (spelling, style).
- "agreement": 0-100, how consistent the {lang_name} version is with the {ref_name} one on facts and framing of
  the content they share (100 = same facts, same framing). Do not penalise mere length differences.
- "summary": two plain sentences in English on how the {lang_name} version differs.

Return ONLY a JSON object, no prose, no code fence:
{{"agreement": int, "summary": str,
 "facts": [{{"pair": int, "fi": str, "other": str, "fi_en": str, "other_en": str, "issue": str}}],
 "framing": [{{"pair": int|null, "fi": str, "other": str, "fi_en": str, "other_en": str, "kind": str, "note": str}}],
 "missing": [{{"section": str, "fi": str, "fi_en": str, "note": str}}],
 "only_here": [{{"section": str, "other": str, "other_en": str, "note": str}}]}}

ALIGNED PAIRS
{pairs}

{ref_name_upper} ONLY
{fi_only}

{lang_name_upper} ONLY
{other_only}
"""


def cut(t, n=900):
    return t if len(t) <= n else t[:n] + " …"


def build_prompt(topic, lang, al, ref="fi"):
    pairs = "\n\n".join(f"[pair {i}] sim={p['sim']:.2f}\nFI: {cut(p['fi']['text'])}\nXX: {cut(p['match']['text'])}"
                        for i, p in enumerate(al["pairs"][:45]))
    fi_only = "\n\n".join(f"[{c['section'] or '-'}] {cut(c['text'], 600)}" for c in al["fi_only"][:20])
    other_only = "\n\n".join(f"[{c['section'] or '-'}] {cut(c['text'], 600)}" for c in al["other_only"][:20])
    return PROMPT.format(topic=topic, lang_name=NAMES[lang], lang_name_upper=NAMES[lang].upper(),
                         ref_name=NAMES[ref], ref_name_upper=NAMES[ref].upper(),
                         pairs=pairs, fi_only=fi_only or "(none)", other_only=other_only or "(none)")


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def verify(result, al):
    fi_text = norm(" ".join(c["text"] for c in al["fi_all"]))
    other_text = norm(" ".join(c["text"] for c in al["other_all"]))
    for key in ("facts", "framing", "missing", "only_here"):
        for item in result.get(key, []):
            ok = True
            if item.get("fi"):
                ok &= norm(item["fi"]).rstrip("…").strip() in fi_text
            if item.get("other"):
                ok &= norm(item["other"]).rstrip("…").strip() in other_text
            item["verified"] = bool(ok)
    return result


def analyze(topic, lang, ref="fi"):
    al = K.alignment(topic, lang, ref=ref)
    if not al["pairs"]:
        return topic, lang, None
    out = subprocess.run(["claude", "-p", "--model", MODEL, "--output-format", "json"],
                         input=build_prompt(topic, lang, al, ref), capture_output=True, text=True, timeout=900)
    text = json.loads(out.stdout)["result"].strip()
    text = re.sub(r"^```(?:json)?|```$", "", text).strip()
    result = verify(json.loads(text[text.find("{"):text.rfind("}") + 1]), al)
    return topic, lang, result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic"); ap.add_argument("--lang"); ap.add_argument("--force", action="store_true")
    ap.add_argument("--ref", default="fi", help="reference language (default fi)")
    a = ap.parse_args()
    con = connect(); cur = con.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS lens_analysis (topic VARCHAR(100), lang CHAR(3), model VARCHAR(50),
        result JSON NOT NULL, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (topic, lang))""")
    cur.execute("SHOW COLUMNS FROM lens_analysis LIKE 'ref'")
    if not cur.fetchall():   # older tables: one Finnish-reference review per (topic, lang)
        cur.execute("ALTER TABLE lens_analysis ADD ref CHAR(3) NOT NULL DEFAULT 'fi' AFTER topic, DROP PRIMARY KEY, ADD PRIMARY KEY (topic, ref, lang)")
    cur.execute("SELECT topic, lang FROM lens_analysis WHERE ref = %s", (a.ref,)); done = set(cur.fetchall())
    cur.execute("SELECT DISTINCT topic, lang FROM lens_chunk WHERE lang <> %s", (a.ref,))
    jobs = [(t, l) for t, l in cur.fetchall()
            if (not a.topic or t == a.topic) and (not a.lang or l == a.lang) and (a.force or (t, l) not in done)]
    con.commit()
    print(len(jobs), "pairs to analyse", flush=True)

    def run(j):
        try:
            return analyze(*j, ref=a.ref)
        except Exception as e:  # noqa: BLE001 - report and continue with the others
            print("FAILED", j, repr(e)[:300], flush=True)
            return j[0], j[1], None

    with ThreadPoolExecutor(6) as ex:
        for topic, lang, result in ex.map(run, jobs):
            if result is None:
                continue
            c = connect(); cc = c.cursor()
            cc.execute("REPLACE INTO lens_analysis (topic, ref, lang, model, result) VALUES (%s,%s,%s,%s,%s)",
                       (topic, a.ref, lang, MODEL, json.dumps(result, ensure_ascii=False)))
            c.commit(); c.close()
            v = sum(i["verified"] for k in ("facts", "framing") for i in result.get(k, []))
            n = sum(len(result.get(k, [])) for k in ("facts", "framing"))
            print(f"{topic} / {a.ref}-{lang}: agreement {result.get('agreement')}, {v}/{n} quotes verified", flush=True)


if __name__ == "__main__":
    main()
