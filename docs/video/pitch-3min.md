# 3-minute live stage pitch (top 5)

**Speakers:** [SPEAKER A] talks and [SPEAKER B] drives the laptop. Hand over once, at most.

**Screen:** the laptop mirrored to the projector. If the venue display allows it, use Chrome at 125%.

**Tabs:** pre-open and warm them as in `docs/video/script.md` → "How to record". The Kielipeili tab must
come from a setup where the lens tables exist (Veikka's machine until they are loaded on the shared server);
if the pitch laptop does not have them, show Kielipeili from the stills `docs/media/kielipeili-*.jpg`.

**Answer cache:** the dev server at `localhost:8000` must not be restarted before the pitch, so the
Ask answer stays cached and appears instantly.

**Backup:** keep a 2-minute video file and the `docs/media/*.jpg` stills in a local folder (not a
browser tab). If the live demo fails, play the video.

**Why this order.** The MariaDB host's top pick was cross-language comparison with a numeric score per
language, using the Finnish article as the reference ("Swedish 85, English 70, Russian 13"), with AI
scoring "the same thing told differently" and audience differences kept apart from biased ones. The brief's
own flagship question is "what did Wikipedia say about this in 2015, and what has changed since?". So we
lead with **Kielipeili**, then **Ask**; the hub's 14 tools (Ask lives in one of them) are supporting evidence. Kielipeili numbers below
are from the Kielipeili demo (`docs/kielipeili-before-after.png`); check them on screen before the pitch.

## Outline (3:00)

| Time | On screen | Say (key points, not a script) | Judging criterion |
|---|---|---|---|
| 0:00–0:15 | Deck slide 1 (title), then slide 2 (the problem: the host's "Swedish 85, English 70, Russian 13" and the brief's 2015 question). | **Hook:** the same war is told in six Wikipedias. How much of the Finnish story does each one tell, where do they tell it differently, and was it always so? Nobody can see that today. | Usefulness |
| 0:15–0:55 | **Live:** `kielipeili.html`, *Suomen sisällissota* (Finnish Civil War). Score tiles, then the coverage-over-time chart. Fallback without the lens tables: deck slide 3. | **Kielipeili: one story, six Wikipedias.**<br>- Finnish is the reference: 100 (115k characters). Coverage: English 72, German 57, Ukrainian 35, Russian 34, Swedish 28.<br>- Every paragraph of fi, sv, en, de, ru and uk is a bge-m3 vector in a system-versioned table with Wikipedia's real save times. Coverage = share of the Finnish text whose nearest paragraph in the other language is a match (cosine ≥ 0.60). One SQL statement per language.<br>- Because the table is system-versioned, the same statement read `AS OF` 1 January of 2008, 2012, 2016, 2020 and 2024 draws coverage over time. | Usefulness, effective use of MariaDB |
| 0:55–1:25 | **Live:** Finnish vs Russian: summary, chips *Fact 8 · Loaded 2 · Omission 2 · Emphasis 5 · Audience 1*, click Fact, the France row. Fallback: deck slide 4. | **The same thing told differently.**<br>- Coverage is length; agreement is content. Claude reads the aligned paragraphs and scores agreement on what both share (Russian 72).<br>- 18 differences, each labelled: an audience difference is legitimate (extra context for other readers); emphasis, loaded wording and omission are framing.<br>- Fact: Finnish lists France among the first states to recognise Finland; Russian says France refused.<br>- The Russian article follows the Finnish one on terror, camps and courts, but leaves out the long-term causes and calls the Red rising a coup.<br>- Every quote is checked as an exact substring of the stored text: 18/18. | Originality, usefulness |
| 1:25–2:00 | **Live:** `timesearch.html`. Type `Finland's relationship with NATO`, drag to 2015, click "…and what changed since". Hover citation ¹, click it to open the 2014 revision on fi.wikipedia. | **Ask Wikipedia in any year:** the brief's own question.<br>- Retrieval is `FOR SYSTEM_TIME AS OF` plus vector search; the sources are the article texts as they read that day.<br>- Claude answers only from them, with the Citations API.<br>- 2015: a NATO partner that had not applied. Today: member since April 2023.<br>- Every sentence links to the exact version. | Usefulness, demo quality, both tracks |
| 2:00–2:20 | Deck slide 5 (Kielipeili's coverage statement), then slide 7 (architecture: the three system-versioned tables and both pipelines). | **One SQL idea under both:** `FOR SYSTEM_TIME AS OF` + `VEC_DISTANCE_COSINE`.<br>- 862,076 versions of 19,742 articles with real edit times (`system_versioning_insert_history`); 170,300 time-stamped article vectors; every paragraph of the nine Kielipeili articles, in six languages, in `lens_chunk`. One MariaDB 12.3.3. | Effective use of MariaDB, both tracks |
| 2:20–2:35 | **Quick cuts:** galaxy `?year=2007.92` → strata `?page=1256` → Edit Wars, or deck slide 9 (14 more lenses). | **The rest of the hub: 14 tools on the same history** (Ask is one of them), one finding each: 26% of today's Winter War article was written in 2006; 45,626 reverts but only 1,305 true edit wars; "105 päivää" first written 6 Dec 2009. | Design, originality |
| 2:35–2:50 | Deck slide 8 (recall table). | **What we learned about MariaDB:** an HNSW index over all history rows reaches recall@10 0.47 under `AS OF` at default settings and can return duplicate rows. Exact search is 100% correct in about 115 ms, so we use it. Repro in `docs/mariadb-vector-svt-duplicates.md`. | Implementation, MariaDB |
| 2:50–3:00 | Deck slide 12 (team, repo; add a QR to the demo). | **Close:** is every Wikipedia telling the same story, and was it always? Now you can measure it, in one database. We are [TEAM NAME]. | |

**If the network fails mid-demo:** say "Here's the recording" and play the video from 0:08. Its
voiceover covers the same points.

## Likely judge questions

**How is the Kielipeili score computed?**

- Two numbers per language, matching the host's two dimensions of distance.
- **Coverage** (the big number) is computed in MariaDB. Every paragraph of every language version is a
  bge-m3 vector in `lens_chunk`. For each Finnish paragraph `AS OF` a moment, the nearest paragraph of the
  other language `AS OF` the same moment; coverage is the share of Finnish text (by characters) whose best
  match has cosine ≥ 0.60. It is one statement (`app/kielipeili.py: SCORE_SQL`). Aligned pairs, shown side
  by side, are mutual nearest neighbours with cosine ≥ 0.55.
- **Agreement** (the small number) is Claude's 0–100 judgement of how consistently the other version treats
  the content both share, on facts and framing. It is told not to penalise length, so a short but faithful
  article can score high: Swedish covers 28% of the Finnish Civil War article and still agrees at 72.
- Each difference is classified: fact, or framing labelled audience, emphasis, loaded or omission. Every
  quote must be an exact substring of the stored text, and we check that (18/18 for Finnish vs Russian).

**Is it fair to score other languages against Finnish?**

- Finnish is the reference only because this is a Finnish-history dataset, where the Finnish article is
  the natural yardstick (115k characters for the Civil War). The SQL takes the reference language as a
  parameter; the page uses Finnish.
- Coverage alone says nothing about bias: an English reader needs less detail on Finnish politics and more
  context. That is why content differences are classified, and **audience differences are treated as
  legitimate**, as the challenge host suggested. Emphasis, loaded wording and omissions are what we flag.
- The score says where to look, and the quotes on both sides let a reader judge for themselves.

**Where does the Russian, German and Ukrainian data come from?**

- The challenge dataset has fi, sv and en. For the nine Kielipeili articles we fetched all six language
  versions from Wikipedia ourselves (`scripts/lens_fetch.py`): the current versions plus the versions
  that were current in 2008, 2012, 2016, 2020 and 2024, loaded with their real save times.

**How does it scale? This is one topic of one Wikipedia.**

- **Storage.** The `article` table holds the full wikitext of all 862,076 versions. It takes about
  5.4 GB on disk for 12.2 GB of raw wikitext (computed on 13 Nov 2026: `information_schema.tables`
  for `article`, and `SUM(bytes)` over `revision`). It runs on an HDD.
- **Ingest.** It is append-only: one row per edit, and system versioning closes the previous row
  automatically. Live updates from Wikipedia's edit stream are cheap; the busiest day in our data
  had 2,033 edits.
- **Embedding.** 170,300 snapshot vectors took 14 minutes on one RTX 5090. That is roughly 12,000 a
  minute, or about 80 minutes per million vectors (simple arithmetic from that run).
- **Search.** Exact search grows linearly with rows. At 170k it is about 115 ms on the server, so it
  is fine up to some hundreds of thousands of rows. Beyond that, give each snapshot date its own table
  with its own vector index. Each index then holds only the rows valid at that date, so `AS OF` no
  longer filters away most of the graph's candidates. (One index per `PARTITION BY SYSTEM_TIME`
  partition would be neater, but a partitioned table cannot carry a vector index yet: MDEV-35315.)
- **The Ask answer.** About 9–11 s warm, streamed. Most of that is the language model; retrieval is
  milliseconds to a second. Identical questions are cached.

**Why exact search instead of the vector index?**

- The index is one HNSW graph over all history rows. `FOR SYSTEM_TIME AS OF` filters after the graph
  search, so most candidates are rows from other years and get discarded.
- We measured 5 questions × 5 dates with k = 10: recall 0.47 at the default `mhnsw_ef_search`, 0.74
  at 100, 0.91 at 1000 and 0.98 at 4000, with multi-second outliers. The index can also return the
  same row twice.
- Exact search with `IGNORE INDEX` is always right and takes about 115 ms. For a time machine, a
  wrong answer about the past is worse than 100 ms.
- The repro is in the repo. [FILED UPSTREAM? MDEV-xxxxx / not yet]

**Why system-versioned tables and not just a revisions table with timestamps?**

- `AS OF` is built into the engine. One clause gives a consistent view of the whole database at any
  moment, and it works across joins and on both the text and the vector table.
- `system_versioning_insert_history` lets us load Wikipedia's real edit times as system time, so
  `AS OF '2015-01-01'` literally means "what Wikipedia showed that day".
- Without it, every query needs a "latest row per article before t" subquery.

**Why yearly vector snapshots, not one vector per version?**

- One vector per version would mean 862k vectors instead of 170k (5×), for little gain. An
  article's meaning rarely changes between consecutive edits.
- Each snapshot row is valid from that version's real save time until the next snapshot, so
  `AS OF` any date picks the snapshot that was current then.
- The cited text is the article version itself, linked by `?oldid=`.

**Can Claude hallucinate the past?**

- It gets only the historical texts. It is told to report what those versions said and to say so
  plainly when they don't answer the question.
- The Citations API ties every claim to a quoted passage of a specific version, and each
  superscript links to that revision on Wikipedia, so a judge can click and check.

**What about the data licence?**

- The text is Wikipedia's, licensed CC BY-SA 4.0. The data comes from the MariaDB Foundation's
  Finnish Wikipedia datasets.
- Every row keeps `page_id` and `rev_id`, and every answer and view links back to
  `fi.wikipedia.org/?curid=` / `?oldid=`, which is the attribution.
- We treat derived vectors and generated answers as share-alike too, and credit Wikipedia and its
  authors on every page.
- Our code: MIT (`LICENSE`).

**Is it useful for editors, not just readers?**

- **Immune System:** how fast vandalism is caught. The median time to revert was 4 min in 2008 and
  1.2 h in 2026, and 287 reverted versions had survived more than a year.
- **Edit Wars:** separates the 1,305 real wars from routine reverts.
- **Time Grep:** finds when a claim entered an article. For example, "105 päivää" was first written
  into the Winter War article on 6 Dec 2009.
- **Typewriter:** replays how an article's lead was rewritten.

**What's next?**

1. Kielipeili beyond nine showcase articles: every *History of Finland* article that has other language
   versions, any language as the reference, and alerts when a language's framing shifts.
2. Live ingestion from Wikipedia's edit stream, so "today" really is today.
3. All of Finnish Wikipedia, then the Swedish and English histories (the vectors are already
   cross-language).
4. Editor alerts: "what changed since you last read this", and long-surviving vandalism.
5. Per-snapshot vector indexes, and filing the HNSW + `AS OF` issue with MariaDB.
6. A public deployment. [DEMO URL]

**What was hardest?**

- Getting real edit times into system time, fitting 862k full-text versions on our hardware (the
  database lives on a GPU box's HDD), and discovering the HNSW recall problem.
- We measured the recall problem before trusting the index.

## Team

[TEAM NAME] · [NAME 1, role] · [NAME 2, role] · [NAME 3, role] · [NAME 4, role] · contact: [PHONE] ·
Discord: [HANDLE]
