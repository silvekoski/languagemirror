# Junction 2026 submission: Wikipedia Through Time

**Project name:** Wikipedia Through Time

**Tagline:** Is every Wikipedia telling the same story, and was it always?

**Challenge / track:** MariaDB, *Wikipedia Through Time*. Both tracks: RAG + system-versioned tables.

## Description

Wikipedia keeps every version of every article in every language, but you cannot compare the languages or
search the past. We put both into MariaDB system-versioned tables, with every version stored at its **real
Wikipedia save time** (`system_versioning_insert_history`) and its meaning as **bge-m3 vectors**. One idea
runs through everything: `FOR SYSTEM_TIME AS OF` plus `VEC_DISTANCE_COSINE` in the same statement.

**Kielipeili: one story, six Wikipedias.** How much of the Finnish story does each language tell, and where
does it tell it differently? Nine showcase articles on Finnish history (the Winter War, the Continuation
War, the Civil War, the Mainila shots, Mannerheim, the Lapland War, Finlandisation, Kekkonen,
Molotov–Ribbentrop) in Finnish, Swedish, English, German, Russian and Ukrainian, current versions plus the
versions of 2008, 2012, 2016, 2020 and 2024. Every paragraph of every version is a vector in a
system-versioned table (`lens_chunk`, with a `VECTOR INDEX`). Coverage of the Finnish story by language X at
time T is one SQL statement: for each Finnish paragraph `AS OF` T, the nearest X paragraph `AS OF` T;
coverage is the share of the Finnish text whose best match has cosine ≥ 0.60. Claude then reviews each
language pair: conflicting facts, and framing labelled *audience* (legitimate: other readers need other
context), *emphasis*, *loaded* or *omission*. Every quote is checked as an exact substring of the stored
text. Example from the Kielipeili demo, the Finnish Civil War (Finnish article 115k characters = reference):
coverage Swedish 28%, English 72%, German 57%, Russian 34%, Ukrainian 35%; Claude's agreement with the
Finnish version 72 / 78 / 78 / 72 / 70. Finnish vs Russian: 18 differences (8 facts, 2 loaded, 2 omission,
5 emphasis, 1 audience), 18/18 quotes verified. The Russian article follows the Finnish one closely on
terror, prison camps and courts, but leaves out almost all of the long-term social and political causes,
calls the Red rising a coup, and says France refused to recognise Finland where the Finnish article lists
France among the first to do so. A coverage-over-time chart re-reads the score `AS OF` 1 January of 2008, 2012, 2016, 2020 and 2024, and now.

**Ask Wikipedia in any year (RAG + system versioning)** answers the challenge's own question: "what did
Wikipedia say about this in 2015, and what has changed since?" Ask in Finnish, Swedish or English and pick
a year. Retrieval is `FOR SYSTEM_TIME AS OF` plus vector search over **170,300 bge-m3 vectors** (every
article as it stood on each 1 January 2004–2026, plus the latest version), with cross-language topic
matching through Wikidata ids. The sources are the article texts as they read on that date, from
**862,076 versions of 19,742 Finnish *History of Finland* articles (Feb 2003 – 1 Oct 2026), each with its
full wikitext**. Claude Opus 5.5 answers only from them with the Citations API, and every claim links to the
exact historical version (`?oldid=`). "…and what changed since" puts the answer from then next to the
answer from now. Example: "Finland and NATO" as of 1 Jan 2015 cites the NATO-debate article (Finland a NATO
partner that had not applied; 26% support in Aug 2014); today it cites membership from 4 April 2023 and 79%
support (June 2022). A warm answer takes 9–11 s and streams in.

```sql
SELECT page_id, title, rev_id
FROM article_vector_history FOR SYSTEM_TIME AS OF TIMESTAMP '2015-01-01'
ORDER BY VEC_DISTANCE_COSINE(embedding, @q) LIMIT 10;   -- semantic search over Wikipedia as it stood then
```

**Supporting evidence: 14 tools for readers and editors on the same hub page** (Ask lives in the first,
*Time Machine Search*), each with a finding from the data:

