"""Weekly edit activity across Finnish Wikipedia history (read-only)."""
from datetime import date, timedelta
from functools import lru_cache
from threading import Lock

from flask import Blueprint, jsonify, request
from app.article import moment
from app.db import rows

bp = Blueprint("seismo", __name__)
_pulse_lock = Lock()
WEEK = "DATE_SUB(DATE(ts), INTERVAL WEEKDAY(ts) DAY)"
BOT = "LOWER(COALESCE(user, '')) LIKE '%%bot'"


def limit(default, maximum):
    try:
        n = int(request.args.get("n", default))
    except ValueError:
        raise ValueError("n must be an integer") from None
    if not 1 <= n <= maximum:
        raise ValueError(f"n must be between 1 and {maximum}")
    return n


def latest_titles(found):
    if not found:
        return found
    ids = list({r["page_id"] for r in found})
    titles = rows(f"""SELECT r.page_id, r.title FROM
        (SELECT DISTINCT page_id FROM revision WHERE page_id IN
        ({','.join(['%s'] * len(ids))})) pages
        JOIN revision r ON r.rev_id=(SELECT r2.rev_id FROM revision r2
        WHERE r2.page_id=pages.page_id ORDER BY r2.ts DESC, r2.rev_id DESC LIMIT 1)""", ids)
    lookup = {r["page_id"]: r["title"] for r in titles}
    for row in found:
        row["title"] = lookup.get(row["page_id"], str(row["page_id"]))
        if "week" in row:
            row["week"] = row["week"].isoformat()
        for key in ("edits", "reverts", "anon", "bot", "registered"):
            if key in row:
                row[key] = int(row[key] or 0)
        if "anon_share" in row:
            row["anon_share"] = float(row["anon_share"] or 0)
    return found


@lru_cache(maxsize=1)
def pulse_data():
    found = rows(f"""SELECT {WEEK} AS week, COUNT(*) AS edits,
        SUM(COALESCE(is_revert,0)) AS reverts,
        SUM(anonymous AND NOT ({BOT})) AS anon, SUM({BOT}) AS bot,
        SUM(NOT anonymous AND NOT ({BOT})) AS registered
        FROM revision WHERE ts >= '2003-01-01' AND ts < '2027-01-01'
        GROUP BY week ORDER BY week""")
    by_week = {r["week"]: r for r in found}
    week, end = date(2002, 12, 30), date(2026, 12, 28)
    result = []
    while week <= end:
        row = by_week.get(week, {})
        result.append({"week": week.isoformat(), **{k: int(row.get(k) or 0)
                       for k in ("edits", "reverts", "anon", "bot", "registered")}})
        week += timedelta(days=7)
    return result


@bp.get("/pulse")
def pulse():
    with _pulse_lock:
        return jsonify(pulse_data())


@lru_cache(maxsize=16)
def spike_data(n):
    # Rank per article before taking the global top n, so no article takes >2 slots.
    found = rows(f"""SELECT page_id, week, edits, reverts FROM (
        SELECT page_id, week, edits, reverts,
        ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY edits DESC, week) AS rank_in_page
        FROM (SELECT page_id, {WEEK} AS week, COUNT(*) AS edits,
            SUM(COALESCE(is_revert,0)) AS reverts FROM revision
            WHERE ts >= '2003-01-01' AND ts < '2027-01-01'
            GROUP BY page_id, week) counts) ranked WHERE rank_in_page <= 2
        ORDER BY edits DESC, page_id, week LIMIT %s""", (n,))
    return latest_titles(found)


@bp.get("/spikes")
def spikes():
    try:
        return jsonify(spike_data(limit(40, 200)))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400


@bp.get("/top")
def top():
    try:
        start, end = (moment(request.args.get(k)) for k in ("from", "to"))
        n = limit(25, 100)
        if start >= end:
            raise ValueError("from must be earlier than to (exclusive)")
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    found = rows("""SELECT page_id, COUNT(*) AS edits, SUM(COALESCE(is_revert,0)) AS reverts,
        AVG(anonymous) AS anon_share FROM revision WHERE ts >= %s AND ts < %s
        GROUP BY page_id ORDER BY edits DESC, page_id LIMIT %s""", (start, end, n))
    return jsonify(latest_titles(found))
