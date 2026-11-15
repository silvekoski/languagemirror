"""Precompute "Three Wikipedias": one row per topic (a Finnish article and its Swedish / English
counterparts with the same Wikidata id) into viz_polyglot_pairs, plus viz_polyglot_stats.

    nice -n 10 .venv/bin/python -m scripts.build_polyglot        (~40 s, idempotent)

1. MariaDB does the cross-language work: a self-join of current_article on wikidata_id, and
   VEC_DISTANCE_COSINE between the bge-m3 vectors of the same topic in fi/sv/en (PAIRS_SQL).
2. Python adds per-topic context: the Finnish article's theme (its top-level category under
   Luokka:Suomen historia), its edit history from `revision`, a length-adjusted distance (the
   residual of a least-squares fit of distance on length mismatch), and the cross-language
   retrieval rank (how many articles of the other language sit closer to the Finnish vector than
   its own counterpart does; computed in numpy from the same MariaDB vectors).
"""
import json, math, time
from collections import Counter, defaultdict, deque
import numpy as np
from wikitime.db import connect

TABLE_SQL = """CREATE OR REPLACE TABLE viz_polyglot_pairs (
  fi_page INT UNSIGNED PRIMARY KEY, wikidata_id VARCHAR(20),
  sv_page INT UNSIGNED, en_page INT UNSIGNED,
  fi_title VARCHAR(255), sv_title VARCHAR(255), en_title VARCHAR(255),
  fi_len INT, sv_len INT, en_len INT,
  d_fi_en DOUBLE, d_fi_sv DOUBLE, d_sv_en DOUBLE,
  r_fi_en DOUBLE, r_fi_sv DOUBLE, r_sv_en DOUBLE,
  rank_en INT, rank_sv INT,
  theme VARCHAR(60), theme_fi VARCHAR(120),
  versions INT, editors INT, first_year SMALLINT,
  KEY (wikidata_id), KEY (sv_page), KEY (en_page), KEY (theme))"""

# The query the page shows under "The SQL": the distances are computed by MariaDB.
PAIRS_SQL = """INSERT INTO viz_polyglot_pairs
  (fi_page, wikidata_id, sv_page, en_page, fi_title, sv_title, en_title,
   fi_len, sv_len, en_len, d_fi_en, d_fi_sv, d_sv_en)
SELECT f.page_id, f.wikidata_id, s.page_id, e.page_id, f.title, s.title, e.title,
       CHAR_LENGTH(f.text), CHAR_LENGTH(s.text), CHAR_LENGTH(e.text),
       VEC_DISTANCE_COSINE(fv.embedding, ev.embedding),
       VEC_DISTANCE_COSINE(fv.embedding, sv.embedding),
       VEC_DISTANCE_COSINE(sv.embedding, ev.embedding)
FROM current_article f
LEFT JOIN current_article s ON s.lang = 'sv' AND s.wikidata_id = f.wikidata_id
LEFT JOIN current_article e ON e.lang = 'en' AND e.wikidata_id = f.wikidata_id
JOIN      article_vector fv ON fv.lang = 'fi' AND fv.page_id = f.page_id
LEFT JOIN article_vector sv ON sv.lang = 'sv' AND sv.page_id = s.page_id
LEFT JOIN article_vector ev ON ev.lang = 'en' AND ev.page_id = e.page_id
WHERE f.lang = 'fi'"""

