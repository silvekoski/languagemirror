"""DB helpers for the blueprints. The database runs on chili (~100 ms away over Tailscale), so each
server thread keeps one persistent autocommit connection instead of reconnecting per query
(a fresh connection costs ~700 ms there). Autocommit also means every query sees fresh data."""
import threading
import pymysql
from wikitime.db import connect

_local = threading.local()


def _con():
    con = getattr(_local, "con", None)
    if con is None:
        con = _local.con = connect(autocommit=True)
    return con


def rows(sql, params=()):
    """Run one query; return a list of dicts. Reconnects once if the connection went away."""
    for attempt in (0, 1):
        try:
            with _con().cursor() as cur:
                cur.execute(sql, params)
                if cur.description is None:
                    return []
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]
        except (pymysql.err.OperationalError, pymysql.err.InterfaceError):
            try:
                _local.con.close()
            except Exception:
                pass
            _local.con = None
            if attempt:
                raise
