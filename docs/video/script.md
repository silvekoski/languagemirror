# 2-minute pitch video: shot list and voiceover

The hard limit is 2:00. This plan ends at **1:56**, which leaves 4 s of margin.

**The order follows what the MariaDB host asked for.** His top pick was cross-language comparison with a
score per language ("if the Finnish Winter War article is the reference, Swedish 85, English 70,
Russian 13"), with AI judging the "same thing told differently" part. The brief's own flagship question is
"what did Wikipedia say about this in 2015, and what has changed since?". So the video opens on
**Kielipeili** (one story, six Wikipedias), then **Ask** (then vs now), then the one SQL idea behind both.
The hub's 14 tools (Ask lives in the first, Time Machine Search) get a 10-second montage as supporting
evidence.

- **Voiceover:** **220 words** as written (counting "[TEAM NAME]" as two). Spoken aloud it is about 231
  words, because numbers such as "862,000" and "115 milliseconds" take several words to say.
- **Estimated duration at 140 wpm:** **1:34** for the written count and **1:39** for the spoken count.
  Pauses between shots and the 10 s montage bring it to 1:53, and a silent 3 s end card makes 1:56.
- **If a take runs long,** cut the montage (shot 6) to two tools before shortening anything else. Never
  shorten the Kielipeili or Ask shots.

**Where the numbers come from.**

- **Kielipeili numbers** (coverage 28 / 72 / 57 / 34 / 35, 18 Finnish-vs-Russian differences, 18/18 quotes
  verified, the France example) are from the Kielipeili demo as Veikka captured it
  (`docs/kielipeili-before-after.png`). Its data lives in his database, not yet on the shared server. If
  the lens tables are rebuilt, the scores can move: **before recording the voiceover, check that the
  tiles on screen still show these numbers**, and change the voiceover if they do not.
- **Everything else** matches `README.md` and was re-checked against the database on 13 Nov 2026. The two
  NATO answers quoted below were produced by the live app on 13 Nov 2026 (see "The NATO answer").

## Shot list

Kielipeili URLs are on the machine that holds the lens tables (see "How to record"); written here as
`http://localhost:8000`. All other app URLs are on the laptop dev server `http://localhost:8000`.

| # | Time | On screen (page, URL, action) | Voiceover | Words |
|---|---|---|---|---|
| 1 | 0:00–0:08 | Black title card in large serif type: *"How much of the Finnish story does each Wikipedia tell?"* Under it, small: *"Finnish Civil War · six Wikipedias"*. | How much of Finland's history does each Wikipedia tell? And was it always told this way? | 16 |
| 2 | 0:08–0:30 | `http://localhost:8000/kielipeili.html?topic=Suomen%20sis%C3%A4llissota&lang=ru`, scrolled to the top.<br>1. Hold on the hero ("One story, six Wikipedias", the article picker showing *Suomen sisällissota · Finnish Civil War*).<br>2. Scroll a little so the six score tiles fill the frame. In post, zoom 150% onto the tiles (still: `docs/media/kielipeili-scores.jpg`).<br>3. Move the cursor slowly along the tiles: Suomi 100 → Svenska 28 → English 72 → Deutsch 57 → Русский 34 → Українська 35.<br>*Lower third:* "Kielipeili demo: 9 showcase articles × 6 languages · Coverage = share of the Finnish text with a semantic match · bge-m3 paragraph vectors in MariaDB". | This is Kielipeili. The Finnish Civil War article is the reference. English covers 72 percent, German 57, Russian 34, Swedish only 28. Every paragraph in six languages is a vector in MariaDB, so coverage is the share of Finnish text with a match. | 43 |
| 3 | 0:30–0:50 | Same page. Scroll to the three charts (Coverage over time, Agreement by language, Kinds of difference), hold 2 s, then to **Finnish vs Russian**: the summary and the filter chips *All 18 · Fact 8 · Loaded 2 · Omission 2 · Emphasis 5 · Audience 1*. Click **Fact 8** and scroll to the France difference (still: `docs/media/kielipeili-fact-france.jpg`). Hover its ✓.<br>*Caption on the France row:* "Finnish: France among the first to recognise Finland · Russian: France refused". *Overlay:* "Claude Opus 5.5 · quotes verified 18/18". | Coverage is length. Claude compares what both versions share: eighteen differences between Finnish and Russian. Audience differences are fine. Facts are not: Finnish lists France among the first to recognise Finland; Russian says France refused. Every quote is checked word for word. | 42 |
| 4 | 0:50–1:10 | `http://localhost:8000/timesearch.html`, box empty, slider at "now".<br>1. Type exactly `Finland's relationship with NATO` (straight apostrophe, no question mark), press Enter.<br>2. Drag the year slider to **2015**.<br>3. Click **"…and what changed since"**. The answer is cached and appears at once.<br>4. Hold on the first paragraph ("…a NATO peace partner, but had not applied for membership"), then scroll to "Finland became a full member in April 2023".<br>5. Hover citation ¹ (tooltip: *Suomen Nato-keskustelu (2014-12-01)*), click it; the `fi.wikipedia.org/?oldid=…` tab opens with the old-revision banner. Hold 1 s, Ctrl+W.<br>*Overlay:* "Answers only from the 2015 versions · Citations API". | And the challenge's own question: what did Wikipedia say then, and what changed since? Finland and NATO, as of 2015: a partner that had not applied. Today: a member since April 2023. Every claim links to the exact version. | 39 |
| 5 | 1:10–1:26 | Same tab: expand **"The SQL"**, then dissolve to the SQL card (below) for about 8 s.<br>*Lower third:* "862,076 versions · 19,742 articles · 170,300 vectors · one MariaDB 12.3.3". | Both rest on one SQL idea. 862,000 versions, yearly vectors, and paragraphs in six languages sit in system-versioned tables with real edit times. Time travel plus vector distance, in one statement. | 31 |
| 6 | 1:26–1:36 | Montage, about 2.5 s each, no clicks: `galaxy.html?year=2007.92` (orbit slightly) → `strata.html?page=1256` → `editwars.html` → `timegrep.html` with "105 päivää".<br>*Captions:* "29,460 articles by meaning" · "26% of Talvisota written in 2006" · "45,626 reverts, 1,305 true wars" · "'105 päivää', first written 6 Dec 2009". | Fourteen other tools read the same history: the galaxy, the strata, edit wars, time grep. | 15 |
| 7 | 1:36–1:47 | Finding card (made in the editor, below).<br>*Small text on the card:* "repro: docs/mariadb-vector-svt-duplicates.md". | For MariaDB: under AS OF, the vector index misses over half the right answers, so we search exactly, in 115 milliseconds. | 21 |
| 8 | 1:47–1:53 | `kielipeili.html` hero again, then cut to the hub `http://localhost:8000/`. | Wikipedia Through Time: six languages, twenty-three years, one database. We are [TEAM NAME]. | 13 |
| 9 | 1:53–1:56 | End card, silent (music tail only): see below. | none | 0 |
| | | | **Total** | **220** |

The counts treat "[TEAM NAME]" as two words; adjust shot 8 if the team name is longer.

### Cards to make in the editor

**SQL card (shot 5).** Monospace text, white on the app's dark background, with `FOR SYSTEM_TIME AS OF`
and `VEC_DISTANCE_COSINE` in accent colour. Two real statements, shortened for the screen: Ask's
(`app/timesearch.py: SEARCH_SQL`) on top, Kielipeili's (`app/kielipeili.py: MATCH_SQL`) below.

```sql
-- Ask: Wikipedia as it stood on 1 Jan 2015, searched by meaning
SELECT title, rev_id, row_start
FROM article_vector_history FOR SYSTEM_TIME AS OF TIMESTAMP '2015-01-01'
ORDER BY VEC_DISTANCE_COSINE(embedding, @question) LIMIT 8;

-- Kielipeili: for each Finnish paragraph AS OF T, the nearest Russian paragraph AS OF T
SELECT a.text, (SELECT b.text FROM lens_chunk FOR SYSTEM_TIME AS OF @t AS b
                WHERE b.topic = a.topic AND b.lang = 'ru'
                ORDER BY VEC_DISTANCE_COSINE(a.emb, b.emb) LIMIT 1) AS nearest_ru
FROM lens_chunk FOR SYSTEM_TIME AS OF @t AS a
WHERE a.topic = 'Suomen sisällissota' AND a.lang = 'fi';
```

**Finding card (shot 7).**

> **HNSW vector index + `FOR SYSTEM_TIME AS OF`**
> recall@10 **0.47** at default `mhnsw_ef_search` (0.98 only at 4000, with multi-second outliers) and can return duplicate rows
> **Exact search (`IGNORE INDEX`)**: 100% correct, ~115 ms over 170,300 vectors

**End card (shot 9).**

> **Wikipedia Through Time**
> Is every Wikipedia telling the same story, and was it always?
> [TEAM NAME] · [NAME 1] · [NAME 2] · [NAME 3] · [NAME 4]
> [REPO URL] · [DEMO URL]
> MariaDB challenge, Junction 2026 · Text: Wikipedia, CC BY-SA 4.0 · Data: MariaDB Foundation's Wikipedia datasets

### Captions

Burn in English captions of the whole voiceover. Many judges watch without sound. Kielipeili's UI is in
English, but the Russian and Finnish quotes are not: the English translation under each quote carries the
meaning, so zoom onto it in shot 3.

## Kielipeili (what the camera will show)

The page is `web/kielipeili.html` (API `app/kielipeili.py`), opened on *Suomen sisällissota* (Finnish Civil
War) with Russian selected. That is also its default topic and language.

- **Score tiles:** Suomi 100 (reference, 115k characters) · Svenska 28% · English 72% · Deutsch 57% ·
  Русский 34% · Українська 35% coverage. Under each tile, Claude's agreement with the Finnish version:
  72 · 78 · 78 · 72 · 70.
- **What the two numbers mean.** Coverage is computed in MariaDB: the share of the Finnish text whose
  nearest paragraph in the other language (bge-m3 cosine) is at least 0.60, both read `AS OF` the same
  moment. Agreement is Claude's 0–100 judgement of how consistently the two versions treat the content they
  share; it is told not to penalise length. These are the host's two dimensions: length and coverage, and
  the same thing told differently.
- **Finnish vs Russian:** 18 differences (Fact 8, Loaded 2, Omission 2, Emphasis 5, Audience 1), 18/18
  quotes verified as exact substrings of the stored text. Summary: the Russian article follows the Finnish
  one closely on terror, prison camps and courts, but leaves out almost all of the long-term social and
  political causes, puts more weight on outside actors, calls the Red rising a coup and the Vaasa senate
  the "legitimate power".
- **The France example (Fact):** the Finnish article lists France among the first states to recognise
  Finland (4 January 1918); the Russian article says Great Britain, France and the United States did not
  agree to recognise independence.
- **Coverage over time:** the chart re-runs the score `FOR SYSTEM_TIME AS OF` 1 January of 2008, 2012,
  2016, 2020 and 2024, and now. Show it, but do not quote numbers from it in the voiceover.

Stills: `docs/media/kielipeili-overview.jpg` (whole page top), `kielipeili-scores.jpg` (tiles),
`kielipeili-fi-vs-ru.jpg` (charts and the Finnish-vs-Russian summary), `kielipeili-fact-france.jpg`.

## The NATO answer (what the camera will show)

The video uses an **English** question because the app answers in the language of the question. The
question is `Finland's relationship with NATO`, as of 2015, compare mode. Its cached answer (from
`localhost:8000` on 13 Nov 2026) cites 14 sources: 2012–2014 versions for the 2015 side and 2023–2026
versions marked "today".

- **2015 paragraph:** "…Finland had harmonised its equipment with NATO and was a NATO peace partner,
  but had not applied for membership." It also covers the "NATO option" and the Atlantic Council of
  Finland.
- **Today paragraph:** "…the debate intensified after Russia invaded Ukraine in early 2022, and
  Finland became a full member in April 2023 … On 17 May 2022, parliament approved the government
  report proposing membership by 188–8 … 82% of Finns viewed membership positively in 2024."

A still of this answer is at `docs/media/02c-ask-nato-2015-compare-en.jpg` (1920×1080).

**Avoid the shorter wording "Finland and NATO".** I tested it too, and its answer says "On 17 May
Finland submitted its application in Brussels", which runs the 17 May parliament vote together with
the application. A judge who knows the dates would notice.

The Finnish version (`Suomen suhde Natoon`, screenshot `02-ask-nato-2015-compare.jpg`) is the
fallback if the English answer is lost.

## How to record

### Where to record from

- **Kielipeili must be recorded from a setup where its data exists.** The lens tables (`lens_topic`,
  `lens_snapshot`, `lens_chunk`, `lens_analysis`) are in Veikka's database, not yet on the shared server,
  so on the laptop dev server `kielipeili.html` has nothing to show. Until the lens tables are loaded on
  the shared server, record shots 2, 3 and the Kielipeili half of shot 8 on **Veikka's machine**, with the
  same OBS and Chrome settings as below, and send the clips over.
  - Before recording, open the page and check that the tiles read 28 / 72 / 57 / 34 / 35 and that the
    chips read "All 18". If they differ, the data was rebuilt: re-record the voiceover with the new
    numbers, and update this file.
  - The scores and the coverage chart are computed live in MariaDB (one `SCORE_SQL` per language and
    year), so let the page finish loading ("Scoring six languages in MariaDB…" disappears) and the
    coverage chart draw before you press record.
- **Record Ask and the other tools against the laptop dev server `http://localhost:8000`, not chili's
  gunicorn.** Do not restart the dev server.
  - The Ask endpoint caches finished answers in process memory, keyed on the exact
    (question, date, compare) triple. A restart empties the cache.
  - Chili runs 3 gunicorn workers, each with its own cache, so an answer warmed there may not be warm
    on the next request.
- **The English question is already warm.** It was asked on 13 Nov 2026 at 22:15, and that cold
  answer took 13.5 s.
  - Check it before recording. The first command below should finish in well under a second (the
    vector search is not cached; only the Claude answer is):
    ```bash
    time curl -sN "http://localhost:8000/api/ask/stream?q=Finland%27s%20relationship%20with%20NATO&t=2015-01-01&compare=1" | tail -c 200
    ```
  - If it is slow, the cache was lost. Let that same command finish once (13 s or more, up to about
    30 s cold), and the answer is warm again. Or open
    `http://localhost:8000/timesearch.html?q=Finland%27s%20relationship%20with%20NATO&y=2015&ask=cmp`
    and wait for the answer.
  - **Type exactly the same question on camera:** same capitals, straight apostrophe, no trailing
    "?". Any other string is a new key and a cold 10–30 s call.

### OBS Studio

- **Video:** base and output 1920×1080, 30 fps.
- **Format:** record to MKV, then use File → Remux to MP4.
- **Encoder:** hardware if available (VAAPI/QuickSync H.264 on Intel); otherwise x264 at CRF 18,
  preset veryfast. On the i3 laptop, x264 and the three.js galaxy together can drop frames, so check
  OBS's "Stats" dock. If it drops frames, record the montage on a stronger team laptop.
- **Capture:** use a Window Capture of a Chrome window that fills a 1920×1080 display, or a Screen
  Capture of a 1080p screen. A HiDPI screen recorded at 1080p downscales cleanly.
- **Audio:** record the voiceover separately in a quiet room (Audacity: 48 kHz mono, noise reduction,
  normalise to about −16 LUFS). Record the screen without sound and edit picture to voice.
- **Cursor:** turn on the cursor and move it slowly. Turn on Do Not Disturb, quit Discord, Slack and
  mail, and hide desktop notifications.

### Chrome

- **Profile:** use a clean Chrome profile with no extensions and the bookmarks bar hidden
  (Ctrl+Shift+B). Use full screen (F11) so the tab strip and address bar disappear. Switch tabs with
  Ctrl+1 … Ctrl+8.
- **Zoom: 110% for localhost.** Chrome's zoom applies to the whole origin, so every localhost:8000
  page gets the same zoom.
  - At 110%, check that the Ask answer's first paragraph and the two answer buttons fit on one
    screen, and that all six Kielipeili tiles fit in one row.
  - The galaxy fills the window at any zoom.
  - Use zoom in post-production (crop to 150–200%) for small text: the Kielipeili tiles and quotes,
    the footer labels and the SQL.

### Tabs to pre-open and warm, in order

Load each one fully once before you press record. This also puts d3, three.js and Google Fonts from
the CDN into the browser cache.

| Ctrl+ | Tab | Warm-up |
|---|---|---|
| 1 | `http://localhost:8000/kielipeili.html?topic=Suomen%20sis%C3%A4llissota&lang=ru` (on the machine with the lens tables) | tiles, three charts and the Finnish-vs-Russian list loaded |
| 2 | `http://localhost:8000/timesearch.html` | Rehearse the full take once: type the question, drag to 2015, click compare. This also warms the embedder's cache for the question. Then reload the bare URL so the box is empty again. |
| 3 | `http://localhost:8000/galaxy.html?year=2007.92` | Wait until the stars render. |
| 4 | `http://localhost:8000/strata.html?page=1256` | layers drawn |
| 5 | `http://localhost:8000/editwars.html` | network drawn |
| 6 | `http://localhost:8000/timegrep.html` | search "105 päivää" once, so the result is on screen |
| 7 | `http://localhost:8000/` | cards loaded |
| 8 | (optional) the SQL and finding cards as slides or images | |

**Record each shot as its own clip** and cut the clips together. A fumbled shot can then be redone
alone, and the timing comes from the voiceover track, not from live clicking.

### Fallback if the network is slow

The live pages depend on several network links:

- the SSH/Tailscale tunnel to MariaDB on chili (everything except Kielipeili);
- the bge-m3 embedder on chili (needed to search a new question);
- the CDN for d3, three.js and fonts;
- fi.wikipedia.org for the `?oldid=` click;
- Anthropic's API, only if the answer cache is cold.

If the network is slow:

1. **Record the stable shots first,** while the network is good: Kielipeili, then Ask, then the
   montage. A clip recorded early is never at risk.
2. **If one live shot fails, use a still with a slow 5% zoom (Ken Burns)** from `docs/media/`:

   | Shot | Still |
   |---|---|
   | Kielipeili tiles | `kielipeili-scores.jpg`; whole page: `kielipeili-overview.jpg` |
   | Finnish vs Russian | `kielipeili-fi-vs-ru.jpg`, then `kielipeili-fact-france.jpg` |
   | Ask | `02c-ask-nato-2015-compare-en.jpg` (English); Finnish: `02-ask-nato-2015-compare.jpg` |
   | Montage | `03-galaxy-2007-jokela.jpg`, `06-strata-talvisota.jpg`, `08-editwars.jpg`, `16-timegrep-105-paivaa.jpg` |
   | Hub | `01-hub.jpg` |

   For the SQL, the editor-made card is enough. The Kielipeili stills are from Veikka's capture, so the
   whole Kielipeili part can be cut from stills if his machine is not available.
3. **If Wikipedia is slow,** skip the `?oldid=` click in shot 4. Hovering the citation tooltip is enough.
4. **If the tunnel is down,** the app on the laptop is down. Restart the tunnel with
   `scripts/db_tunnel.sh` (this does not restart the dev server), or cut the video from stills only.
   It still works with the same voiceover.

### Export and final check

- **Export settings:** H.264 High, 1920×1080, 30 fps, 8–12 Mbps, AAC 160 kbps at 48 kHz, MP4.
- **Check the length.** It must print less than 120. Aim for about 116:
  ```bash
  ffprobe -v error -show_entries format=duration -of csv=p=0 final.mp4
  ```
- **Watch it once with the sound off.** The captions and on-screen numbers should tell the story
  alone.