# English glosses of the top-level categories under Luokka:Suomen historia (originals kept in theme_fi).
GLOSS = {
    "Suomen poliittinen historia": "Political history", "Suomen sotahistoria": "Military history",
    "Suomen kaupunkien historia": "Towns", "Suomen taloushistoria": "Economic history",
    "Suomen suuriruhtinaskunta": "Grand Duchy 1809–1917", "Itsenäisen Suomen historia": "Independent Finland",
    "Luovutetut alueet": "Ceded territories", "Suomalaiset lakkautetut lehdet": "Defunct newspapers",
    "Suomen historia maakunnittain": "Regional history", "Inkeri": "Ingria",
    "Suomen liikenteen historia": "Transport", "Suomen entiset rakennukset ja rakennelmat": "Lost buildings",
    "Suomen ulkopolitiikka": "Foreign policy", "Suomen kulttuurihistoria": "Cultural history",
    "Suomen asutus- ja yhteiskuntahistoria": "Settlement & society",
    "Historialliset alueet Suomessa": "Historical regions", "Suomen esihistoria": "Prehistory",
    "Kristinuskon historia Suomessa": "Church history", "Onnettomuudet Suomessa": "Disasters",
    "Suomen paikallishistoria": "Local history", "Suomen muinaisjäännökset": "Ancient remains",
    "Suomen keskiaika": "Middle Ages", "Entiset suomalaiset järjestöt": "Defunct organisations",
    "Suomen rikoshistoria": "Crime", "Karjalaiset (kansa)": "Karelians",
    "Ruotsin vallan aika Suomessa": "Swedish era", "Kirjat Suomen historiasta": "Books on history",
    "Suomen oikeushistoria": "Legal history",
}
MIN_THEME = 100     # smaller top-level categories are pooled as "Other"


def bulk_update(cur, cols, data):
    """UPDATE viz_polyglot_pairs from many (values..., fi_page) tuples in one statement: load them into a
    temporary table with multi-row INSERTs, then UPDATE ... JOIN (row-by-row UPDATEs are far slower)."""
    cur.execute("CREATE OR REPLACE TEMPORARY TABLE tmp_pg (fi_page INT UNSIGNED PRIMARY KEY, "
                + ", ".join(f"{c} {t}" for c, t in cols) + ")")
    names = [c for c, _ in cols]
    cur.executemany(f"INSERT INTO tmp_pg ({', '.join(names)}, fi_page) VALUES ({', '.join(['%s'] * (len(names) + 1))})", data)
    cur.execute("UPDATE viz_polyglot_pairs p JOIN tmp_pg t USING (fi_page) SET "
                + ", ".join(f"p.{c} = t.{c}" for c in names))
    cur.execute("DROP TEMPORARY TABLE tmp_pg")


def themes(cur):
    """Each Finnish article -> its top-level category under 'Suomen historia' (BFS up the category
    tree; each of the article's categories votes for the top levels it reaches, nearer counts more)."""
    cur.execute("SELECT parent, child FROM category_link")
    parents, tops = defaultdict(set), set()
    for p, c in cur.fetchall():
        parents[c].add(p)
        if p == "Suomen historia":
            tops.add(c)
    memo = {}

    def up(c):
        if c not in memo:
            seen, q, out = {c}, deque([(c, 0)]), {}
            while q:
                x, d = q.popleft()
                if x in tops:
                    out.setdefault(x, d)
                for p in parents.get(x, ()):
                    if p not in seen:
                        seen.add(p)
                        q.append((p, d + 1))
            memo[c] = out
        return memo[c]

    cur.execute("SELECT page_id, category FROM article_category WHERE lang='fi'")
    votes = defaultdict(Counter)
    for p, c in cur.fetchall():
        for t, d in up(c).items():
            votes[p][t] += 1 / (1 + d)
    return {p: v.most_common(1)[0][0] for p, v in votes.items() if v}


def vectors(cur, lang, ids):
    cur.execute("SELECT page_id, embedding FROM article_vector WHERE lang=%s", (lang,))
    got = {p: np.frombuffer(e, dtype="<f4") for p, e in cur.fetchall()}
    keep = [p for p in ids if p in got]
    m = np.stack([got[p] for p in keep]).astype(np.float32)
    m /= np.linalg.norm(m, axis=1, keepdims=True)
    return keep, m


