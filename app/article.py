"""Shared article search, edit metadata, and system-versioned reading APIs."""
from datetime import datetime, timezone
from difflib import SequenceMatcher

from flask import Blueprint, jsonify, request
from app.db import rows
from wikitime.wikitext import clean, plain_text

bp = Blueprint("article", __name__)


def moment(value):
    """Accept ISO dates/datetimes and convert offsets to a UTC SQL timestamp."""
    if not value:
        raise ValueError("An ISO date or datetime is required")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Use an ISO date or datetime, for example 2010-01-01") from None
    if not 1970 <= dt.year <= 2037:
        raise ValueError("Date must be between 1970 and 2037")
    if dt.tzinfo:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")


def iso(dt):
    return dt.isoformat() + "Z" if dt else None


def has_text(page_id):
    return bool(rows("SELECT 1 FROM article FOR SYSTEM_TIME ALL WHERE page_id=%s LIMIT 1", (page_id,)))


def snapshot(page_id, at):
    found = rows("""SELECT title, rev_id, user, comment, row_start, row_end,
                    len AS wikitext_len, text
                    FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE page_id=%s""", (at, page_id))
    if not found:
        return None
    row = found[0]
    row["text"] = plain_text(clean(row["text"]))
    for key in ("row_start", "row_end"):
        row[key] = iso(row[key])
    return row


@bp.get("/search")
def search():
    q = request.args.get("q", "").strip()[:255]
    if not q:
        return jsonify([])
    # Escape SQL LIKE wildcards: search terms are literal, not SQL patterns.
    escaped = q.replace("=", "==").replace("%", "=%").replace("_", "=_")
    found = rows("""SELECT r.page_id, r.title, s.versions FROM
        (SELECT page_id, COUNT(*) AS versions FROM revision GROUP BY page_id) s
        JOIN revision r ON r.rev_id=(SELECT r2.rev_id FROM revision r2
            WHERE r2.page_id=s.page_id ORDER BY r2.ts DESC, r2.rev_id DESC LIMIT 1)
        WHERE r.title LIKE %s ESCAPE '='
        ORDER BY (r.title LIKE %s ESCAPE '=') DESC, r.title LIMIT 20""", ("%" + escaped + "%", escaped + "%"))
    for row in found:
        row["has_text"] = has_text(row["page_id"])
    return jsonify(found)


@bp.get("/<int:page_id>/timeline")
def timeline(page_id):
    found = rows("""SELECT rev_id, title, ts, user, anonymous, minor, bytes, delta,
                    is_revert, comment FROM revision WHERE page_id=%s ORDER BY ts, rev_id""", (page_id,))
    if not found:
        return jsonify(error="Article not found"), 404
    title = found[-1]["title"]
    for row in found:
        row.pop("title")
        row["ts"] = iso(row["ts"])
        row["bot"] = (row["user"] or "").lower().endswith("bot")
        for key in ("anonymous", "minor", "is_revert"):
            row[key] = bool(row[key])
    return jsonify(page_id=page_id, title=title, has_text=has_text(page_id), versions=found)


@bp.get("/<int:page_id>/asof")
def asof(page_id):
    try:
        at = moment(request.args.get("t"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    row = snapshot(page_id, at)
    return jsonify(row) if row else (jsonify(error="No text loaded at this time"), 404)


def text_diff(before, after):
    """Line-level changes; preserve context but fold long unchanged passages."""
    a, b = before.splitlines(), after.splitlines()
    result = []
    for tag, i, j, k, l in SequenceMatcher(None, a, b).get_opcodes():
        if tag == "equal":
            lines = a[i:j]
            if len(lines) > 8:
                lines = lines[:3] + [f"… {len(lines) - 6} unchanged lines …"] + lines[-3:]
            result.append({"op": "equal", "text": "\n".join(lines)})
        else:
            if tag in ("replace", "delete"):
                result.append({"op": "delete", "text": "\n".join(a[i:j])})
            if tag in ("replace", "insert"):
                result.append({"op": "insert", "text": "\n".join(b[k:l])})
    return result


@bp.get("/<int:page_id>/diff")
def diff(page_id):
    try:
        a, b = (moment(request.args.get(key)) for key in ("a", "b"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    before, after = snapshot(page_id, a), snapshot(page_id, b)
    if before is None or after is None:
        return jsonify(error="No text loaded at one or both times"), 404
    return jsonify(text_diff(before["text"], after["text"]))
