"""Precompute revert events ("who undoes whom") for every article into viz_editwars_* tables.

    nice -n 10 .venv/bin/python -m scripts.build_editwars        (~1 min, idempotent)

A version is a revert when its text (sha1) equals an earlier version of the page but not the previous one
(revision.is_revert). The version it restores is the most recent earlier version with the same sha1; every
version strictly in between was undone, and its editor was reverted. Window functions over `revision` find
the restored version per revert (LAG over page_id, sha1) and the sequence number of each version per page.

Classes per (reverter -> reverted editor) pair in one revert:
  self     reverter undid their own versions
  bot      the reverter is a bot (user name ends in 'bot')
  vandal   vandalism cleanup: reverted editor is anonymous, or was undone within 24 h and has <= 10 edits in total
  war      contested: both registered (not bots), and in the same article each has reverted the other at least
           once in a revert that is not itself self/bot/vandal (so both directions of a war pair are war)
  dispute  a registered editor's work undone by another registered editor, one-way (or by an anonymous editor)
An event takes its most contested pair's class (war > dispute > vandal > bot > self).
Reverts that undo more than MAX_SPAN versions (restorations of a years-old text) or restore an empty page are skipped.
"""
import collections, json, time
from wikitime.db import connect

MAX_SPAN = 50
FEW_EDITS, FAST_S = 10, 24 * 3600
RANK = {"war": 5, "dispute": 4, "vandal": 3, "bot": 2, "self": 1}
Y0, Y1 = 2003, 2026


def is_bot(u):
    return bool(u) and u.lower().endswith("bot")


def kind(user, anon):
    return "anon" if anon else ("bot" if is_bot(user) else "reg")


