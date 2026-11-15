"""Connection to the project's MariaDB (compose.yaml: port 3310, db/user/password wikitime).
Override with DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME."""
import os
import pymysql


def connect(**kw):
    con = pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", 3310)),
        user=os.environ.get("DB_USER", "wikitime"),
        password=os.environ.get("DB_PASSWORD", "wikitime"),
        database=os.environ.get("DB_NAME", "wikitime"),
        charset="utf8mb4",
        **{"autocommit": False, **kw},
    )
    with con.cursor() as cur:
        cur.execute("SET time_zone = '+00:00'")   # Wikipedia's times are UTC
    return con
