"""Precompute "How fast does Wikipedia heal?" into viz_immune_* tables.

    nice -n 10 .venv/bin/python -m scripts.build_immune        (~1 min, idempotent)

A version is a revert when its text (sha1) equals an earlier version of the page but not the previous one
(revision.is_revert). The version it restores is the most recent earlier version with the same sha1; every
version strictly in between was undone ("a bad version"). Its lifetime is the revert's time minus the bad
version's own edit time. Self-reverts (the reverter undoing their own versions) are left out: that is an
editor fixing their own slip, not the community healing. Reverts that undo more than MAX_SPAN versions
(restorations of years-old text) or restore an empty page are skipped, as in build_editwars.

Editor kinds of the bad version: temp (temporary account, name like '~2025-12345-6', Wikipedia's 2025 replacement
for IP editing), anon (IP address), bot (name ends in 'bot'), reg (registered).

Tables
  viz_immune_bad        one row per undone version (the facts everything else is aggregated from)
  viz_immune_year       per year of the bad edit: count, lifetime quantiles, kind split, all edits per kind
  viz_immune_year_bin   per year x log10-lifetime bin: count (violins)
  viz_immune_hist       log10-lifetime bin x kind: count (lifetime histogram)
  viz_immune_hour       Helsinki hour: all edits, bad edits made, reverts made
  viz_immune_article    most reverted articles
  viz_immune_meta       headline numbers (JSON)
"""
import json, time
import numpy as np
from wikitime.db import connect

MAX_SPAN = 50
BIN = 0.25                     # log10(seconds) bin width
NBIN = 38                      # 10^0 .. 10^9.5 s (1 s .. ~100 years)
TZ = "Europe/Helsinki"