def main():
    t0 = time.time()
    con = connect()
    con.autocommit(True)
    cur = con.cursor()

    def q(sql, params=None):
        cur.execute(sql, params)
        return cur.fetchall()

    q("DROP TEMPORARY TABLE IF EXISTS viz_editwars_tmp_seq")
    q("""CREATE TEMPORARY TABLE viz_editwars_tmp_seq AS
         SELECT page_id, rev_id, ts, user, anonymous, bytes, is_revert,
                ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY ts, rev_id) AS seq,
                LAG(rev_id) OVER (PARTITION BY page_id, sha1 ORDER BY ts, rev_id) AS same_prev
         FROM revision""")
    q("ALTER TABLE viz_editwars_tmp_seq ADD PRIMARY KEY (page_id, seq), ADD KEY (rev_id)")
    print(f"sequenced versions  {time.time()-t0:.0f}s", flush=True)

    # one row per revert: the revert, the version it restored, how many versions it undid
    q("DROP TEMPORARY TABLE IF EXISTS viz_editwars_tmp_rv")
    q(f"""CREATE TEMPORARY TABLE viz_editwars_tmp_rv AS
          SELECT t.page_id, t.rev_id, t.ts, t.user, t.anonymous, t.seq, p.seq AS pseq, p.rev_id AS restored_rev_id,
                 t.bytes
          FROM viz_editwars_tmp_seq t JOIN viz_editwars_tmp_seq p ON p.rev_id = t.same_prev
          WHERE t.is_revert = 1 AND t.bytes > 0 AND t.seq - p.seq - 1 BETWEEN 1 AND {MAX_SPAN}""")
    q("ALTER TABLE viz_editwars_tmp_rv ADD PRIMARY KEY (rev_id)")
    reverts = q("SELECT page_id, rev_id, ts, user, anonymous, restored_rev_id FROM viz_editwars_tmp_rv")
    # the undone versions, grouped per reverted editor
    undone = q("""SELECT e.rev_id, r.user, MAX(r.anonymous), COUNT(*), MIN(r.ts), MAX(r.rev_id)
                  FROM viz_editwars_tmp_rv e
                  JOIN viz_editwars_tmp_seq r ON r.page_id = e.page_id AND r.seq > e.pseq AND r.seq < e.seq
                  GROUP BY e.rev_id, r.user""")
    total_edits = dict(q("SELECT user, COUNT(*) FROM revision WHERE user IS NOT NULL GROUP BY user"))
    print(f"{len(reverts)} reverts, {len(undone)} reverted (event, editor) pairs  {time.time()-t0:.0f}s", flush=True)

    ev = {r[1]: dict(page_id=r[0], rev_id=r[1], ts=r[2], user=r[3] or "", anon=r[4], restored=r[5]) for r in reverts}
    by_ev = collections.defaultdict(list)
    for rev_id, user, anon, n, first_ts, last_rev in undone:
        by_ev[rev_id].append(dict(user=user or "", anon=anon, n=n, first_ts=first_ts, last_rev=last_rev))

    def base_class(e, d, dt):
        """Everything but war/dispute; None = a registered editor undone by another registered editor."""
        if d["user"] == e["user"]:
            return "self"
        if is_bot(e["user"]):
            return "bot"
        if d["anon"] or (dt <= FAST_S and total_edits.get(d["user"], 0) <= FEW_EDITS):
            return "vandal"
        return None

    # directed registered-vs-registered reverts per article; a pair is at war when both directions exist
    directed = set()
    for rid, e in ev.items():
        for d in by_ev.get(rid, []):
            if not e["anon"] and not is_bot(d["user"]) and base_class(e, d, (e["ts"] - d["first_ts"]).total_seconds()) is None:
                directed.add((e["page_id"], e["user"], d["user"]))

    edges, events = [], []
    for rid, e in ev.items():
        ds = by_ev.get(rid, [])
        if not ds:
            continue
        best, ttr = "self", None
        for d in ds:
            dt = (e["ts"] - d["first_ts"]).total_seconds()
            ttr = dt if ttr is None else max(ttr, dt)
            c = base_class(e, d, dt)
            if c is None:
                c = "war" if ((e["page_id"], e["user"], d["user"]) in directed
                              and (e["page_id"], d["user"], e["user"]) in directed) else "dispute"
            d["cls"] = c
            if RANK[c] > RANK[best]:
                best = c
            edges.append((rid, e["page_id"], e["ts"], e["user"], d["user"], kind(d["user"], d["anon"]),
                          d["n"], d["first_ts"], int(dt), c))
        main_d = max((d for d in ds if d["user"] != e["user"]), key=lambda d: d["n"], default=ds[0])
        events.append((rid, e["page_id"], e["ts"], e["user"], kind(e["user"], e["anon"]), e["restored"],
                       main_d["last_rev"], sum(d["n"] for d in ds), len(ds), main_d["user"],
                       kind(main_d["user"], main_d["anon"]), int(ttr), best))

    q("DROP TABLE IF EXISTS viz_editwars_events")
    q("""CREATE TABLE viz_editwars_events (
           rev_id INT UNSIGNED PRIMARY KEY, page_id INT UNSIGNED NOT NULL, ts DATETIME(6) NOT NULL,
           reverter VARCHAR(255) NOT NULL, reverter_kind ENUM('reg','anon','bot') NOT NULL,
           restored_rev_id INT UNSIGNED NOT NULL COMMENT 'the earlier version this revert brought back',
           undone_rev_id INT UNSIGNED NOT NULL COMMENT 'last undone version of the main reverted editor',
           n_versions SMALLINT NOT NULL COMMENT 'versions undone', n_editors SMALLINT NOT NULL,
           reverted VARCHAR(255) NOT NULL COMMENT 'editor with most undone versions', reverted_kind ENUM('reg','anon','bot') NOT NULL,
           ttr_s INT NOT NULL COMMENT 'seconds from first undone version to the revert',
           cls ENUM('war','dispute','vandal','bot','self') NOT NULL,
           KEY (page_id, ts), KEY (ts), KEY (cls))""")
    cur.executemany("INSERT INTO viz_editwars_events VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", events)
    # edit summaries of the revert and of the main undone version, copied so the article view never touches
    # `revision` (cold random reads there took seconds per article while the bulk text load churns the buffer pool)
    q("""ALTER TABLE viz_editwars_events ADD COLUMN delta INT, ADD COLUMN comment VARCHAR(160),
           ADD COLUMN undone_comment VARCHAR(160)""")
    q("""UPDATE viz_editwars_events e JOIN revision r ON r.rev_id = e.rev_id
           LEFT JOIN revision u ON u.rev_id = e.undone_rev_id
         SET e.delta = r.delta, e.comment = LEFT(r.comment, 160), e.undone_comment = LEFT(u.comment, 160)""")
    # rebuild compressed: the UPDATE split pages, and the edit summaries compress well (keeps all tables < 30 MB)
    q("ALTER TABLE viz_editwars_events ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8")
    q("DROP TABLE IF EXISTS viz_editwars_edges")
    q("""CREATE TABLE viz_editwars_edges (
           rev_id INT UNSIGNED NOT NULL, page_id INT UNSIGNED NOT NULL, ts DATETIME(6) NOT NULL,
           reverter VARCHAR(255) NOT NULL, reverted VARCHAR(255) NOT NULL, reverted_kind ENUM('reg','anon','bot') NOT NULL,
           n_versions SMALLINT NOT NULL, first_ts DATETIME(6) NOT NULL, ttr_s INT NOT NULL,
           cls ENUM('war','dispute','vandal','bot','self') NOT NULL,
           PRIMARY KEY (rev_id, reverted), KEY (page_id, ts)) ROW_FORMAT=COMPRESSED KEY_BLOCK_SIZE=8""")
    cur.executemany("INSERT INTO viz_editwars_edges VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", edges)
    print(f"{len(events)} events, {len(edges)} edges stored  {time.time()-t0:.0f}s", flush=True)

    # editor nodes per article: every editor who reverted or was reverted there, with their edits to that article
    q("DROP TABLE IF EXISTS viz_editwars_nodes")
    q("""CREATE TABLE viz_editwars_nodes (
           page_id INT UNSIGNED NOT NULL, user VARCHAR(255) NOT NULL, anon TINYINT NOT NULL, edits INT NOT NULL,
           first_ts DATETIME(6) NOT NULL, last_ts DATETIME(6) NOT NULL, PRIMARY KEY (page_id, user))""")
    q("""INSERT INTO viz_editwars_nodes
         SELECT r.page_id, COALESCE(r.user, ''), MAX(r.anonymous), COUNT(*), MIN(r.ts), MAX(r.ts)
         FROM revision r
         JOIN (SELECT DISTINCT page_id, reverter u FROM viz_editwars_edges
               UNION SELECT DISTINCT page_id, reverted FROM viz_editwars_edges) p
           ON p.page_id = r.page_id AND p.u = COALESCE(r.user, '')
         GROUP BY r.page_id, COALESCE(r.user, '')""")
    print(f"nodes stored  {time.time()-t0:.0f}s", flush=True)

    # per-article leaderboard rows with a yearly sparkline per class
    vers = dict(q("SELECT page_id, COUNT(*) FROM revision GROUP BY page_id"))
    n_editors = dict(q("SELECT page_id, COUNT(DISTINCT COALESCE(user, '')) FROM revision GROUP BY page_id"))
    titles = dict(q("""SELECT r.page_id, r.title FROM revision r
                       JOIN (SELECT page_id, MAX(ts) ts FROM revision GROUP BY page_id) m USING (page_id, ts)"""))
    agg = collections.defaultdict(lambda: {"cls": collections.Counter(), "years": {}, "pairs": set(),
                                           "eds": set(), "first": None, "last": None})
    for (rid, pid, ts, reverter, rk, _r, _u, _n, _ne, _rv, _rvk, _t, cls) in events:
        a = agg[pid]
        a["cls"][cls] += 1
        y = a["years"].setdefault(ts.year, collections.Counter())
        y[cls] += 1
        a["first"] = ts if a["first"] is None else min(a["first"], ts)
        a["last"] = ts if a["last"] is None else max(a["last"], ts)
    for (rid, pid, ts, reverter, reverted, rk, n, fts, ttr, cls) in edges:
        if cls == "war":
            agg[pid]["pairs"].add(tuple(sorted((reverter, reverted))))
            agg[pid]["eds"].update((reverter, reverted))
    arts = []
    for pid, a in agg.items():
        c = a["cls"]
        spark = [[a["years"].get(y, {}).get(k, 0) for k in ("war", "dispute", "vandal", "bot", "self")]
                 for y in range(Y0, Y1 + 1)]
        arts.append((pid, titles.get(pid, str(pid)), vers.get(pid, 0), sum(c.values()), c["war"], c["dispute"],
                     c["vandal"], c["bot"], c["self"], len(a["pairs"]), len(a["eds"]), a["first"], a["last"],
                     json.dumps(spark, separators=(",", ":")), n_editors.get(pid, 0)))
    q("DROP TABLE IF EXISTS viz_editwars_articles")
    q("""CREATE TABLE viz_editwars_articles (
           page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255) NOT NULL, versions INT NOT NULL,
           n_reverts INT NOT NULL, n_war INT NOT NULL, n_dispute INT NOT NULL, n_vandal INT NOT NULL,
           n_bot INT NOT NULL, n_self INT NOT NULL, war_pairs INT NOT NULL, warriors INT NOT NULL,
           first_ts DATETIME(6), last_ts DATETIME(6),
           spark JSON NOT NULL COMMENT 'per year 2003..2026: [war, dispute, vandal, bot, self]',
           editors_total INT NOT NULL COMMENT 'distinct editors of the article',
           KEY (n_war), KEY (n_reverts), KEY (title))""")
    cur.executemany("INSERT INTO viz_editwars_articles VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", arts)

    # global monthly totals per class
    q("DROP TABLE IF EXISTS viz_editwars_monthly")
    q("""CREATE TABLE viz_editwars_monthly (month DATE NOT NULL, cls ENUM('war','dispute','vandal','bot','self') NOT NULL,
           n INT NOT NULL, PRIMARY KEY (month, cls))""")
    q("""INSERT INTO viz_editwars_monthly
         SELECT DATE_FORMAT(ts, '%Y-%m-01'), cls, COUNT(*) FROM viz_editwars_events GROUP BY 1, 2""")
    q("DROP TABLE IF EXISTS viz_editwars_edits_monthly")
    q("""CREATE TABLE viz_editwars_edits_monthly (month DATE PRIMARY KEY, edits INT NOT NULL, anon INT NOT NULL)""")
    q("""INSERT INTO viz_editwars_edits_monthly
         SELECT DATE_FORMAT(ts, '%Y-%m-01'), COUNT(*), SUM(anonymous) FROM revision GROUP BY 1""")
    print(f"{len(arts)} articles  done in {time.time()-t0:.0f}s")
    for r in q("""SELECT table_name, ROUND((data_length+index_length)/1e6,1) FROM information_schema.tables
                  WHERE table_schema=DATABASE() AND table_name LIKE 'viz_editwars%'"""):
        print("  ", *r)
    con.close()


if __name__ == "__main__":
    main()