def ranks(cur, other):
    """rank 1 = among all `other`-language articles, the counterpart is the nearest to the Finnish vector."""
    cur.execute(f"SELECT fi_page, {other}_page, d_fi_{other} FROM viz_polyglot_pairs WHERE {other}_page IS NOT NULL")
    pairs = cur.fetchall()
    cur.execute("SELECT page_id FROM article_vector WHERE lang=%s", (other,))
    oids, om = vectors(cur, other, [r[0] for r in cur.fetchall()])
    oidx = {p: i for i, p in enumerate(oids)}
    fids, fm = vectors(cur, "fi", [r[0] for r in pairs])
    fidx = {p: i for i, p in enumerate(fids)}
    out, sims_all = [], []
    for k in range(0, len(pairs), 1000):
        chunk = [r for r in pairs[k:k + 1000] if r[0] in fidx and r[1] in oidx]
        S = fm[[fidx[r[0]] for r in chunk]] @ om.T                       # cosine similarity
        own = S[np.arange(len(chunk)), [oidx[r[1]] for r in chunk]]
        rk = (S > own[:, None] + 1e-6).sum(1) + 1
        out += [(int(rk[i]), r[0]) for i, r in enumerate(chunk)]
        sims_all.append(S.mean())
    baseline = 1 - float(np.mean(sims_all))     # mean distance of a Finnish article to ANY other-language article
    return out, baseline


def residuals(cur, a, b):
    """distance minus what length mismatch alone predicts: d ~ 1 + |log2(len_b/len_a)| + log2(min len)."""
    cur.execute(f"""SELECT fi_page, d_{a}_{b}, {a}_len, {b}_len FROM viz_polyglot_pairs
                    WHERE d_{a}_{b} IS NOT NULL AND {a}_len > 0 AND {b}_len > 0""")
    r = cur.fetchall()
    d = np.array([x[1] for x in r])
    la, lb = np.array([x[2] for x in r], float), np.array([x[3] for x in r], float)
    X = np.stack([np.ones_like(d), np.abs(np.log2(lb / la)), np.log2(np.minimum(la, lb))], 1)
    coef, *_ = np.linalg.lstsq(X, d, rcond=None)
    res = d - X @ coef
    r2 = 1 - (res ** 2).sum() / ((d - d.mean()) ** 2).sum()
    bulk_update(cur, [(f"r_{a}_{b}", "DOUBLE")], [(float(res[i]), r[i][0]) for i in range(len(r))])
    return {"coef": [round(float(c), 5) for c in coef], "r2": round(float(r2), 4), "n": len(r)}


def main():
    t0 = time.time()
    con = connect()
    con.autocommit(True)
    cur = con.cursor()
    cur.execute(TABLE_SQL)
    cur.execute(PAIRS_SQL)
    print(f"pairs: {cur.rowcount} topics, {time.time() - t0:.1f}s")

    th = themes(cur)
    size = Counter(th.values())
    cur.execute("SELECT fi_page FROM viz_polyglot_pairs")
    upd = []
    for (p,) in cur.fetchall():
        t = th.get(p)
        if t is None:
            upd.append(("Uncategorised", None, p))
        else:
            upd.append((GLOSS.get(t, t) if size[t] >= MIN_THEME else "Other", t, p))
    bulk_update(cur, [("theme", "VARCHAR(60)"), ("theme_fi", "VARCHAR(120)")], upd)
    print(f"themes: {time.time() - t0:.1f}s")

    cur.execute("""UPDATE viz_polyglot_pairs p JOIN (
                     SELECT page_id, COUNT(*) n, COUNT(DISTINCT user) u, YEAR(MIN(ts)) y
                     FROM revision GROUP BY page_id) r ON r.page_id = p.fi_page
                   SET p.versions = r.n, p.editors = r.u, p.first_year = r.y""")
    print(f"history: {time.time() - t0:.1f}s")

    stats = {"fit": {}, "baseline": {}}
    for a, b in (("fi", "en"), ("fi", "sv"), ("sv", "en")):
        stats["fit"][f"{a}_{b}"] = residuals(cur, a, b)
    for other in ("en", "sv"):
        rk, base = ranks(cur, other)
        bulk_update(cur, [(f"rank_{other}", "INT")], rk)
        stats["baseline"][f"fi_{other}"] = round(base, 4)
    print(f"ranks/fits: {time.time() - t0:.1f}s")

    cur.execute("CREATE OR REPLACE TABLE viz_polyglot_stats (k VARCHAR(40) PRIMARY KEY, v JSON)")
    cur.executemany("INSERT INTO viz_polyglot_stats VALUES (%s, %s)",
                    [(k, json.dumps(v)) for k, v in stats.items()] + [("pairs_sql", json.dumps(PAIRS_SQL))])
    print(json.dumps(stats, indent=1))
    print(f"done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
