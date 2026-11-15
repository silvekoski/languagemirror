"""Heartbeat precompute: the rhythm of editing, from the metadata of all 862k versions in `revision`.
One streaming pass converts every edit time from UTC to Helsinki local time (zoneinfo: the server has
no time-zone tables for CONVERT_TZ) and fills the viz_heartbeat_* tables:

  viz_heartbeat_day       local day x editor kind -> edits, reverts, bytes added, bytes removed
  viz_heartbeat_day_top   local day x filter -> top 3 articles and the top editor (with their most frequent
                          edit summary that day)
  viz_heartbeat_page      page_id -> latest title (for the tops)
  viz_heartbeat_clock     year x editor kind x weekday x hour (Helsinki) -> edits
  viz_heartbeat_cat       the biggest fi categories: articles, edits
  viz_heartbeat_cat_month category x filter (all/human/reg/anon/bot) x month -> edits, plus that month's most-edited article

Editor kind: 0 registered person, 1 anonymous (IP / temporary account), 2 bot (see is_bot: name ends in
"bot", "bot2", "bot~fiwiki" or "(bot)", or starts with "Bot"+capital).
Filters for the tops / categories: all, human (0+1), reg, anon, bot.
Idempotent (drops and recreates its own tables).   nice -n 10 .venv/bin/python -m scripts.build_heartbeat
"""
import datetime as dt
import time
from collections import defaultdict
from zoneinfo import ZoneInfo

import re

import pymysql.cursors
from wikitime.db import connect

HEL, UTC = ZoneInfo("Europe/Helsinki"), dt.timezone.utc
D0 = dt.date(2003, 1, 1)
PK = 4_000_000                      # day * PK + page_id packs a (day, page) key into one int
N_CATS = 40                         # top-N by edits and top-N by articles; the union is stored
FILTERS = {"all": (0, 1, 2), "human": (0, 1), "reg": (0,), "anon": (1,), "bot": (2,)}

# Bot accounts: Wikipedia requires "bot" in the name; the usual forms are ...bot, ...Bot2, ...bot~fiwiki,
# "Name (bot)" and BotSomething / Bot-Something / BOTsomething.
_BOT = re.compile(r"(bot\d*(~fiwiki)?$|\(bot\)$)", re.I)
_BOT_PREFIX = re.compile(r"^(Bot[A-Z-]|BOT)")


def is_bot(user):
    return bool(user) and bool(_BOT.search(user) or _BOT_PREFIX.match(user))


STREAM_SQL = """SELECT page_id, ts, user, anonymous, is_revert, delta, comment, title FROM revision"""


