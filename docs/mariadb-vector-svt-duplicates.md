# MariaDB 12.3.3: VECTOR INDEX + `FOR SYSTEM_TIME AS OF` returns wrong and duplicate rows

Found while building time-travel semantic search (Junction 2026, "Wikipedia Through Time").

## Setup

`article_vector_history`: 170,300 rows, one bge-m3 vector (1024-d) per article per yearly snapshot,
system-versioned with real Wikipedia edit times (`system_versioning_insert_history`), built in
`scripts/load_timesearch.py`:

```sql
CREATE TABLE article_vector_history (
  page_id   INT UNSIGNED NOT NULL,
  rev_id    INT UNSIGNED NOT NULL,
  title     VARCHAR(255) NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
  row_end   TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (page_id)
) WITH SYSTEM VERSIONING;
ALTER TABLE article_vector_history ADD VECTOR INDEX (embedding) M=16 DISTANCE=cosine;
```

On 1 January 2015, 12,930 of the 170,300 rows are valid (one per article that existed then).

## Query

```sql
SELECT page_id FROM article_vector_history FOR SYSTEM_TIME AS OF TIMESTAMP '2015-01-01 00:00:00'
ORDER BY VEC_DISTANCE_COSINE(embedding, @q) LIMIT k;
```

with `@q` = bge-m3 of "Mikä on Suomen suhde Natoon?".

## What happens (default mhnsw_ef_search = 20)

| | result |
|---|---|
| index, LIMIT 4 | 128998, 1065040, 1256, 241905 |
| index, LIMIT 5 | 128998, 1065040, 682376, 12465, 128159 |
| index, LIMIT 6 | 128998, 1065040, **1256, 1256, 8617, 8617** (duplicate rows) |
| index, LIMIT 7 | 128998, 1065040, 682376, 12465, 128159, 1137, 942 |
| exact (`IGNORE INDEX (embedding)`), LIMIT 6 | 128998, 1065040, 362395, 631505, 733210, 727489 |

1. The same row is returned twice (LIMIT 6).
2. Results change with LIMIT in ways that are not prefixes of each other.
3. Recall against the exact answer is low.

## Measured recall (scripts/bench_asof_vector.py; 5 questions x 5 dates 2006–2026, k=10)

| | recall@10 | duplicate rows | median / max latency (incl. ~100 ms network) |
|---|---|---|---|
| exact | 1.00 | 0 | 215 / 247 ms |
| index, ef_search 20 | 0.47 | 1 | 105 / 5634 ms |
| index, ef_search 100 | 0.74 | 0 | 111 / 1363 ms |
| index, ef_search 400 | 0.84 | 0 | 126 / 1038 ms |
| index, ef_search 1000 | 0.91 | 0 | 188 / 2027 ms |
| index, ef_search 4000 | 0.98 | 0 | 411 / 4659 ms |

## Our reading

The HNSW graph holds every version of every year, and the `AS OF` condition is applied to the
candidates the graph returns, so most of the ef_search candidates are discarded (only 1–12% of rows are
valid at any moment: 2,193 on 1 Jan 2006, 12,930 on 1 Jan 2015, 19,742 today). The duplicates suggest the scan restarts or continues over candidates it has
already returned. Exact search over 170k vectors is fast enough (~115 ms on the server), so our
time-travel search uses `IGNORE INDEX (embedding)`. A vector index that is aware of the period (or one
graph per history partition when the table is `PARTITION BY SYSTEM_TIME`; today a partitioned table cannot
carry a vector index, see MDEV-35315) would make this scale.
