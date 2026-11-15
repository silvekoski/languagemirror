"""Kielipeili, step 2: split every fetched version into paragraph chunks, embed them with bge-m3 and load
them into MariaDB.

lens_chunk is SYSTEM-VERSIONED with a VECTOR INDEX. Each chunk row is valid from the save time of the
first sampled version that contains it until the save time of the first later sampled version that
no longer does (system_versioning_insert_history). So
    SELECT ... FROM lens_chunk FOR SYSTEM_TIME AS OF '2012-01-01'
returns every language's article as it stood then, and the cross-language score is plain SQL.

Runs in the CPU embedding venv (torch + sentence-transformers):
    .venv-embed/bin/python -m scripts.lens_build"""
import hashlib, json, os, pathlib, pickle, re
from datetime import datetime

import numpy as np
from wikitime.db import connect
from wikitime.wikitext import clean

RAW = pathlib.Path("data/lens/raw")
CACHE = pathlib.Path("data/lens/emb_cache.pkl")
MIN_CHARS, MAX_CHARS = 280, 1400

# Headings that start the end matter (sources, links, literature) in our six languages.
STOP = re.compile(r"^(lähteet|viitteet|kirjallisuutta|kirjallisuus|aiheesta muualla|katso myös|"
                  r"källor|referenser|se även|externa länkar|litteratur|noter|"
                  r"references|notes|see also|external links|further reading|bibliography|sources|citations|"
                  r"einzelnachweise|weblinks|literatur|anmerkungen|siehe auch|quellen|"
                  r"примечания|литература|ссылки|источники|см\. также|"
                  r"примітки|джерела|посилання|див\. також|література)$", re.I)


def chunks(wikitext):
    """[(section, text)] paragraph chunks of MIN..MAX chars, end matter dropped."""
    out, buf, section = [], [], ""

    def flush():
        if buf:
            text = " ".join(buf).strip()
            if len(text) >= 80:
                out.append((section, text))
            buf.clear()

    for kind, text in clean(wikitext):
        text = re.sub(r"\s+", " ", text).strip()
        if kind == "h":
            flush()
            if STOP.match(text):
                break
            section = text[:250]
            continue
        if not text or len(text) < 3:
            continue
        # split very long paragraphs at sentence ends
        while len(text) > MAX_CHARS:
            cut = text.rfind(". ", 0, MAX_CHARS)
            cut = cut + 1 if cut > MIN_CHARS else MAX_CHARS
            buf.append(text[:cut]); flush(); text = text[cut:].strip()
        buf.append(text)
        if sum(map(len, buf)) >= MIN_CHARS:
            flush()
    flush()
    return out


def snapshots(topic, lang):
    """[(ts, rev_id, title, wikitext)] sorted by save time, deduplicated by revision."""
    seen, out = set(), []
    for f in (RAW / topic / lang).glob("*.json"):
        pages = json.loads(f.read_text()).get("query", {}).get("pages", [])
        if not pages or "revisions" not in pages[0]:
            continue
        rev = pages[0]["revisions"][0]
        if rev["revid"] in seen:
            continue
        seen.add(rev["revid"])
        ts = datetime.strptime(rev["timestamp"], "%Y-%m-%dT%H:%M:%SZ")
        out.append((ts, rev["revid"], pages[0]["title"], rev["slots"]["main"].get("content", "")))
    return sorted(out)


