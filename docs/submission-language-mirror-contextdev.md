# Language Mirror: Context.dev submission ("The Web Is Your Real-Time Database")

Same project, video, demo and repo as the MariaDB entry. This file has the text tuned for Context.dev.

## Platform form

**Name:** Language Mirror

**Tagline:** One story, every Wikipedia, checked against the live web.

**Description:**
Ask Wikipedia about Finland's 1918 civil war and the answer depends on your language: the Russian article calls it
a coup, the Finnish one a power struggle. Readers never see this, and Wikipedia cannot settle its own disagreements.

Language Mirror compares every language edition of an article, lists the claims on which they disagree (each quoted
word for word), and settles each one on the live web with Context.dev:

- `POST /v1/web/scrape` renders every source an edition cites in a real browser (JavaScript pages, archives, most bot
  walls), so we check what the citation actually says, not its title.
- `POST /v1/web/answers` (fast mode, JSON schema) researches each disagreement on the live web for independent sources,
  with Wikipedia and its mirrors excluded, and returns structured evidence.
- Claude weighs the cited and the independent sources per edition. The page shows "✓ web sources agree / ✗ disagree"
  per claim, and each edition gets an agreement score.

Example: only the German edition ends the war on 5 May; the sources Context.dev found back 15 May. Across 19 articles:
635 claims, 320 backed by a source, 131 contradicted. Paste any Wikipedia link and about two minutes later it is
scored: 12 source checks run in parallel. Every version is stored in MariaDB at its real edit time, so the same check
works on what Wikipedia said in any year.

**Technologies used:** Context.dev (web scrape, web answers with JSON schema), MariaDB (system-versioned tables,
VECTOR index), Claude Opus 5.5 and Sonnet 5.5, NVIDIA Nemotron, Python, Flask, bge-m3, Wikidata, three.js, d3

**Links**
- Demo: https://languagemirror.bobs.build
- Source: https://github.com/henrikkvamme/junction-2026/tree/main/wikipediathroughtime (the Context.dev code is in `app/lens_engine.py`)
- Video: same YouTube link as the MariaDB entry
- Pitch deck: `wikipediathroughtime/docs/deck/language-mirror-contextdev.pdf`
- Thumbnail: `wikipediathroughtime/docs/deck/thumbnail-contextdev.png`

**Tech challenges:** Context.dev (Fully Structured Web), NVIDIA Nemotron
