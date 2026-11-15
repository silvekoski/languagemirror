"""Precompute "The Authors" (who wrote Finnish history on Wikipedia) into viz_authors_* tables.

    nice -n 10 .venv/bin/python -m scripts.build_authors        (~1-2 min, idempotent)

One streaming scan of `revision` (862k versions, metadata only) goes into an in-memory DuckDB, which does the
window functions and aggregations; the results are written back to MariaDB as small viz_authors_* tables.

Editor kinds: anon = revision.anonymous (an IP, or since 2025 a temporary account "~2025-…"), bot = a registered
user name ending in "bot" (case-insensitive), reg = every other registered user.
A cohort is the calendar year of an editor's first version in this topic (not their first edit on Wikipedia).
"Undone" = a later revert (revision.is_revert: text identical to an earlier version, not the previous one) restored
the text from before this edit, made by someone else; reverts spanning more than MAX_SPAN versions are ignored
(restorations of years-old text), as in build_editwars.
"""
import time
import duckdb
import pyarrow as pa
import pymysql.cursors
from wikitime.db import connect

MAX_SPAN = 50
TOP_LANES = 200      # editors with a month-by-month career strip
TOP_PAGES = 6        # top articles kept per editor
COLS = ["rev_id", "page_id", "title", "ts", "user", "anonymous", "minor", "sha1", "bytes", "delta", "is_revert",
        "comment"]
MIN_DETAIL = 50      # editors with at least this many edits get a weekday x hour card and edit-summary patterns
# (top articles are kept for editors with 3+ edits)


def fetch():
    """Stream revision into an Arrow table (chunked, so peak memory stays small)."""
    con = connect(cursorclass=pymysql.cursors.SSCursor)
    cur = con.cursor()
    cur.execute(f"SELECT {', '.join(COLS[:-1])}, LEFT(comment, 160) FROM revision")
    batches = []
    while True:
        chunk = cur.fetchmany(50_000)
        if not chunk:
            break
        cols = list(zip(*chunk))
        batches.append(pa.record_batch([
            pa.array(cols[0], pa.int64()), pa.array(cols[1], pa.int64()), pa.array(cols[2], pa.string()),
            pa.array(cols[3], pa.timestamp("us")), pa.array(cols[4], pa.string()), pa.array(cols[5], pa.int8()),
            pa.array(cols[6], pa.int8()), pa.array(cols[7], pa.string()), pa.array(cols[8], pa.int64()),
            pa.array(cols[9], pa.int64()), pa.array(cols[10], pa.int8()), pa.array(cols[11], pa.string())],
            names=COLS))
    con.close()
    return pa.Table.from_batches(batches)


SCHEMA = {
    "viz_authors_month": """(month DATE PRIMARY KEY, edits INT, reg INT, bot INT, anon INT, anon_temp INT,
        reg_editors INT, reg_active5 INT, bot_editors INT, anon_ids INT, new_reg INT, reverts INT)""",
    "viz_authors_cohort": """(month DATE, cohort SMALLINT, editors INT, active5 INT, edits INT,
        PRIMARY KEY (month, cohort))""",
    "viz_authors_cohort_year": """(year SMALLINT, cohort SMALLINT, editors INT, edits INT, PRIMARY KEY (year, cohort))""",
    "viz_authors_botmonth": """(month DATE, user VARCHAR(255) COLLATE utf8mb4_bin, edits INT, PRIMARY KEY (month, user))""",
    "viz_authors_user": """(user VARCHAR(255) COLLATE utf8mb4_bin PRIMARY KEY, kind CHAR(3), cohort SMALLINT,
        first_ts DATETIME, last_ts DATETIME, edits INT, pages INT, created INT, last_word INT, reverts INT,
        undone INT, minor INT, added BIGINT, removed BIGINT, months INT, rnk INT, KEY (rnk), KEY (edits))""",
    "viz_authors_lane": """(user VARCHAR(255) COLLATE utf8mb4_bin, month DATE, edits INT, PRIMARY KEY (user, month))""",
    "viz_authors_user_page": """(user VARCHAR(255) COLLATE utf8mb4_bin, page_id INT, title VARCHAR(255), edits INT,
        PRIMARY KEY (user, page_id))""",
    "viz_authors_user_year": """(user VARCHAR(255) COLLATE utf8mb4_bin, year SMALLINT, edits INT, minor INT, reverts INT,
        undone INT, added BIGINT, removed BIGINT, PRIMARY KEY (user, year))""",
    "viz_authors_user_hour": """(user VARCHAR(255) COLLATE utf8mb4_bin, dow TINYINT, hour TINYINT, edits INT,
        PRIMARY KEY (user, dow, hour))""",
    "viz_authors_user_comment": """(user VARCHAR(255) COLLATE utf8mb4_bin, k TINYINT, example VARCHAR(200), n INT,
        PRIMARY KEY (user, k))""",
    "viz_authors_hour": """(kind CHAR(3), dow TINYINT, hour TINYINT, edits INT, PRIMARY KEY (kind, dow, hour))""",
    "viz_authors_meta": """(k VARCHAR(32) PRIMARY KEY, v VARCHAR(64))""",
    "viz_authors_page": """(page_id INT PRIMARY KEY, title VARCHAR(255), edits INT,
        created_by VARCHAR(255) COLLATE utf8mb4_bin, created_ts DATETIME(6), last_user VARCHAR(255) COLLATE utf8mb4_bin,
        last_ts DATETIME(6), KEY (created_by), KEY (last_user))""",
}