def main():
    from sentence_transformers import SentenceTransformer
    import torch
    torch.set_num_threads(max(1, torch.get_num_threads()))
    model = SentenceTransformer("BAAI/bge-m3", device="cpu")
    model.max_seq_length = 512
    cache = pickle.loads(CACHE.read_bytes()) if CACHE.exists() else {}

    meta = json.loads((RAW / "meta.json").read_text())
    rows, snaps = [], []
    for topic, m in meta.items():
        for lang in m["titles"]:
            history = snapshots(topic, lang)
            if not history:
                continue
            # chunk rows: one per contiguous run of sampled versions that contain the chunk
            open_runs = {}   # sha1 -> [start_ts, ord, section, text, rev_id]
            for i, (ts, rev_id, title, wt) in enumerate(history):
                cs = chunks(wt)
                snaps.append((topic, lang, ts, rev_id, title, sum(len(t) for _, t in cs), len(cs),
                              i == len(history) - 1))
                present = {}
                for ordn, (section, text) in enumerate(cs):
                    present.setdefault(hashlib.sha1(text.encode()).hexdigest(), (ordn, section, text))
                for h in list(open_runs):
                    if h not in present:
                        s = open_runs.pop(h)
                        rows.append((topic, lang, *s[1:4], h, s[4], s[0], ts))
                for h, (ordn, section, text) in present.items():
                    if h in open_runs:
                        open_runs[h][1:3] = [ordn, section]   # keep the latest position
                        open_runs[h][4] = rev_id
                    else:
                        open_runs[h] = [ts, ordn, section, text, rev_id]
            for h, s in open_runs.items():
                rows.append((topic, lang, *s[1:4], h, s[4], s[0], None))
        print(topic, "chunk rows so far:", len(rows), flush=True)

    if os.environ.get("LENS_CURRENT_ONLY"):
        rows = [r for r in rows if r[8] is None]
    todo = sorted({r[5]: r[4] for r in rows if r[5] not in cache}.items())
    print(f"embedding {len(todo)} new chunks ({len(cache)} cached)", flush=True)
    for i in range(0, len(todo), 64):
        part = todo[i:i + 64]
        vecs = model.encode([t for _, t in part], batch_size=16, normalize_embeddings=True)
        for (h, _), v in zip(part, vecs):
            cache[h] = np.asarray(v, dtype="<f4").tobytes()
        if i % 320 == 0:
            CACHE.write_bytes(pickle.dumps(cache))
            print(f"  {i + len(part)}/{len(todo)}", flush=True)
    CACHE.write_bytes(pickle.dumps(cache))

    con = connect()
    cur = con.cursor()
    cur.execute("DROP TABLE IF EXISTS lens_chunk")
    cur.execute("""CREATE TABLE lens_chunk (
        id INT AUTO_INCREMENT,
        topic VARCHAR(100) NOT NULL, lang CHAR(3) NOT NULL, ord INT NOT NULL,
        section VARCHAR(255) NOT NULL, text MEDIUMTEXT NOT NULL, chars INT NOT NULL,
        sha1 CHAR(40) NOT NULL, rev_id BIGINT NOT NULL,
        emb VECTOR(1024) NOT NULL,
        row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
        row_end TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
        PERIOD FOR SYSTEM_TIME (row_start, row_end),
        PRIMARY KEY (id), KEY (topic, lang),
        VECTOR INDEX (emb) M=16 DISTANCE=cosine
    ) WITH SYSTEM VERSIONING""")
    cur.execute("SET system_versioning_insert_history = 1")
    # explicit ids: AUTO_INCREMENT is not applied under system_versioning_insert_history
    H = ("INSERT INTO lens_chunk (id, topic, lang, ord, section, text, chars, sha1, rev_id, emb, row_start, row_end)"
         " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)")
    C = ("INSERT INTO lens_chunk (id, topic, lang, ord, section, text, chars, sha1, rev_id, emb, row_start)"
         " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)")
    for n, (topic, lang, ordn, section, text, h, rev_id, start, end) in enumerate(rows, 1):
        args = (n, topic, lang, ordn, section, text, len(text), h, rev_id, cache[h], start)
        if end is None:
            cur.execute(C, args)
        elif end > start:
            cur.execute(H, (*args, end))
    cur.execute("DROP TABLE IF EXISTS lens_snapshot")
    cur.execute("""CREATE TABLE lens_snapshot (
        topic VARCHAR(100) NOT NULL, lang CHAR(3) NOT NULL, ts DATETIME NOT NULL, rev_id BIGINT NOT NULL,
        title VARCHAR(255) NOT NULL, chars INT NOT NULL, n_chunks INT NOT NULL, is_current BOOL NOT NULL,
        PRIMARY KEY (topic, lang, ts))""")
    cur.executemany("INSERT IGNORE INTO lens_snapshot VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", snaps)
    cur.execute("DROP TABLE IF EXISTS lens_topic")
    cur.execute("""CREATE TABLE lens_topic (topic VARCHAR(100) PRIMARY KEY, wikidata VARCHAR(20),
        titles JSON NOT NULL)""")
    cur.executemany("INSERT INTO lens_topic VALUES (%s,%s,%s)",
                    [(t, m["wikidata"], json.dumps(m["titles"], ensure_ascii=False)) for t, m in meta.items()])
    con.commit()
    cur.execute("SELECT COUNT(*) FROM lens_chunk FOR SYSTEM_TIME ALL")
    print("lens_chunk rows (all time):", cur.fetchone()[0], flush=True)


if __name__ == "__main__":
    main()
