"""Create the tables in sql/schema.sql (idempotent)."""
import pathlib, re
from wikitime.db import connect

sql = pathlib.Path(__file__).resolve().parent.parent.joinpath("sql/schema.sql").read_text()
sql = re.sub(r"--[^\n]*", "", sql)
con = connect()
with con.cursor() as cur:
    for stmt in filter(str.strip, sql.split(";")):
        cur.execute(stmt)
con.commit()
with con.cursor() as cur:
    cur.execute("SHOW TABLES")
    print("tables:", ", ".join(r[0] for r in cur.fetchall()))