def main():
    t0 = time.time()
    tab = fetch()
    print(f"fetched {tab.num_rows:,} versions  {time.time()-t0:.0f}s", flush=True)
    d = duckdb.connect()
    d.execute("SET memory_limit='600MB'; SET threads=2")
    d.register("raw", tab)
    meta = d.execute("""SELECT COUNT(*), COUNT(*) FILTER (WHERE user IS NULL OR user = ''), MAX(ts) FROM raw""").fetchone()
    d.execute("""CREATE TABLE r AS SELECT *,
        CASE WHEN anonymous=1 THEN 'ano' WHEN lower(user) LIKE '%bot' THEN 'bot' ELSE 'reg' END AS kind,
        CAST(date_trunc('month', ts) AS DATE) AS month,
        timezone('Europe/Helsinki', timezone('UTC', ts)) AS lts,
        ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY ts, rev_id) AS seq,
        COUNT(*) OVER (PARTITION BY page_id) AS nver
        FROM raw WHERE user IS NOT NULL AND user <> ''""")
    d.unregister("raw")
    del tab
    # who undid whom: for each revert, the versions strictly between the restored one and the revert
    d.execute(f"""CREATE TABLE undone AS
        WITH rv AS (SELECT page_id, seq, user AS reverter,
                      LAG(seq) OVER (PARTITION BY page_id, sha1 ORDER BY seq) AS pseq,
                      LAG(bytes) OVER (PARTITION BY page_id, sha1 ORDER BY seq) AS pbytes, is_revert
                    FROM r WHERE sha1 IS NOT NULL),
             iv AS (SELECT page_id, seq, pseq, reverter FROM rv
                    WHERE is_revert=1 AND pseq IS NOT NULL AND seq - pseq BETWEEN 2 AND {MAX_SPAN} AND pbytes > 0),
             cov AS (SELECT page_id, reverter, unnest(range(pseq + 1, seq)) AS s FROM iv)
        SELECT DISTINCT r.rev_id FROM cov JOIN r ON r.page_id = cov.page_id AND r.seq = cov.s
        WHERE r.user <> cov.reverter""")
    print(f"undone versions {d.execute('SELECT COUNT(*) FROM undone').fetchone()[0]:,}  {time.time()-t0:.0f}s", flush=True)

    out = {"viz_authors_meta": [("versions", str(meta[0])), ("hidden_user", str(meta[1])), ("end_ts", str(meta[2]))]}
    out["viz_authors_page"] = d.execute("""
        SELECT page_id, arg_max(title, seq), COUNT(*), arg_min(user, seq), CAST(MIN(ts) AS TIMESTAMP),
               arg_max(user, seq), CAST(MAX(ts) AS TIMESTAMP)
        FROM r GROUP BY page_id""").fetchall()
    d.execute("""CREATE TABLE u AS
        SELECT r.user, any_value(kind) kind, MIN(ts) first_ts, MAX(ts) last_ts, COUNT(*) edits,
               COUNT(DISTINCT page_id) pages, SUM(CASE WHEN seq=1 THEN 1 ELSE 0 END) created,
               SUM(CASE WHEN seq=nver THEN 1 ELSE 0 END) last_word, SUM(is_revert) reverts,
               COUNT(un.rev_id) undone, SUM(minor) minor,
               SUM(CASE WHEN delta>0 THEN delta ELSE 0 END) added, SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) removed,
               COUNT(DISTINCT month) nmonths
        FROM r LEFT JOIN undone un USING (rev_id) WHERE kind <> 'ano' GROUP BY r.user""")
    out["viz_authors_user"] = d.execute("""
        SELECT user, kind, year(first_ts), CAST(first_ts AS TIMESTAMP), CAST(last_ts AS TIMESTAMP), edits, pages,
               created, last_word, reverts, undone, minor, added, removed, nmonths,
               ROW_NUMBER() OVER (ORDER BY edits DESC, user) FROM u""").fetchall()
    d.execute(f"CREATE TABLE top AS SELECT user FROM u ORDER BY edits DESC, user LIMIT {TOP_LANES}")
    out["viz_authors_lane"] = d.execute("""
        SELECT user, month, COUNT(*) FROM r JOIN top USING (user) GROUP BY user, month""").fetchall()
    out["viz_authors_user_page"] = d.execute(f"""
        SELECT user, page_id, title, n FROM (
          SELECT user, page_id, arg_max(title, seq) title, COUNT(*) n,
                 ROW_NUMBER() OVER (PARTITION BY user ORDER BY COUNT(*) DESC, page_id) k
          FROM r JOIN u USING (user) WHERE u.edits >= 3 GROUP BY user, page_id) WHERE k <= {TOP_PAGES}""").fetchall()
    out["viz_authors_user_year"] = d.execute("""
        SELECT user, year(ts), COUNT(*), SUM(minor), SUM(is_revert), COUNT(un.rev_id),
               SUM(CASE WHEN delta>0 THEN delta ELSE 0 END), SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END)
        FROM r LEFT JOIN undone un USING (rev_id) WHERE kind <> 'ano' GROUP BY ALL""").fetchall()
    d.execute(f"CREATE TABLE det AS SELECT user FROM u WHERE edits >= {MIN_DETAIL}")
    out["viz_authors_user_hour"] = d.execute("""
        SELECT user, isodow(lts), hour(lts), COUNT(*) FROM r JOIN det USING (user) GROUP BY ALL""").fetchall()
    # edit-summary patterns: digits folded, so "Rescued 1 source" and "Rescued 2 sources" count together
    out["viz_authors_user_comment"] = d.execute("""
        SELECT user, k, example, n FROM (
          SELECT user, pat, mode(comment) example, COUNT(*) n,
                 ROW_NUMBER() OVER (PARTITION BY user ORDER BY COUNT(*) DESC, pat) k
          FROM (SELECT user, comment, coalesce(regexp_replace(comment, '[0-9]+', '#', 'g'), '') pat
                FROM r JOIN det USING (user)) GROUP BY user, pat) WHERE k <= 5""").fetchall()
    out["viz_authors_hour"] = d.execute("""
        SELECT kind, isodow(lts), hour(lts), COUNT(*) FROM r GROUP BY ALL""").fetchall()

    # month by month: registered editors split by cohort (year of first edit), bots and anonymous separately
    d.execute("""CREATE TABLE um AS SELECT r.user, month, COUNT(*) n, year(any_value(u.first_ts)) cohort
                 FROM r JOIN u USING (user) WHERE r.kind='reg' GROUP BY r.user, month""")
    out["viz_authors_cohort"] = d.execute("""
        SELECT month, cohort, COUNT(*), SUM(CASE WHEN n>=5 THEN 1 ELSE 0 END), SUM(n) FROM um GROUP BY ALL""").fetchall()
    out["viz_authors_cohort_year"] = d.execute("""
        SELECT year(month) y, cohort, COUNT(DISTINCT user), SUM(n) FROM um GROUP BY ALL""").fetchall()
    out["viz_authors_month"] = d.execute("""
        SELECT r.month, COUNT(*),
               SUM(CASE WHEN kind='reg' THEN 1 ELSE 0 END), SUM(CASE WHEN kind='bot' THEN 1 ELSE 0 END),
               SUM(CASE WHEN kind='ano' THEN 1 ELSE 0 END),
               SUM(CASE WHEN kind='ano' AND user LIKE '~%' THEN 1 ELSE 0 END),
               COUNT(DISTINCT CASE WHEN kind='reg' THEN user END),
               (SELECT COUNT(*) FROM um WHERE um.month=r.month AND n>=5),
               COUNT(DISTINCT CASE WHEN kind='bot' THEN user END),
               COUNT(DISTINCT CASE WHEN kind='ano' THEN user END),
               (SELECT COUNT(*) FROM u WHERE kind='reg' AND date_trunc('month', first_ts)=r.month),
               SUM(is_revert)
        FROM r GROUP BY r.month ORDER BY r.month""").fetchall()
    out["viz_authors_botmonth"] = d.execute("""
        SELECT month, user, COUNT(*) FROM r WHERE kind='bot' GROUP BY ALL""").fetchall()
    print("aggregated  " + "  ".join(f"{k[12:]}={len(v):,}" for k, v in out.items()) + f"  {time.time()-t0:.0f}s", flush=True)

    con = connect()
    cur = con.cursor()
    for name, rows_ in out.items():
        cur.execute(f"DROP TABLE IF EXISTS {name}_new")
        cur.execute(f"CREATE TABLE {name}_new {SCHEMA[name]} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
        ph = ",".join(["%s"] * len(rows_[0]))
        for i in range(0, len(rows_), 5000):
            cur.executemany(f"INSERT INTO {name}_new VALUES ({ph})", rows_[i:i + 5000])
        con.commit()
        cur.execute(f"DROP TABLE IF EXISTS {name}")
        cur.execute(f"RENAME TABLE {name}_new TO {name}")
    con.commit()
    con.close()
    print(f"done  {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