def main():
    t0 = time.time()
    con = connect()
    cur = con.cursor(pymysql.cursors.SSCursor)
    cur.execute(STREAM_SQL)

    day = defaultdict(lambda: [0, 0, 0, 0])            # (dayidx, kind) -> n, reverts, added, removed
    day_page = defaultdict(lambda: [0, 0, 0])          # day*PK+page -> per kind counts
    day_user = {}                                      # (dayidx, user) -> [n, kind, {comment: count}]
    clock = defaultdict(int)                           # (year, kind, wd, hr)
    month_page = defaultdict(lambda: [0, 0, 0])        # (monthidx, page) -> per kind
    latest = {}                                        # page -> (ts, title)
    off_cache = {}
    n = 0
    for page, ts, user, anon, rev, delta, comment, title in cur:
        n += 1
        # Helsinki offset only changes on whole UTC hours, so cache it per UTC hour
        hk = (ts.year, ts.month, ts.day, ts.hour)
        off = off_cache.get(hk)
        if off is None:
            off = ts.replace(tzinfo=UTC).astimezone(HEL).utcoffset()
            off_cache[hk] = off
        loc = ts + off
        user = user or ""
        kind = 1 if anon else (2 if is_bot(user) else 0)
        di = (loc.date() - D0).days
        rec = day[(di, kind)]
        rec[0] += 1
        if rev:
            rec[1] += 1
        if delta:
            if delta > 0:
                rec[2] += delta
            else:
                rec[3] -= delta
        day_page[di * PK + page][kind] += 1
        du = day_user.get((di, user))
        if du is None:
            du = day_user[(di, user)] = [0, kind, {}]
        du[0] += 1
        c = (comment or "").strip()[:160]
        if c and (c in du[2] or len(du[2]) < 8):      # their most frequent summary that day (first 8 distinct)
            du[2][c] = du[2].get(c, 0) + 1
        clock[(loc.year, kind, loc.weekday(), loc.hour)] += 1
        mp = month_page[((loc.year - 2003) * 12 + loc.month - 1, page)]
        mp[kind] += 1
        lt = latest.get(page)
        if lt is None or ts > lt[0]:
            latest[page] = (ts, title)
    cur.close()
    print(f"streamed {n:,} revisions in {time.time() - t0:.1f}s; "
          f"{len(day_page):,} day-pages, {len(day_user):,} day-users")

    cur = con.cursor()
    cur.execute("SELECT page_id, title FROM current_article WHERE lang='fi'")
    titles = {p: t for p, (_, t) in latest.items()}
    titles.update(dict(cur.fetchall()))

    for t in ("day", "day_top", "page", "clock", "cat", "cat_month"):
        cur.execute(f"DROP TABLE IF EXISTS viz_heartbeat_{t}")
    cur.execute("""CREATE TABLE viz_heartbeat_day (d DATE NOT NULL, kind TINYINT NOT NULL,
        n INT NOT NULL, reverts INT NOT NULL, added INT NOT NULL, removed INT NOT NULL,
        PRIMARY KEY (d, kind)) COMMENT 'Heartbeat: edits per Helsinki-local day and editor kind'""")
    cur.execute("""CREATE TABLE viz_heartbeat_day_top (d DATE NOT NULL, filt VARCHAR(5) NOT NULL,
        what CHAR(4) NOT NULL, rnk TINYINT NOT NULL, page_id INT UNSIGNED NULL, user VARCHAR(255) NULL,
        n INT NOT NULL, total INT NOT NULL, note VARCHAR(160) NULL, PRIMARY KEY (d, filt, what, rnk))""")
    cur.execute("""CREATE TABLE viz_heartbeat_page (page_id INT UNSIGNED PRIMARY KEY, title VARCHAR(255))""")
    cur.execute("""CREATE TABLE viz_heartbeat_clock (yr SMALLINT NOT NULL, kind TINYINT NOT NULL,
        wd TINYINT NOT NULL, hr TINYINT NOT NULL, n INT NOT NULL, PRIMARY KEY (yr, kind, wd, hr))
        COMMENT 'Heartbeat: edits per year, editor kind, Helsinki weekday (0=Mon) and hour'""")
    cur.execute("""CREATE TABLE viz_heartbeat_cat (category VARCHAR(255) PRIMARY KEY, articles INT,
        edits INT, edits_human INT, rnk_edits INT, rnk_articles INT)""")
    cur.execute("""CREATE TABLE viz_heartbeat_cat_month (category VARCHAR(255) NOT NULL,
        filt VARCHAR(5) NOT NULL, m SMALLINT NOT NULL, n INT NOT NULL, top_page_id INT UNSIGNED,
        top_n INT, PRIMARY KEY (category, filt, m)) COMMENT 'm = months since 2003-01, Helsinki time'""")

    def ins(sql, data, chunk=5000):
        for i in range(0, len(data), chunk):
            cur.executemany(sql, data[i:i + chunk])

    ins("INSERT INTO viz_heartbeat_day VALUES (%s,%s,%s,%s,%s,%s)",
        [(D0 + dt.timedelta(days=di), k, *v) for (di, k), v in sorted(day.items())])
    ins("INSERT INTO viz_heartbeat_clock VALUES (%s,%s,%s,%s,%s)",
        [(*k, v) for k, v in sorted(clock.items())])

    # --- tops per day and filter
    pages_by_day = defaultdict(list)
    for key, counts in day_page.items():
        pages_by_day[key // PK].append((key % PK, counts))
    del day_page
    users_by_day = defaultdict(list)
    for (di, user), (cnt, kind, comments) in day_user.items():
        comment = max(comments.items(), key=lambda kv: (kv[1], len(kv[0])))[0] if comments else ""
        users_by_day[di].append((cnt, kind, user, comment))
    del day_user
    top_rows, used_pages = [], set()
    for di, plist in pages_by_day.items():
        d = D0 + dt.timedelta(days=di)
        for f, kinds in FILTERS.items():
            scored = [(sum(c[k] for k in kinds), p) for p, c in plist]
            scored = [s for s in scored if s[0]]
            if not scored:
                continue
            total = sum(s[0] for s in scored)
            scored.sort(key=lambda s: (-s[0], s[1]))
            for r, (cnt, p) in enumerate(scored[:3]):
                top_rows.append((d, f, "page", r, p, None, cnt, total, None))
                used_pages.add(p)
            us = sorted((u for u in users_by_day[di] if u[1] in kinds), key=lambda u: (-u[0], u[2]))
            if us:
                cnt, _, user, comment = us[0]
                top_rows.append((d, f, "user", 0, None, user[:255], cnt, total, comment or None))
    top_rows.sort(key=lambda r: r[:4])                 # primary-key order: dense pages, smaller table
    ins("INSERT INTO viz_heartbeat_day_top VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", top_rows)
    print(f"{len(top_rows):,} top rows")

    # --- categories
    cur.execute("SELECT page_id, category FROM article_category WHERE lang='fi'")
    cat_pages = defaultdict(set)
    for p, c in cur.fetchall():
        cat_pages[c].add(p)
    page_months = defaultdict(list)
    for (m, p), v in month_page.items():
        page_months[p].append((m, v))
    del month_page
    cat_stats = []
    for c, ps in cat_pages.items():
        e = eh = 0
        for p in ps:
            for _, v in page_months.get(p, ()):
                e += v[0] + v[1] + v[2]
                eh += v[0] + v[1]
        cat_stats.append([c, len(ps), e, eh])
    by_e = sorted(cat_stats, key=lambda s: (-s[2], s[0]))
    by_a = sorted(cat_stats, key=lambda s: (-s[1], s[0]))
    re_ = {s[0]: i + 1 for i, s in enumerate(by_e)}
    ra = {s[0]: i + 1 for i, s in enumerate(by_a)}
    keep = {s[0] for s in by_e[:N_CATS]} | {s[0] for s in by_a[:N_CATS]}
    ins("INSERT INTO viz_heartbeat_cat VALUES (%s,%s,%s,%s,%s,%s)",
        [(c, a, e, eh, re_[c], ra[c]) for c, a, e, eh in cat_stats if c in keep])
    cm_rows = []
    for c in keep:
        acc = {f: defaultdict(lambda: [0, 0, None]) for f in FILTERS}
        for p in cat_pages[c]:
            for m, v in page_months.get(p, ()):
                for f, kinds in FILTERS.items():
                    x = sum(v[k] for k in kinds)
                    if not x:
                        continue
                    a = acc[f][m]
                    a[0] += x
                    if x > a[1] or (x == a[1] and p < a[2]):
                        a[1], a[2] = x, p
        for f, months in acc.items():
            for m, (cnt, tn, tp) in months.items():
                cm_rows.append((c, f, m, cnt, tp, tn))
                used_pages.add(tp)
    cm_rows.sort(key=lambda r: r[:3])
    ins("INSERT INTO viz_heartbeat_cat_month VALUES (%s,%s,%s,%s,%s,%s)", cm_rows)
    ins("INSERT INTO viz_heartbeat_page VALUES (%s,%s)",
        [(p, titles.get(p, f"page {p}")) for p in sorted(used_pages)])
    con.commit()
    for t in ("day", "day_top", "page", "clock", "cat", "cat_month"):
        cur.execute(f"ANALYZE TABLE viz_heartbeat_{t}")
        cur.fetchall()
    cur.execute("""SELECT table_name, table_rows, ROUND((data_length+index_length)/1048576,1) mb
                   FROM information_schema.tables WHERE table_schema=DATABASE()
                   AND table_name LIKE 'viz_heartbeat%%'""")
    for r in cur.fetchall():
        print(*r)
    print(f"done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