- **Knowledge Galaxy 3D:** 29,460 fi/sv/en articles placed by meaning; replay 2003 → 2026 and stars flare
  when edited (2007's brightest flare: the Jokela school shooting article).
- **Seismograph:** breaking news as quakes (Jokela, Nov 2007: 826 edits in a month; COVID, Mar 2020: 453;
  Turku attack, Aug 2017: 438).
- **Knowledge Strata, Typewriter, Time Grep:** which year wrote each sentence (26% of *Talvisota*'s
  71,851 characters date from 2006), how the lead was rewritten (214 of 2,143 edits changed it), and when a
  phrase entered an article ("105 päivää", 6 Dec 2009).
- **Edit Wars, Immune System, The Authors, Heartbeat:** 45,626 reverts but only 1,305 true wars; half of
  55,222 reverted versions gone within about 14 minutes; anonymous edits 31% (2004) → 12% (2026); busiest day
  13 Nov 2024, 1,974 of 2,033 edits by one bot.
- **Three Wikipedias, Growing Tree, Biggest Stories, Link Web 3D:** 62% of topics exist only in Finnish;
  the category tree grows from 59 KB to 134 MB; the Civil War article was the largest for 15 years 7 months;
  86,280 links among 17,374 articles today.

## What we found about MariaDB (for the MariaDB judges)

- `system_versioning_insert_history` lets real Wikipedia edit times become system time, so `AS OF` means
  "what Wikipedia showed that day", with no hand-written valid-time columns.
- A `VECTOR INDEX` works on a system-versioned table, but one HNSW graph over all history rows has low
  recall under `FOR SYSTEM_TIME AS OF`: recall@10 0.47 at the default `mhnsw_ef_search` (0.74 at 100,
  0.84 at 400, 0.91 at 1000, 0.98 at 4000 with multi-second outliers), and it can return the same row
  twice. Only 1–12% of the rows are valid at any date, so most graph candidates are filtered out. Exact
  search (`IGNORE INDEX`) over all 170,300 vectors is 100% correct in ~115 ms on the server, so time-travel
  search uses exact search. Minimal repro: `docs/mariadb-vector-svt-duplicates.md`.
- The same `AS OF` + vector pattern works at paragraph level across six languages: Kielipeili's coverage
  score is one statement over a system-versioned `lens_chunk` table, re-run `AS OF` each snapshot year (2008–2024) and now.
- Our bge-m3 reproduces the dataset's vectors (mean cosine 1.0000), so one model serves the dataset's
  current vectors and our historical ones. The 170,300 snapshot vectors took 14 minutes on an RTX 5090.

## Built with

MariaDB 12.3.3 (system-versioned tables, `VECTOR(1024)` + `VECTOR INDEX`, `VEC_DISTANCE_COSINE`, window
functions, `REGEXP_*`, `FULLTEXT`) · Python / Flask + gunicorn · d3 · three.js · bge-m3
(sentence-transformers) · Claude Opus 5.5 + Citations API. Runs on a team GPU / compute box (MariaDB datadir
on an HDD).

Data: MariaDB Foundation's Finnish Wikipedia datasets (*History of Finland*). Wikipedia text and derived
data: CC BY-SA 4.0. Code: MIT.

## Links

- **Repository:** https://github.com/henrikkvamme/junction-2026/tree/main/wikipediathroughtime
  (currently private: make it public or give the organizers access before submitting)
- **Demo:** `<DEMO URL — to confirm>` (planned: junction.bobs.build:3006 once proxied). Kielipeili and the 14 tools on one hub page. Kielipeili's data (the `lens_*` tables) is not yet on the shared server: load it there before submitting the demo link, or say in the description that Kielipeili is shown in the video and deck.
- **Video (max 2:00):** `<VIDEO URL — to be added>`
- **Pitch deck:** `docs/deck/pitch-deck.pdf` (12 slides; source `docs/deck/deck.html`)

## Team

| Name | Role | Phone | Discord |
|---|---|---|---|
| `<NAME>` | `<ROLE>` | `<PHONE>` | `<DISCORD>` |
| `<NAME>` | `<ROLE>` | `<PHONE>` | `<DISCORD>` |
| `<NAME>` | `<ROLE>` | `<PHONE>` | `<DISCORD>` |
| `<NAME>` | `<ROLE>` | `<PHONE>` | `<DISCORD>` |

## Checklist for the final submission

- [ ] **Video link** added, and the video opens without logging in (unlisted YouTube or a public file link).
      Length checked with `ffprobe`: under 120 s.
- [ ] **Deck PDF** (`docs/deck/pitch-deck.pdf`) uploaded; its team slide and links filled in (re-render it
      from `deck.html` after editing).
- [ ] **Demo link** works from outside our network (open it on a phone over mobile data).
- [ ] **Source link** is accessible to the organizers: repository public, or organizers added as
      collaborators. Check it in a private browser window while logged out.
- [ ] **Team phone numbers and Discord handles** filled in, here, in the README and on the deck.
- [ ] Placeholders gone: no `<…>` or `[NAME]`-style placeholders left in the submission text, README, deck or video end card.
- [ ] **Kielipeili on the hosted demo:** the `lens_*` tables loaded on the shared server, and the Civil War tiles still read
      28 / 72 / 57 / 34 / 35 with 18 Finnish-vs-Russian differences (otherwise update the numbers in the text, deck and video).
- [ ] Project set to **FINAL before Sunday 10:00**.
- [ ] **Whole team present for peer review, Sunday 10:30.**
