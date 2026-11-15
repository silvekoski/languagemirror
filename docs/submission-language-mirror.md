# Language Mirror: submission metadata (Junction platform + YouTube)

Paste field by field. Numbers are from the live `lens_*` tables on 15 Nov 2026.

- Video: `wikipediathroughtime/video/out/video.mp4` (1:57, 1920×1080, 48 MB; not in git). Preview: https://nixos-1.tail5b0fae.ts.net:4016/media/language-mirror.mp4
- Thumbnail: `wikipediathroughtime/docs/deck/thumbnail.png` (1280×720; source `thumbnail.html`)
- Pitch deck: `wikipediathroughtime/docs/deck/language-mirror.pdf` (11 slides). Animated HTML: `docs/deck/language-mirror.html`

---

## Junction platform

### Project name
Language Mirror

### Punchline (one line)
One story, every Wikipedia: see what each language edition tells, where they disagree, and which version the sources back.

### Description

**The problem.** Ask Wikipedia about Finland's 1918 civil war and the answer depends on your language. The Russian
article calls the rising a coup; the Finnish one calls it a power struggle. Nobody can read six Wikipedias side by
side, so gaps, framing and wrong facts go unnoticed, and some editions quietly copy others.

**What we built.** Language Mirror compares every language edition of a Wikipedia article. No edition is treated as
the truth. Each one is scored against what most editions tell (a fact counts as shared when at least three editions
tell it) and checked against sources. The index is shown on every card: 0.5 × coverage + 0.3 × agreement + 0.2 ×
sourcing.

- **Scores.** For the Finnish Civil War: Finnish 88, English 84, German 71, Russian 60, Ukrainian 54, Swedish 53.
  Swedish tells two thirds of the shared story and cites the least.
- **Disagreements, checked.** Claude lists the claims on which editions disagree and quotes each edition word for
  word. Context.dev reads the cited pages and finds independent web sources. Only the German edition ends the war on
  5 May; the sources back 15 May. Across 19 articles: 635 claims, 320 backed by a source, 131 contradicted.
- **The mirror.** Both articles paragraph by paragraph, with lines between matching paragraphs. The gaps are
  classified as missing content, a concept with no equivalent, or audience context. Click a gap to read it in English.
- **Over time.** MariaDB keeps every version at its real Wikipedia edit time, so one query compares the editions in
  any year. The Ukrainian Civil War article has followed the Russian one since it appeared in 2016: 96–100% of its
  paragraphs have a Russian match.
- **Any article.** Paste a Wikipedia link in any language. It finds the editions on Wikidata, takes the longest (and
  skips near-copies), and scores and checks them in about two minutes. Stepan Bandera: 9 of 68 editions, including
  Polish. Harald Nugiseks: Estonian ranks first. Both were the host's own test cases.

**Built on MariaDB.** Every paragraph of every version is a bge-m3 vector in one system-versioned table
(`lens_chunk`: `VECTOR(1024)`, `VECTOR INDEX` cosine, `WITH SYSTEM VERSIONING`, real edit times through
`system_versioning_insert_history`). One statement, `VEC_DISTANCE_COSINE` under `FOR SYSTEM_TIME AS OF`, powers the
scores, the mirror, the timeline and the who-resembles-whom grid. 13,024 paragraph versions in the table.

**Why it matters.** Readers see what their language leaves out or tells differently. Editors get a list of gaps and
contradicted claims, with quotes and sources. The same method works for any article in any language, on the database
that already runs Wikipedia.

### Challenge
MariaDB – Wikipedia Through Time (both tracks: RAG and system-versioned tables)

### Technologies used
MariaDB (system-versioned tables, system_versioning_insert_history, VECTOR(1024), VECTOR INDEX, VEC_DISTANCE_COSINE, FOR SYSTEM_TIME AS OF), Python, Flask, PyMySQL, bge-m3 embeddings, Claude Opus 5.5 and Claude Sonnet 5.5 (claim extraction, gap classification, translation), Context.dev (web scrape and web answers for source checks), Wikidata, three.js, d3

### Links
- Demo: https://languagemirror.bobs.build
- Source: https://github.com/henrikkvamme/junction-2026/tree/main/wikipediathroughtime (repo is private: make it public or give the organizers access)
- Video: TODO: the YouTube link after upload
- Pitch deck: upload `wikipediathroughtime/docs/deck/language-mirror.pdf`

---

## YouTube

### Title
Language Mirror: one story, every Wikipedia (MariaDB × Junction 2026)

### Description
Ask Wikipedia about Finland's 1918 civil war and the answer depends on your language: the Russian article calls it a coup, the Finnish one a power struggle.

Language Mirror compares every language edition of a Wikipedia article. No edition is the truth: each one is scored against what most editions tell, and checked against the sources. Claude lists the claims on which editions disagree, quoting each one word for word; Context.dev reads the cited pages and finds independent sources. MariaDB keeps every version at its real edit time, with every paragraph as a vector, so one query compares the editions in any year.

Try it: https://languagemirror.bobs.build

Built for the MariaDB "Wikipedia Through Time" challenge at Junction 2026.

0:00 Same war, different story
0:17 The idea: no edition is the truth
0:29 Scores per language
0:41 Disagreements, checked against sources
0:59 The mirror: paragraph by paragraph
1:09 Over time: who copies whom
1:23 Built on MariaDB: vectors + system versioning
1:37 Any article: paste a link
1:46 Language Mirror

Built with MariaDB (VECTOR, VECTOR INDEX, WITH SYSTEM VERSIONING, FOR SYSTEM_TIME AS OF), Claude, Context.dev, Wikidata and bge-m3.

### Tags
Language Mirror, Wikipedia, MariaDB, vector search, system-versioned tables, temporal tables, FOR SYSTEM_TIME AS OF, RAG, Claude, Context.dev, Wikidata, Finnish Civil War, multilingual, fact checking, Junction 2026, hackathon

### Settings
- Category: Science & Technology
- Visibility: Public or Unlisted (the platform needs a link that works without sign-in)
- Audience: not made for kids
- Thumbnail: `docs/deck/thumbnail.png`
- Language: English