def main():
    t0 = time.time()
    con = connect()
    con.autocommit(True)
    cur = con.cursor()

    def q(sql, params=None):
        cur.execute(sql, params)
        return cur.fetchall()

    def log(msg):
        print(f"{msg:40s} {time.time()-t0:5.0f}s", flush=True)

    q("DROP TEMPORARY TABLE IF EXISTS viz_immune_tmp_seq")
    q("""CREATE TEMPORARY TABLE viz_immune_tmp_seq AS
         SELECT page_id, rev_id, ts, user, anonymous, bytes, is_revert,
                ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY ts, rev_id) AS seq,
                LAG(rev_id) OVER (PARTITION BY page_id, sha1 ORDER BY ts, rev_id) AS same_prev
         FROM revision""")
    q("ALTER TABLE viz_immune_tmp_seq ADD PRIMARY KEY (page_id, seq), ADD KEY (rev_id)")
    log("sequenced versions")

    q("DROP TEMPORARY TABLE IF EXISTS viz_immune_tmp_rv")
    q(f"""CREATE TEMPORARY TABLE viz_immune_tmp_rv AS
          SELECT t.page_id, t.rev_id, t.ts, t.user, t.seq, p.seq AS pseq
          FROM viz_immune_tmp_seq t JOIN viz_immune_tmp_seq p ON p.rev_id = t.same_prev
          WHERE t.is_revert = 1 AND t.bytes > 0 AND t.seq - p.seq - 1 BETWEEN 1 AND {MAX_SPAN}""")
    q("ALTER TABLE viz_immune_tmp_rv ADD PRIMARY KEY (rev_id)")
    log("reverts found")

    kind_sql = """CASE WHEN r.user REGEXP '^~[0-9]{4}-' THEN 'temp' WHEN r.anonymous THEN 'anon'
                       WHEN LOWER(r.user) LIKE '%%bot' THEN 'bot' ELSE 'reg' END"""
    q("DROP TABLE IF EXISTS viz_immune_bad")
    q("""CREATE TABLE viz_immune_bad (
           rev_id INT UNSIGNED PRIMARY KEY COMMENT 'the undone version',
           page_id INT UNSIGNED NOT NULL, ts DATETIME NOT NULL COMMENT 'when the bad version was saved (UTC)',
           kind ENUM('reg','anon','temp','bot') NOT NULL COMMENT 'who saved it',
           revert_rev_id INT UNSIGNED NOT NULL, revert_ts DATETIME NOT NULL,
           lifetime_s INT UNSIGNED NOT NULL COMMENT 'revert_ts - ts',
           h_edit TINYINT NOT NULL COMMENT 'Helsinki hour of the bad edit',
           h_revert TINYINT NOT NULL COMMENT 'Helsinki hour of the revert',
           KEY (page_id), KEY (ts))""")
    q(f"""INSERT IGNORE INTO viz_immune_bad
          SELECT r.rev_id, r.page_id, r.ts, {kind_sql}, e.rev_id, e.ts,
                 GREATEST(0, TIMESTAMPDIFF(SECOND, r.ts, e.ts)),
                 HOUR(CONVERT_TZ(r.ts, 'UTC', '{TZ}')), HOUR(CONVERT_TZ(e.ts, 'UTC', '{TZ}'))
          FROM viz_immune_tmp_rv e
          JOIN viz_immune_tmp_seq r ON r.page_id = e.page_id AND r.seq > e.pseq AND r.seq < e.seq
          WHERE NOT (r.user <=> e.user)""")
    n_self = q("""SELECT COUNT(*) FROM viz_immune_tmp_rv e
                  JOIN viz_immune_tmp_seq r ON r.page_id = e.page_id AND r.seq > e.pseq AND r.seq < e.seq
                  WHERE r.user <=> e.user""")[0][0]
    n_reverts = q("SELECT COUNT(DISTINCT revert_rev_id) FROM viz_immune_bad")[0][0]
    log("bad versions stored")

    bad = q("SELECT YEAR(ts), kind, lifetime_s, page_id FROM viz_immune_bad")
    years = np.array([b[0] for b in bad])
    kinds = np.array([b[1] for b in bad])
    life = np.array([b[2] for b in bad], dtype=float)
    lg = np.log10(np.maximum(life, 1))
    binix = np.clip((lg / BIN).astype(int), 0, NBIN - 1)
    log(f"{len(bad)} bad versions fetched")

    # all edits per year and kind (denominator for "share of their edits that got reverted")
    alled = q(f"""SELECT YEAR(ts) y, {kind_sql} k, COUNT(*) FROM revision r GROUP BY y, k""")
    alls = {(y, k): n for y, k, n in alled}

    q("DROP TABLE IF EXISTS viz_immune_year")
    q("""CREATE TABLE viz_immune_year (
           year SMALLINT PRIMARY KEY, n INT NOT NULL,
           p10 INT, p25 INT, p50 INT, p75 INT, p90 INT, mean_log DOUBLE,
           within_hour DOUBLE COMMENT 'share undone within 1 h', within_day DOUBLE,
           bad_reg INT, bad_anon INT, bad_temp INT, bad_bot INT,
           ed_reg INT, ed_anon INT, ed_temp INT, ed_bot INT)""")
    yrows = []
    for y in sorted(set(years.tolist())):
        m = years == y
        lt = life[m]
        p = np.percentile(lt, [10, 25, 50, 75, 90])
        yrows.append((int(y), int(m.sum()), *[int(v) for v in p], float(lg[m].mean()),
                      float((lt <= 3600).mean()), float((lt <= 86400).mean()),
                      *[int(((kinds == k) & m).sum()) for k in ("reg", "anon", "temp", "bot")],
                      *[int(alls.get((y, k), 0)) for k in ("reg", "anon", "temp", "bot")]))
    cur.executemany("INSERT INTO viz_immune_year VALUES (" + ",".join(["%s"] * 18) + ")", yrows)

    q("DROP TABLE IF EXISTS viz_immune_year_bin")
    q("CREATE TABLE viz_immune_year_bin (year SMALLINT, bin TINYINT, n INT, PRIMARY KEY (year, bin))")
    yb = {}
    for y, b in zip(years.tolist(), binix.tolist()):
        yb[(y, b)] = yb.get((y, b), 0) + 1
    cur.executemany("INSERT INTO viz_immune_year_bin VALUES (%s,%s,%s)", [(y, b, n) for (y, b), n in yb.items()])

    q("DROP TABLE IF EXISTS viz_immune_hist")
    q("CREATE TABLE viz_immune_hist (bin TINYINT, kind ENUM('reg','anon','temp','bot'), n INT, PRIMARY KEY (bin, kind))")
    hb = {}
    for k, b in zip(kinds.tolist(), binix.tolist()):
        hb[(b, k)] = hb.get((b, k), 0) + 1
    cur.executemany("INSERT INTO viz_immune_hist VALUES (%s,%s,%s)", [(b, k, n) for (b, k), n in hb.items()])
    log("year/bin/hist stored")

    q("DROP TABLE IF EXISTS viz_immune_hour")
    q("""CREATE TABLE viz_immune_hour (hour TINYINT PRIMARY KEY, all_edits INT NOT NULL,
           bad_edits INT NOT NULL, reverts INT NOT NULL)""")
    q(f"""INSERT INTO viz_immune_hour
          SELECT a.h, a.n, COALESCE(b.n, 0), COALESCE(c.n, 0)
          FROM (SELECT HOUR(CONVERT_TZ(ts, 'UTC', '{TZ}')) h, COUNT(*) n FROM revision GROUP BY h) a
          LEFT JOIN (SELECT h_edit h, COUNT(*) n FROM viz_immune_bad GROUP BY h) b USING (h)
          LEFT JOIN (SELECT h, COUNT(*) n FROM (SELECT DISTINCT revert_rev_id, h_revert h FROM viz_immune_bad) d
                     GROUP BY h) c USING (h)""")
    log("hours stored")

    q("DROP TABLE IF EXISTS viz_immune_article")
    q("""CREATE TABLE viz_immune_article (
           page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255) NOT NULL, versions INT NOT NULL,
           n_bad INT NOT NULL, n_reverts INT NOT NULL, bad_anon INT NOT NULL COMMENT 'IP + temp accounts',
           median_s INT NOT NULL, peak_year SMALLINT NOT NULL, peak_n INT NOT NULL,
           years JSON NOT NULL COMMENT 'bad versions per year 2003..2026', KEY (n_bad))""")
    top = q("""SELECT page_id, COUNT(*) n, COUNT(DISTINCT revert_rev_id) nr, SUM(kind IN ('anon','temp'))
               FROM viz_immune_bad GROUP BY page_id ORDER BY n DESC LIMIT 60""")
    ids = [t[0] for t in top]
    ph = ",".join(["%s"] * len(ids))
    titles = dict(q(f"""SELECT r.page_id, r.title FROM revision r
                        JOIN (SELECT page_id, MAX(ts) ts FROM revision WHERE page_id IN ({ph}) GROUP BY page_id) m
                        USING (page_id, ts)""", ids))
    vers = dict(q(f"SELECT page_id, COUNT(*) FROM revision WHERE page_id IN ({ph}) GROUP BY page_id", ids))
    page_arr = np.array([b[3] for b in bad])
    arts = []
    for pid, n, nr, na in top:
        m = page_arr == pid
        ys = [int(((years == y) & m).sum()) for y in range(2003, 2027)]
        pk = int(np.argmax(ys))
        arts.append((pid, titles.get(pid, str(pid)), vers.get(pid, 0), n, nr, int(na),
                     int(np.median(life[m])), 2003 + pk, ys[pk], json.dumps(ys)))
    cur.executemany("INSERT INTO viz_immune_article VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", arts)
    log("articles stored")

    longest = q("""SELECT b.rev_id, b.page_id, b.ts, b.kind, b.revert_rev_id, b.lifetime_s
                   FROM viz_immune_bad b ORDER BY b.lifetime_s DESC LIMIT 1""")
    meta = dict(n_bad=len(bad), n_reverts=int(n_reverts), n_self_skipped=int(n_self),
                median_s=int(np.median(life)), within_minute=float((life <= 60).mean()),
                within_hour=float((life <= 3600).mean()), within_day=float((life <= 86400).mean()),
                over_year=int((life > 365 * 86400).sum()), bin=BIN, nbin=NBIN, max_span=MAX_SPAN,
                first_temp=str(q("SELECT MIN(ts) FROM revision WHERE user REGEXP '^~[0-9]{4}-'")[0][0]),
                last_ip=str(q("SELECT MAX(ts) FROM revision WHERE anonymous=1 AND user NOT REGEXP '^~[0-9]{4}-'")[0][0]),
                last_ts=str(q("SELECT MAX(ts) FROM revision")[0][0]))
    q("DROP TABLE IF EXISTS viz_immune_meta")
    q("CREATE TABLE viz_immune_meta (k VARCHAR(32) PRIMARY KEY, v JSON NOT NULL)")
    q("INSERT INTO viz_immune_meta VALUES ('meta', %s)", (json.dumps(meta),))
    log(json.dumps(meta))


if __name__ == "__main__":
    main()
