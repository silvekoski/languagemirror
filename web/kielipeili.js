import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

// any language edition: native and English names from the browser, colours from a palette, local flag files
const dn = (loc, l) => { try { const n = new Intl.DisplayNames([loc], { type: "language" }).of(l); return n && n !== l ? n[0].toUpperCase() + n.slice(1) : l.toUpperCase(); } catch { return l.toUpperCase(); } };
const NAME = new Proxy({}, { get: (_, l) => typeof l === "string" ? dn(l, l) : "" });
const EN = new Proxy({}, { get: (_, l) => typeof l === "string" ? dn("en", l) : "" });
const PALETTE = ["#2f6fed", "#e0a91b", "#e5484d", "#12a594", "#d6409f", "#8e4ec6", "#0b8a5f", "#f76b15", "#3e63dd", "#c2298a", "#7c5c2e", "#00a2c7"];
const langColor = l => { let h = 0; for (const ch of l) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const KINDS = ["fact", "loaded", "omission", "emphasis", "audience"];
const KIND = { fact: "Fact", loaded: "Loaded", omission: "Omission", emphasis: "Emphasis", audience: "Audience" };
const css = v => getComputedStyle(document.documentElement).getPropertyValue(`--${v}`).trim() || (/^[a-z]{2,3}$/.test(v) ? langColor(v) : "#999");
const flag = l => `<img class="flag" src="img/flags/${l}.svg" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'flagcode',textContent:'${l}'.toUpperCase()}))">`;
const STATUS = { supported: ["ok", "✓ source supports"], contradicted: ["bad", "✗ source contradicts"],
  "web-supported": ["ok", "✓ web sources agree"], "web-contradicted": ["bad", "✗ web sources disagree"],
  "cited-unconfirmed": ["mid", "cited, not confirmed"], uncited: ["none", "no citation"] };
const BACKED = st => st === "supported" || st === "web-supported";
const CKIND = { fact: "Fact", definition: "Definition", framing: "Framing" };
const CKC = { fact: "#e5484d", definition: "#3e63dd", framing: "#f76b15" };
const $ = s => document.querySelector(s);
const WP = l => `<img class="globe" src="img/wikipedia-globe.png" alt=""><img class="wm" src="img/wordmark-${l}.svg" alt="Wikipedia">`;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = (p, q) => fetch(`/api/kielipeili/${p}?` + new URLSearchParams(q)).then(r => r.json());
const tone = v => v == null ? "mid" : v >= 75 ? "good" : v >= 65 ? "mid" : "bad";

const S = { topic: null, base: "fi", cons: null, ckind: "all", ref: "fi", pairs: null, year: "now", lang: "ru", kind: "all", view: new URLSearchParams(location.search).get("view") || "b", scores: null, align: null, timeline: null, topics: [] };

async function init() {
  S.topics = await api("topics", {});
  const q = new URLSearchParams(location.search);
  S.topic = q.get("topic") || (S.topics.find(t => t.topic === "Suomen sisällissota") || S.topics[0]).topic;
  S.lang = q.get("lang") || S.lang; S.ref = q.get("ref") || null;
  fillTopics();
  $("#topic").onchange = e => setTopic(e.target.value);
  const pick = e => { const b = e.target.closest("[data-lang]"); if (!b) return;
    if (b.classList.contains("kpi")) pressCard(b);
    const l = b.dataset.lang; setPair(l === S.base ? S.ref : S.base, l === S.base ? (S.lang !== S.base ? S.lang : otherThan(S.base)) : l); };
  $("#kpis").onclick = pick; $("#agree").onclick = pick;
  $("#confFilters").onclick = e => { const b = e.target.closest("[data-ck]"); if (b) { S.ckind = b.dataset.ck; renderConflicts(); renderMix(); } };
  $("#loadForm").onsubmit = e => { e.preventDefault(); const v = $("#loadQ").value.trim(); if (v) loadArticle(v); };
  $("#editionsLine").onclick = e => { const b = e.target.closest("[data-add]"); if (b) { b.disabled = true; addEdition(b.dataset.add); } };
  $("#examples").onclick = e => { const b = e.target.closest("[data-q]"); if (b) { $("#loadQ").value = b.textContent; loadArticle(b.dataset.q); } };
  const kind = e => { const b = e.target.closest("[data-kind]"); if (b) { S.kind = S.kind === b.dataset.kind ? "all" : b.dataset.kind; renderCompare(); drawMirror(); } };
  $("#filters").onclick = kind;
  $("#mix").onclick = e => { const b = e.target.closest("[data-ck]"); if (b) { S.ckind = S.ckind === b.dataset.ck ? "all" : b.dataset.ck; renderConflicts(); renderMix(); goPage("disagreements"); } };
  $("#views").onclick = e => { const b = e.target.closest("[data-view]"); if (b) { S.view = b.dataset.view; url(); renderCompare(); } };
  $("#rows").onclick = e => { const r = e.target.closest(".dt-row"); if (r) r.nextElementSibling.hidden = !r.nextElementSibling.hidden; };
  document.querySelectorAll(".navpills a").forEach(a => a.onclick = () => {
    document.querySelectorAll(".navpills a").forEach(x => x.classList.toggle("on", x === a)); });
  addEventListener("resize", () => { if (S.timeline) drawTimeline(); if (S.align) drawMirror(); });
  $("#pairpick").onchange = () => { const r = $("#refSel").value, l = $("#langSel").value; if (r !== l) setPair(r, l); };
  $("#pairpick").onclick = e => { const b = e.target.closest("[data-preset]"); if (b) { const [r, l] = b.dataset.preset.split("-"); setPair(r, l); } };
  const pairClick = e => { const c = e.target.closest("[data-pair]"); if (c) { const [r, l] = c.dataset.pair.split("-");
    setPair(r, l); goPage("compare"); } };
  $("#heat").onclick = pairClick; $("#moves").onclick = pairClick;
  $("#yearbar").onclick = e => { const b = e.target.closest("[data-year]"); if (b) { stopPlay(); S.year = b.dataset.year; renderHeat(); }
    if (e.target.closest("#play")) togglePlay(); };
  showPage(pageOfHash(), false);
  setupStickyNav();
  // "More analysis" is folded away by default; charts inside can only measure themselves once it is open
  const more = document.getElementById("more");
  more.querySelector("summary").addEventListener("click", e => e.preventDefault());   // always open: it is a section, not a toggle
  more.addEventListener("toggle", () => { if (more.open) { if (S.timeline) drawTimeline(); if (S.pairs) renderHeat(); } });
  document.querySelectorAll('a[href="#more"]').forEach(a => a.addEventListener("click", () => { more.open = true; }));
  setTopic(S.topic);
}

// every small tile flips once when pressed (glass theme); the press still does its normal job
document.addEventListener("pointerdown", e => {
  if (e.button !== 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const t = e.target.closest(".move, .chip, .yearbar .yr, .added, .seg button");
  if (!t) return;
  const el = t;
  el.classList.remove("tilepress"); void el.offsetWidth; el.classList.add("tilepress");
  el.addEventListener("animationend", () => el.classList.remove("tilepress"), { once: true });
});

// ---------- pages: one hash per page, sections tagged with data-page ----------
const PAGES = ["overview", "disagreements", "compare", "history", "details"];
const pageOfHash = () => { const h = location.hash.slice(1); return PAGES.includes(h) ? h : "overview"; };
function showPage(p, scroll = true) {
  document.body.dataset.page = p;
  document.querySelectorAll("main [data-page]").forEach(el => { el.hidden = el.dataset.page !== p; });
  document.querySelectorAll("[data-go]").forEach(a => a.classList.toggle("on", a.dataset.go === p));
  // charts measure themselves: draw the ones on the page that just appeared
  requestAnimationFrame(() => {
    if (p === "overview") { if (S.timeline) drawTimeline(); renderAgree(); renderMix(); cardsGL?.layout(false); }
    if (p === "compare" && S.align) drawMirror();
    if (p === "history" && S.pairs) renderHeat();
  });
  if (scroll) { const tabs = $("#pagetabs"); const y = tabs.getBoundingClientRect().top + scrollY - 70; if (scrollY > y) window.scrollTo({ top: y, behavior: "smooth" }); }
}
function goPage(p) { if (pageOfHash() === p) showPage(p); else location.hash = p; }
addEventListener("hashchange", () => showPage(pageOfHash()));

function setupStickyNav() {
  const nav = $("#stickynav"), links = [...document.querySelectorAll("#snLinks a")];
  new IntersectionObserver(([e]) => nav.classList.toggle("show", !e.isIntersecting), { threshold: 0 }).observe($(".hero"));
  const vis = new Map();
  const io = new IntersectionObserver(es => {
    es.forEach(e => vis.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0));
    const best = [...vis.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) links.forEach(a => {
      const on = a.getAttribute("href") === "#" + best[0]; a.classList.toggle("on", on);
      if (on && nav.classList.contains("show")) a.scrollIntoView({ block: "nearest", inline: "center" });
    });
  }, { threshold: [0, .15, .4, .7], rootMargin: "-110px 0px -35% 0px" });
  void io;   // pages replace scroll sections: the active link follows the page (showPage)
  $("#snFlags").onclick = e => { const b = e.target.closest("[data-lang]"); if (b) setPair(S.ref === b.dataset.lang ? S.base : S.ref, b.dataset.lang); };
}

function renderStickyNav() {
  const t = S.topics.find(x => x.topic === S.topic);
  $("#snTitle").innerHTML = `${esc(t?.titles.en || S.topic)} <span class="mute">· ${flag(S.ref)}${EN[S.ref]} vs ${flag(S.lang)}${EN[S.lang]}</span>`;
  $("#snFlags").innerHTML = (S.scores?.languages || []).filter(l => l.lang !== S.ref).map(l =>
    `<button data-lang="${l.lang}" class="${l.lang === S.lang ? "on" : ""}" title="${EN[l.lang]}">${flag(l.lang)}</button>`).join("");
}

const otherThan = l => (S.scores?.languages || []).map(x => x.lang).find(x => x !== l);
const url = () => history.replaceState(null, "", `?topic=${encodeURIComponent(S.topic)}${S.ref && S.ref !== S.base ? `&ref=${S.ref}` : ""}&lang=${S.lang}${S.view !== "b" ? `&view=${S.view}` : ""}#${pageOfHash()}`);

// every request starts at once; alignments are memoised per topic+language so tile clicks are instant
const alignCache = new Map();
const getAlign = (topic, lang, ref = "fi") => {
  const k = `${topic}|${ref}|${lang}`;
  if (!alignCache.has(k)) alignCache.set(k, api("align", { topic, lang, ref }));
  return alignCache.get(k);
};

function fillTopics() {
  $("#topic").innerHTML = S.topics.map(t => `<option value="${esc(t.topic)}">${esc(t.topic)}${
    t.titles.en && t.titles.en !== t.topic ? ` · ${esc(t.titles.en)}` : ""}</option>`).join("");
  $("#topic").value = S.topic;
}

// load any article: the server finds every edition on Wikidata, keeps the longest ones, embeds and scores them

// loading status: seven plain stages, one bar for the whole job, the current stage with its own count
const STAGES = [
  { key: "find", label: "Find every language edition", via: "Wikidata", re: /^Finding every language edition/, w: 3 },
  { key: "read", label: "Read each edition and measure its length", via: "Wikipedia", re: /^Measur/, w: 8 },
  { key: "embed", label: "Turn every paragraph into a vector", via: "bge-m3", re: /^Embedding/, w: 34 },
  { key: "store", label: "Store paragraphs with vector index", via: "MariaDB", re: /^Storing/, w: 4 },
  { key: "score", label: "Match paragraphs across languages and score", via: "MariaDB vector search", re: /^(Scoring|Copies do not count)/, w: 6 },
  { key: "claude", label: "Find where the editions disagree", via: "Claude", re: /^Claude/, w: 25 },
  { key: "sources", label: "Check the cited and independent sources", via: "Context.dev · Google Books", re: /^(Fetching the cited|Finding the cited books)/, w: 20 },
];
const stageOf = step => STAGES.findIndex(s => s.re.test(step || ""));
const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function renderProgress(j, reached, t0, label) {
  const cur = j.state === "done" ? STAGES.length : reached;
  const within = j.total ? Math.min(1, j.done / j.total) : 0.15;
  const W = STAGES.reduce((a, s) => a + s.w, 0);
  const pct = cur >= STAGES.length ? 100 : Math.round(100 * (STAGES.slice(0, Math.max(0, cur)).reduce((a, s) => a + s.w, 0) + (cur >= 0 ? STAGES[cur].w * within : 0)) / W);
  $("#progBar").style.width = `${Math.max(2, pct)}%`;
  $("#progTitle").textContent = j.state === "error" ? "Could not load" : `Loading ${label}`;
  $("#progTime").textContent = `${pct}% · ${clock(performance.now() - t0)} elapsed · usually 1–2 min`;
  $("#progSteps").innerHTML = STAGES.map((st, i) => {
    const state = i < cur ? "done" : i === cur ? "now" : "todo";
    const detail = i === cur && j.state !== "error"
      ? (j.total ? ` · ${j.done} of ${j.total}` : "") + (/^Copies do not count/.test(j.step) ? ` · ${esc(j.step.replace(/ 0\/0$/, "").replace("Copies do not count: adding", "near-copies skipped, adding"))}` : "")
      : "";
    return `<li class="${state}"><span class="ic"></span><span class="lb">${st.label}${detail}</span><span class="via">${st.via}</span></li>`;
  }).join("") + (j.state === "error" ? `<li class="err"><span class="ic"></span><span class="lb">${esc(j.error || "failed")}</span></li>` : "");
}

async function loadArticle(text) { return runJob("load", { q: text }, text.replace(/^https?:\/\/[a-z-]+\.wikipedia\.org\/wiki\//, "").replace(/_/g, " ")); }
async function addEdition(lang) { return runJob("add", { topic: S.topic, langs: [lang] }, `the ${EN[lang]} edition`); }

async function runJob(path, body, label = "") {
  const prog = $("#loadProg"); prog.hidden = false;
  try { label = decodeURIComponent(label); } catch { /* keep */ }
  const t0 = performance.now(); let reached = -1;
  renderProgress({ state: "running", step: "", done: 0, total: 0 }, reached, t0, label);
  prog.scrollIntoView({ behavior: "smooth", block: "center" });
  const r = await fetch(`/api/kielipeili/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
  if (r.error) { renderProgress({ state: "error", error: r.error, step: "" }, reached, t0, label); return; }
  for (;;) {
    await new Promise(ok => setTimeout(ok, 1000));
    const j = await api("job", { id: r.job });
    if (j.topic && !label) label = j.topic;
    const st = stageOf(j.step);
    if (st > reached) reached = st;                         // stages only move forward (copies loop back to embedding briefly)
    if (st >= 0 && st < reached && STAGES[st].key === "embed") j.step = "Copies do not count: adding editions";
    if (/^Already loaded/.test(j.step)) reached = STAGES.length - 1;
    renderProgress(j, reached, t0, label || j.topic || "");
    if (j.topic && !S.topics.some(t => t.topic === j.topic) && STAGES[reached]?.key === "score") {
      S.topics = await api("topics", {}); fillTopics();
    }
    if (j.state === "error") return;
    if (j.state === "done" || j.state === "missing") {
      renderProgress({ ...j, state: "done" }, STAGES.length, t0, label);
      S.topics = await api("topics", {}); S.topic = j.topic || S.topic; fillTopics();
      setTimeout(() => { prog.hidden = true; }, 1500);
      S.ref = null; alignCache.clear(); setTopic(S.topic); return;
    }
    if (j.topic && j.topic !== S.topic && STAGES[reached]?.key === "claude") {   // scores are ready: show them while Claude works
      S.topics = await api("topics", {}); S.topic = j.topic; fillTopics(); S.ref = null; setTopic(S.topic);
    }
  }
}

async function loadConsensus(topic) {
  const c = await api("consensus", { topic });
  if (topic !== S.topic) return;
  S.cons = c.missing ? null : c;
  renderKpis(); renderAgree(); renderConflicts(); renderMix(); renderEditions(); renderHero();
}

async function setTopic(topic) {
  S.topic = topic; S.scores = S.timeline = null; S.cons = null; S.ckind = "all"; url();
  $("#kpis").innerHTML = `<div class="pending">Scoring every edition in MariaDB…</div>`;
  loadConsensus(topic);
  const scoresP = api("scores", { topic });
  S.pairs = null; api("pairs", { topic }).then(p => { if (topic === S.topic) { S.pairs = p; S.year = "now"; renderHeat(); renderMoves(); } });
  api("timeline", { topic }).then(t => { if (topic === S.topic) { S.timeline = t; drawTimeline(); renderGrowth(); $("#sqlText").textContent = t.sql; } });
  loadStory(topic);
  const s = await scoresP;
  if (topic !== S.topic) return;
  S.scores = s; S.base = s.base; $("#tau").textContent = s.tau;
  const langs = s.languages.map(l => l.lang);
  if (!S.ref || !langs.includes(S.ref)) S.ref = S.base;
  if (!langs.includes(S.lang) || S.lang === S.ref) S.lang = langs.find(l => l !== S.ref);
  await setPair(S.ref, S.lang);
  langs.forEach(l => l !== S.base && getAlign(topic, l, S.base));   // prefetch the rest
}

// compare any two languages; the language cards and charts above always measure against Finnish
async function setPair(ref, lang) {
  S.ref = ref; S.lang = lang; S.kind = "all"; S.showAll = false; url();
  renderKpis(); renderAgree(); renderPairPick(); renderStickyNav(); renderConflicts(); if (S.timeline) drawTimeline(); if (S.pairs) renderHeat();
  const topic = S.topic, key = `${topic}|${ref}|${lang}`, p = getAlign(topic, lang, ref);
  if (!S.align || S.align._key !== key) $("#rows").innerHTML = `<div class="pending">Aligning ${EN[ref]} and ${EN[lang]} paragraphs…</div>`;
  const a = await p;
  if (lang !== S.lang || ref !== S.ref || topic !== S.topic) return;
  S.align = { ...a, _key: key };
  renderHero(); renderMix(); renderCompare(); renderOnly(); renderPairs(); drawMirror();
  $("#paraPanel").hidden = true;
  loadGaps(topic, ref, lang);
}

function renderPairPick() {
  const langs = (S.scores?.languages || []).map(l => l.lang);
  const sel = (id, v) => `<select id="${id}">${langs.map(l => `<option value="${l}" ${l === v ? "selected" : ""}>${EN[l]}</option>`).join("")}</select>`;
  $("#pairpick").innerHTML = `<span class="pp-l">Compare</span>${flag(S.ref)}${sel("refSel", S.ref)}<span class="pp-l">with</span>${flag(S.lang)}${sel("langSel", S.lang)}
    ${langs.includes("ru") && langs.includes("uk") && !(S.ref === "ru" && S.lang === "uk") ? `<button class="chip" data-preset="ru-uk">${flag("ru")}Russian ↔ ${flag("uk")}Ukrainian</button>` : ""}
    ${S.ref !== S.base ? `<button class="chip" data-preset="${S.base}-${S.lang === S.base ? otherThan(S.base) : S.lang}">${flag(S.base)}back to ${EN[S.base]}</button>` : ""}`;
}

function items() {
  const an = S.align?.analysis;
  return [...(an?.facts || []).map(f => ({ ...f, kind: "fact", note: f.issue })), ...(an?.framing || [])]
    .filter(i => KINDS.includes(i.kind)).sort((p, q) => KINDS.indexOf(p.kind) - KINDS.indexOf(q.kind));
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
function renderHero() {
  if (!S.scores) return;
  const n = S.scores.languages.length, six = document.querySelector(".hero h1 .six");
  if (six && six.firstChild?.nodeType === 3) six.firstChild.textContent = `${WORDS[n] || n} `;
  const fc = S.cons?.factcheck, conf = fc?.conflicts || [];
  const vs = conf.flatMap(c => c.versions || []);
  const stat = (icon, label, v) => `<span class="stat">${icon} ${label} <b>${v}</b></span>`;
  $("#heroStats").innerHTML = [
    stat("◎", "Editions compared", S.scores.languages.length + (S.cons?.editions?.length > S.scores.languages.length ? ` of ${S.cons.editions.length}` : "")),
    stat("⇄", "Disagreements found", conf.length),
    stat("✓", "Claims backed by a source", `${vs.filter(v => BACKED(v.status)).length}/${vs.length}`),
    stat("◇", "Consensus facts", S.cons?.n_consensus ?? "–"),
  ].join("");
}

function renderEditions() {
  const c = S.cons;
  if (!c) { $("#editionsLine").textContent = ""; $("#methodBody").innerHTML = ""; return; }
  const eds = c.editions?.length ? c.editions : c.langs.map(p => ({ lang: p.lang, prose_chars: p.chars, picked: 1 })).sort((a, b) => b.prose_chars - a.prose_chars);
  const picked = eds.filter(e => e.picked), rest = eds.filter(e => !e.picked);
  $("#editionsLine").innerHTML = `No edition is the reference. ${picked.length === eds.length ? `All ${picked.length} editions` :
    `The ${picked.length} longest of ${eds.length} editions found on ${LOGO("wikidata")}Wikidata`} are compared (prose length:
    ${picked.map(e => `${flag(e.lang)}${Math.round(e.prose_chars / 1000)}k`).join(" ")}).${rest.length ? `<span class="addeds"> Add an edition:
    ${rest.slice(0, 10).map(e => `<button class="added" data-add="${e.lang}" title="Load the ${EN[e.lang]} edition (${e.prose_chars} chars of prose) and score again">+ ${flag(e.lang)}${e.lang} ${(e.prose_chars / 1000).toFixed(1)}k</button>`).join("")}</span>` : ""}`;
  const w = c.weights;
  $("#methodBody").innerHTML = `<p><b>Index = ${w.coverage} × coverage + ${w.agreement} × agreement + ${w.sourcing} × sourcing.</b>
    No single language is ground truth: Wikipedia's ground truth is its sources.</p>
    <dl>
      <dt>${LOGO("mariadb")}Coverage</dt><dd>Share of the <b>${c.n_consensus} consensus facts</b> this edition tells. A consensus fact is a group of paragraphs that
        at least ${c.k} editions tell: paragraphs are matched across languages by bge-m3 vectors (mutual nearest neighbours, cosine ≥ ${c.tau}),
        one SQL statement per language pair in MariaDB. Measures how much of the shared story is told, not length.</dd>
      <dt>${LOGO("claude")}Agreement</dt><dd>Where editions disagree, Claude lists each edition's claim (quoted exactly; quotes are checked). Each edition's cited
        sources are read (pages rendered by ${LOGO("contextdev")}Context.dev), and Context.dev also searches the live web for independent sources (Wikipedia and its
        mirrors excluded). An edition earns a point when its own source or the independent sources back its claim, or, if none settles it, when it sides with
        the larger group. Near-copies of each other vote once.</dd>
      <dt>Sourcing</dt><dd>Share of the edition's text that sits in paragraphs with at least one citation.</dd>
    </dl>`;
}

function renderKpis() {
  if (S.cons) return renderConsensusCards();
  if (!S.scores) return;
  $("#kpis").innerHTML = S.scores.languages.map(l => {
    const ref = l.lang === S.base;
    return `<button class="kpi ${l.lang === S.lang ? "on" : ""}" data-lang="${l.lang}" style="--c:${css(l.lang)}" title="${esc(l.title)}">
      <div class="lbl">${flag(l.lang)}${NAME[l.lang]}</div>
      <div class="big">${ref ? 100 : l.index ?? l.coverage ?? "–"}<small>${ref ? "ref" : "index"}</small></div>${ring(ref ? 100 : l.index ?? l.coverage, l.lang)}
      <div class="meta">${ref ? `<span class="delta ref">reference</span> the story as told in Finnish`
        : `<span class="delta ${tone(l.agreement)}" title="Claude: same facts and framing on shared content">agree ${l.agreement ?? "–"}</span>
           <span title="share of the Finnish text with a counterpart">cover ${l.coverage ?? "–"}</span>`}</div>
    </button>`;
  }).join("");
}

let cardsTopic = null, cardsGL = null, cardsGLLoading = false;
// pressing a card flips it: the glass slab and the card itself turn once (studio easing); re-renders keep the turn going
function pressCard(el) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const i = [...$("#kpis").querySelectorAll(".kpi")].indexOf(el);
  S.press = { lang: el.dataset.lang, at: performance.now() };
  cardsGL?.flip(i);
  el.classList.remove("press"); void el.offsetWidth; el.classList.add("press");
}
// a re-render during the turn keeps it going: the card comes back with the class and a negative delay
const pressing = lang => S.press && S.press.lang === lang && performance.now() - S.press.at < 900;
const pressAttr = lang => pressing(lang) ? " press" : "";
const pressDelay = lang => pressing(lang) ? `animation-delay:-${Math.round(performance.now() - S.press.at)}ms` : "";
function keepPress() {}
// the language cards sit on the Glass Tiles Studio stage: one purple glass slab behind each card (kielipeili-glass.js)
function glassCards() {
  const box = $("#kpis"), fresh = cardsTopic !== S.topic; cardsTopic = S.topic;
  if (cardsGL) { cardsGL.layout(fresh); return; }
  if (cardsGLLoading || S.glassOk === false) return;
  cardsGLLoading = true;
  import("./kielipeili-glass.js?v=1794712694").then(m => {
    if (!m.glassSupported()) { S.glassOk = false; return; }
    let stage = box.parentElement;
    if (!stage.classList.contains("kg-stage")) { stage = document.createElement("div"); stage.className = "kg-stage"; box.before(stage); stage.append(box); }
    document.body.classList.add("glass-on");
    cardsGL = m.mountGlassCards(stage, box);
    requestAnimationFrame(() => cardsGL.layout(true));
  }).catch(e => { console.warn("Kielipeili glass off:", e); S.glassOk = false; });
}

function renderConsensusCards() {
  setTimeout(() => { glassCards(); keepPress(); }, 0);
  const w = S.cons.weights;
  $("#kpis").innerHTML = S.cons.langs.map(p => {
    const part = (k, v) => `<div class="part" title="${k}: ${v ?? "–"}"><span>${k}</span><span class="pbar"><i style="width:${v ?? 0}%"></i></span><b>${v ?? "–"}</b></div>`;
    const formula = `Index ${p.index} = ${w.coverage}×${p.coverage ?? "–"} coverage + ${w.agreement}×${p.agreement ?? "–"} agreement + ${w.sourcing}×${p.sourcing ?? "–"} sourcing`;
    return `<button class="kpi cons ${p.lang === S.lang || (p.lang === S.ref) ? "on" : ""}${pressAttr(p.lang)}" data-lang="${p.lang}" style="--c:${css(p.lang)};${pressDelay(p.lang)}" title="${esc(formula)}
${p.consensus_told}/${S.cons.n_consensus} consensus facts told · conflicts: ${p.agree_good} backed, ${p.agree_bad} not · ${p.chars} chars">
      <div class="lbl">${flag(p.lang)}${NAME[p.lang]}${p.copies.length ? `<span class="copy" title="near-copy of ${p.copies.map(c => EN[c]).join(", ")}">copy of ${p.copies.map(c => c.toUpperCase()).join(", ")}</span>` : ""}</div>
      <div class="big">${p.index ?? "–"}<small>index</small></div>${ring(p.index, p.lang)}
      <div class="mini-line">cover ${p.coverage ?? "–"} · agree ${p.agreement ?? "–"} · cited ${p.sourcing ?? "–"}</div>
    </button>`;
  }).join("");
}

function renderConflicts() {
  const fc = S.cons?.factcheck, list = fc?.conflicts || [];
  const rep = fc?.report || "", cut = rep.search(/(?<=[.!?])\s/);
  const by = `<span class="byline">${LOGO("claude")}Claude's reading</span>`;
  $("#report").innerHTML = !rep ? (S.cons ? `${by} comparing the editions…` : "")
    : by + (cut < 0 ? esc(rep) : `${esc(rep.slice(0, cut))} <details class="more"><summary>Read more</summary>${esc(rep.slice(cut + 1))}</details>`);
  const kinds = Object.keys(CKIND).filter(k => list.some(c => c.kind === k));
  $("#confFilters").innerHTML = list.length ? [`<button class="chip ${S.ckind === "all" ? "on" : ""}" data-ck="all">All ${list.length}</button>`,
    ...kinds.map(k => `<button class="chip ${S.ckind === k ? "on" : ""}" data-ck="${k}" style="--k:${CKC[k]}"><i></i>${CKIND[k]} ${list.filter(c => c.kind === k).length}</button>`)].join("") : "";
  const vs = list.flatMap(c => c.versions || []);
  $("#confHint").innerHTML = list.length ? `${vs.filter(v => BACKED(v.status)).length} backed by a source · ${vs.filter(v => v.status === "web-contradicted" || v.status === "contradicted").length} contradicted · web evidence from ${LOGO("contextdev")}Context.dev` : "";
  const sel = l => l === S.lang || l === S.ref;
  $("#confList").innerHTML = list.filter(c => S.ckind === "all" || c.kind === S.ckind).map(c => {
    const top = (c.groups || []).slice().sort((a, b) => b.length - a.length)[0] || [];
    const st = (c.versions || []).map(v => v.status);
    const badge = (st.some(BACKED) ? `<span class="st ok">sources back one side</span>` : st.some(x => x === "contradicted" || x === "web-contradicted") ? `<span class="st bad">sources contradict a side</span>` : "")
      + (c.web?.length ? `<span class="webchk" title="Independent sources found on the web with Context.dev">${LOGO("contextdev")}web-checked</span>` : "");
    return `<details class="conf">
      <summary><div class="conf-head"><span class="tag" style="--k:${CKC[c.kind] || "#888"}">${CKIND[c.kind] || esc(c.kind)}</span><b>${esc(c.label)}</b>${badge}<span class="conf-open">details</span></div>
        <div class="vlines">${(c.versions || []).map(v => `<div class="vline ${sel(v.lang) ? "hl" : ""}">${flag(v.lang)}<b>${v.lang.toUpperCase()}</b><span>${marks(v.claim || "")}</span></div>`).join("")}</div>
      </summary>
      <div class="rows2">${(c.versions || []).map(v => {
        const st = v.status === "supported" ? `<span class="v-st ok">✓ its source agrees</span>`
          : v.status === "contradicted" ? `<span class="v-st bad">✗ its source disagrees</span>`
          : v.status === "web-supported" ? `<span class="v-st ok" title="${esc(v.web?.note || "")}">✓ web sources agree</span>`
          : v.status === "web-contradicted" ? `<span class="v-st bad" title="${esc(v.web?.note || "")}">✗ web sources disagree</span>` : "";
        const src = sourceLine(v);
        return `<div class="row2 ${sel(v.lang) ? "hl" : ""}" style="--c:${css(v.lang)}">
          <span class="r-lang">${flag(v.lang)}${v.lang.toUpperCase()}</span>
          <div class="r-body"><div class="r-claim">${marks(v.claim || "")}${st}</div>
            ${v.quote ? `<a class="r-quote" href="${esc(articleLink(v))}" target="_blank" rel="noopener" title="Open this sentence in the ${EN[v.lang]} Wikipedia article"><img class="logo wp" src="img/wikipedia-globe.png" alt="Wikipedia" width="13" height="13">“${esc(v.quote)}”</a>` : ""}
            </div>${src}</div>`;
      }).join("")}</div>
      ${c.web?.length ? `<div class="webrow"><span class="wr-l">${LOGO("contextdev")}Independent sources <span class="mute">found with Context.dev</span></span>
        <span class="wr-c">${c.web.map((w, i) => `<a class="schip" href="${esc(w.url)}" target="_blank" rel="noopener" title="${esc(w.title + "\n\n" + w.claim + (w.quote ? "\n\n“" + w.quote + "”" : ""))}">${favicon(w.url)}<span>${esc(hostOf(w.url))}</span><em>web ${i + 1}</em></a>`).join("")}</span></div>` : ""}
      ${c.resolution ? `<p class="resol2">${esc(c.resolution)}</p>` : ""}
    </details>`;
  }).join("") || (S.cons && fc ? `<div class="pending">No disagreements of this kind.</div>` : "");
}

// ---------- citations: visible text and a link for every one ----------
const ISBN = /(?:ISBN[\s:-]*)?\b((?:97[89][\s-]?)?\d{1,5}[\s-]?\d{1,7}[\s-]?\d{1,7}[\s-]?[\dX])\b/i;
function citeLink(r, lang) {
  if (r.url) return r.url;
  const m = (r.text || "").match(/ISBN[\s:-]*([\dX][\dX\s-]{8,16}[\dX])/i);
  if (m) return `https://${lang}.wikipedia.org/wiki/Special:BookSources/${m[1].replace(/[\s-]/g, "")}`;
  const q = (r.title || r.text || "").replace(/\s+/g, " ").slice(0, 140);
  return q ? `https://www.google.com/search?tbm=bks&q=${encodeURIComponent(q)}` : null;
}
const citeLabel = r => {
  const t = (r.title ? `${r.title}${r.text && !r.text.includes(r.title) ? " · " + r.text : ""}` : r.text || r.url || r.kind).replace(/\s+/g, " ").trim();
  return t.length > 110 ? t.slice(0, 108) + "…" : t;
};
function citations(v) {
  const refs = v.refs || [], verdict = {};
  (v.sources || []).forEach((s, i) => { verdict[i] = s; });
  const HOW = { isbn: "by its ISBN", bibliography: "found in the article's bibliography", openlibrary: "ISBN found via Open Library", search: "title search" };
  const items = refs.slice(0, 4).map((r, i) => {
    const s = verdict[i] || {}, books = r.books || [];
    const exact = books.filter(b => b.how !== "search");
    const href = r.url || exact[0]?.url || books[0]?.url || citeLink(r, v.lang);
    const how = r.url ? "" : exact.length ? " · Google Books" : books.length ? " · book search" : " · search";
    const extra = books.length > 1 || (r.url && books.length) ? `<span class="cbooks">${books.slice(r.url ? 0 : 1).map(b =>
      `<a href="${esc(b.url)}" target="_blank" rel="noopener" title="${esc(HOW[b.how] || b.how)}">${esc(b.label.length > 70 ? b.label.slice(0, 68) + "…" : b.label)}</a>`).join("")}</span>` : "";
    return `<div class="citewrap"><a class="cite ${s.verdict || ""} ${exact.length ? "book" : ""}" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : ""}
      title="${esc((r.text || r.title || "") + (exact[0] ? "\n\nGoogle Books: " + exact[0].label + " (" + (HOW[exact[0].how] || "") + ")" : "") + (s.evidence ? "\n\nSource says: “" + s.evidence + "”" : ""))}">
      <span class="ck">${exact.length ? "" : ""}${esc(r.kind)}${s.verdict && s.verdict !== "silent" ? " · " + esc(s.verdict) : s.verdict === "silent" ? " · silent" : ""}${how}</span>
      <span class="ct">${esc(exact.length && !r.url ? exact[0].label : citeLabel(r))}</span></a>${extra}</div>`;
  });
  return items.join("") + (refs.length > 4 ? `<span class="cite more">+${refs.length - 4} more</span>` : "");
}
function articleLink(v) {
  const rev = S.cons?.langs?.find(p => p.lang === v.lang)?.rev_id;
  const base = rev ? `https://${v.lang}.wikipedia.org/w/index.php?oldid=${rev}` : `https://${v.lang}.wikipedia.org/wiki/${encodeURIComponent(S.topic)}`;
  const words = (v.quote || "").replace(/[“”"«»]/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return base;
  const enc = t => encodeURIComponent(t).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
  const start = words.slice(0, Math.min(4, words.length)).join(" ");
  const end = words.length > 8 ? words.slice(-3).join(" ").replace(/[.,;:]$/, "") : "";
  return `${base}#:~:text=${enc(start)}${end ? "," + enc(end) : ""}`;
}

// one quiet line of sources: short labels, duplicates removed, full citation on hover
function shortCite(r, b) {
  const t = (b?.label || r.title || r.text || r.url || r.kind || "").replace(/\s+/g, " ").trim();
  const m = t.match(/^([^:;,.(]{2,40}?)\s*,?\s*\(?((?:1[5-9]|20)\d\d)/);
  if (m) return `${m[1].trim()} ${m[2]}`;
  if (r.url && !b) { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { /* fall through */ } }
  return t.length > 36 ? t.slice(0, 34) + "…" : t;
}
const ICON = {
  book: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h7.5a2 2 0 0 1 2 2V14H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 12a2 2 0 0 1 2-2h7.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
  web: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.6 8h10.8M8 2.4c1.8 1.6 1.8 9.6 0 11.2M8 2.4c-1.8 1.6-1.8 9.6 0 11.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
};
const LOGO = n => `<img class="logo" src="img/logos/${n}.png" alt="" width="14" height="14">`;
const favicon = url => { try { const h = new URL(url).hostname; return `<img class="logo fav" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=32" alt="" width="14" height="14" onerror="this.outerHTML='${ICON.web.replace(/"/g, "&quot;").replace(/'/g, "\\'")}'">`; } catch { return ICON.web; } };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const VERDICT = { supports: ["ok", "agrees"], contradicts: ["bad", "disagrees"], silent: ["silent", "doesn't say"] };
function sourceLine(v) {
  const seen = new Set(), out = [], verdicts = v.sources || [];
  const isNote = r => !r.url && !(r.books || []).some(b => b.how !== "search") && !/\b(1[5-9]|20)\d\d\b/.test(r.text || "") && !r.title;
  (v.refs || []).slice(0, 4).forEach((r, i) => {
    if (isNote(r)) return;
    const books = (r.books || []).filter(b => b.how !== "search");
    const targets = r.url ? [{ url: r.url, label: null }] : books.length ? books : [{ url: citeLink(r, v.lang), label: null }];
    const [vc, vt] = VERDICT[verdicts[i]?.verdict] || ["", ""];
    for (const tg of targets) {
      if (!tg.url || seen.has(tg.url)) continue;
      seen.add(tg.url);
      const icon = tg.label ? LOGO("google-books")
        : r.url ? favicon(r.url)
        : /books\.google|tbm=bks/.test(tg.url) ? LOGO("google-books")
        : /Special:BookSources/.test(tg.url) ? `<img class="logo" src="img/wikipedia-globe.png" alt="" width="14" height="14">` : ICON.book;
      out.push(`<a class="schip ${vc}" href="${esc(tg.url)}" target="_blank" rel="noopener"
        title="${esc((r.text || r.title || "") + (verdicts[i]?.evidence ? "\n\nSource says: “" + verdicts[i].evidence + "”" : ""))}">
        ${icon}<span>${esc(shortCite(r, tg.label ? tg : null))}</span>${vt ? `<em>${vt}</em>` : ""}</a>`);
    }
  });
  const more = (v.refs || []).length > 4 ? `<span class="smore">+${v.refs.length - 4} more</span>` : "";
  return `<div class="r-srccol">${out.length ? out.slice(0, 4).join("") + more : `<span class="snone">no source</span>`}</div>`;
}

function ring(v, lang) {
  const r = 17, c = 2 * Math.PI * r, f = Math.max(0, Math.min(100, v || 0)) / 100;
  return `<svg class="ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="${r}" fill="none" stroke="#eef0f3" stroke-width="5"/>
    <circle cx="22" cy="22" r="${r}" fill="none" stroke="${css(lang)}" stroke-width="5" stroke-linecap="round"
      stroke-dasharray="${c * f} ${c}" transform="rotate(-90 22 22)"/></svg>`;
}

function drawMirror() {
  const m = S.align?.map; if (!m) return;
  const svg = d3.select("#mirrorSvg"); svg.selectAll("*").remove();
  const W = svg.node().getBoundingClientRect().width, H = innerWidth < 700 ? 260 : 300, L = 92, R = 12, bh = 26, y0 = 34, y1 = H - 34 - bh;
  const lang = S.lang, R0 = S.ref, cF = "url(#glassA)", cO = "url(#glassB)", gap = 1.6;
  const tot = side => d3.sum(m[side], d => d.c);
  const scale = (W - L - R) / Math.max(tot("fi"), tot("other"));
  const lay = side => { let x = L; return m[side].map(d => { const w = Math.max(1, d.c * scale - gap); const o = { ...d, x, w }; x += d.c * scale; return o; }); };
  const F = lay("fi"), O = lay("other"), tip = $("#tip");
  const pairs = S.align.pairs, byPair = side => Object.fromEntries((side === "fi" ? F : O).filter(d => d.p != null).map(d => [d.p, d]));
  const PF = byPair("fi"), PO = byPair("other");
  const show = (e, html) => { tip.hidden = false; tip.style.left = e.clientX + 14 + "px"; tip.style.top = e.clientY + 14 + "px"; tip.innerHTML = html; };
  const hide = () => tip.hidden = true;
  // labels
  const label = (y, l, n) => { const g = svg.append("g");
    g.append("image").attr("href", `img/flags/${l}.svg`).attr("x", 0).attr("y", y + bh / 2 - 7).attr("width", 18).attr("height", 14).attr("preserveAspectRatio", "xMidYMid slice");
    g.append("text").attr("x", 25).attr("y", y + bh / 2 + 4).attr("class", "mlab").text(NAME[l]);
    g.append("text").attr("x", 25).attr("y", y + bh / 2 + 18).attr("class", "msub").text(`${Math.round(n / 1000)}k chars`); };
  label(y0, R0, tot("fi")); label(y1, lang, tot("other"));
  // ribbons
  const rib = svg.append("g").attr("class", "ribs").attr("filter", "url(#ribGlow)");
  for (const [i, p] of pairs.entries()) {
    const a = PF[i], b = PO[i]; if (!a || !b) continue;
    const ya = y0 + bh, yb = y1, mid = (ya + yb) / 2, op = 0.12 + Math.max(0, (p.sim - 0.55)) * 2.2;
    rib.append("path").attr("class", "rib").attr("data-p", i).attr("fill", "url(#ribGrad)").attr("fill-opacity", Math.min(op * 1.2, .8))
      .attr("d", `M${a.x},${ya} C${a.x},${mid} ${b.x},${mid} ${b.x},${yb} L${b.x + b.w},${yb} C${b.x + b.w},${mid} ${a.x + a.w},${mid} ${a.x + a.w},${ya} Z`)
      .on("mousemove", e => show(e, `<b>${esc(a.s || "Introduction")}</b> ↔ <b>${esc(b.s || "Introduction")}</b><br>similarity ${p.sim.toFixed(2)}<br><span style="opacity:.7">${esc(p.fi.text.slice(0, 140))}…</span>`))
      .on("mouseleave", hide);
  }
  // paragraph blocks
  const defs = svg.insert("defs", ":first-child");
  const grad = (id, stops, vertical = true) => { const g = defs.append("linearGradient").attr("id", id).attr("x1", 0).attr("y1", 0).attr("x2", vertical ? 0 : 1).attr("y2", vertical ? 1 : 0);
    stops.forEach(([o, c, a = 1]) => g.append("stop").attr("offset", o).attr("stop-color", c).attr("stop-opacity", a)); };
  grad("glassA", [[0, "#a9c6ff"], [0.45, "#5b8cff"], [1, "#2c4fd6"]]);           // reference row: studio blue glass
  grad("glassB", [[0, "#a8e4ff"], [0.45, "#3fb2ff"], [1, "#1f6fd1"]]);           // other row: sky-blue glass
  grad("gloss", [[0, "#ffffff", 0.75], [0.42, "#ffffff", 0.12], [0.5, "#ffffff", 0], [1, "#ffffff", 0]]);
  grad("ribGrad", [[0, "#7aa7ff"], [1, "#4fd0ff"]]);
  const glow = (id, dev) => { const f = defs.append("filter").attr("id", id).attr("x", "-20%").attr("y", "-60%").attr("width", "140%").attr("height", "220%");
    f.append("feGaussianBlur").attr("in", "SourceGraphic").attr("stdDeviation", dev).attr("result", "b");
    const mg = f.append("feMerge"); mg.append("feMergeNode").attr("in", "b"); mg.append("feMergeNode").attr("in", "SourceGraphic"); };
  glow("blkGlow", 1.2); glow("ribGlow", 0.9);
  defs.append("pattern").attr("id", "hatch").attr("width", 5).attr("height", 5).attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)")
    .call(p => { p.append("rect").attr("width", 5).attr("height", 5).attr("fill", "#fdebc8"); p.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 5).attr("stroke", "#e0a91b").attr("stroke-width", 2); });
  const gapOf = d => S.gaps?.items?.[(d.h || "").slice(0, 12)];
  const fillOf = (d, col) => d.p != null ? col : ({ concept: "url(#hatch)", context: "#cfdcf7" }[gapOf(d)?.kind] || "#e3e9f5");
  // glass blocks: base fill, a gloss highlight, a thin bright edge; pressing one flips it (and its counterpart)
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const flipBlock = (node, delay = 0) => {
    if (still || !node) return;
    const sel = d3.select(node), d = sel.datum(), cx = d.x + d.w / 2, cy = +sel.attr("data-cy");
    sel.interrupt().transition().delay(delay).duration(820).ease(d3.easeCubicInOut)
      .attrTween("transform", () => t => `translate(${cx},${cy}) scale(1,${Math.cos(t * 2 * Math.PI).toFixed(4)}) translate(${-cx},${-cy})`)
      .on("end", () => sel.attr("transform", null));
  };
  const rows = {};
  const blocks = (arr, y, col, l, key) => {
    const g = svg.append("g").attr("class", "blocks").selectAll("g").data(arr).join("g")
      .attr("class", d => "blk" + (d.p == null ? " gap" : "")).attr("data-cy", y + bh / 2).attr("data-p", d => d.p ?? "")
      .attr("filter", d => d.p != null ? "url(#blkGlow)" : null);
    g.append("rect").attr("x", d => d.x).attr("y", y).attr("width", d => d.w).attr("height", bh).attr("rx", 3.5).attr("fill", d => fillOf(d, col));
    g.filter(d => d.p != null && d.w > 3).append("rect").attr("class", "gloss").attr("x", d => d.x + 0.5).attr("y", y + 0.5).attr("width", d => Math.max(0, d.w - 1)).attr("height", bh * 0.55).attr("rx", 3).attr("fill", "url(#gloss)");
    g.append("rect").attr("class", "edge").attr("x", d => d.x + 0.25).attr("y", y + 0.25).attr("width", d => Math.max(0, d.w - 0.5)).attr("height", bh - 0.5).attr("rx", 3.3);
    g.on("mousemove", (e, d) => { const gp = gapOf(d), other = l === R0 && l !== lang ? EN[lang] : EN[R0];
      show(e, `${NAME[l]} · <b>${esc(d.s || "Introduction")}</b><br>${d.c} chars · ${d.p != null ? "has a counterpart"
        : gp ? `<span style="color:#ffb46b">${{ concept: "no equivalent concept", context: "audience context", content: "missing" }[gp.kind] || "no counterpart"} in ${other}</span><br>${esc(gp.gist)}`
        : `<span style="color:#ffb46b">no counterpart in ${other}</span>`}<br><span style="opacity:.7">click to read</span>`); })
      .on("mouseleave", hide)
      .on("click", function (e, d) {
        flipBlock(this);
        if (d.p != null) {
          const twin = rows[key === "a" ? "b" : "a"]?.filter(x => x.p === d.p).node(); flipBlock(twin, 140);
          svg.selectAll(`.rib[data-p="${d.p}"]`).classed("lit", true).transition().delay(900).on("end", function () { d3.select(this).classed("lit", false); });
        }
        setTimeout(() => openPara(l, d, gapOf(d)), still ? 0 : 420);
      });
    rows[key] = g;
  };
  blocks(F, y0, cF, R0, "a"); blocks(O, y1, cO, lang, "b");
  // difference markers
  const marks = (arr, y, dir) => arr.forEach(d => d.k.forEach((k, j) => {
    if (S.kind !== "all" && S.kind !== k) return;
    svg.append("circle").attr("class", "mk").attr("cx", d.x + Math.min(d.w / 2, 6) + j * 9).attr("cy", y + dir * 11).attr("r", 4.5)
      .attr("fill", css(k)).attr("stroke", "#fff").attr("stroke-width", 1.5)
      .on("mousemove", e => show(e, `<b style="color:${css(k)}">${KIND[k]}</b> in ${esc(d.s || "Introduction")}<br><span style="opacity:.7">click to show these</span>`))
      .on("mouseleave", hide)
      .on("click", () => { S.kind = k; renderCompare(); drawMirror(); document.querySelector("#compare").scrollIntoView({ behavior: "smooth" }); });
  }));
  marks(F, y0, -1); marks(O, y1 + bh, 1);
  $("#mleg").innerHTML = `<span><i style="background:linear-gradient(#a9c6ff,#2c4fd6)"></i>matched</span><span><i style="background:#e3e9f5;box-shadow:inset 0 0 0 1px #c3cde2"></i>missing in the other</span>` +
    `<span><i class="hatch"></i>no equivalent concept</span><span><i style="background:#cfdcf7"></i>audience context</span>` +
    KINDS.map(k => `<span><i class="dot" style="background:${css(k)}"></i>${KIND[k]}</span>`).join("");
}

// ---------- grey paragraphs: classification and English ----------
async function loadGaps(topic, ref, lang, tries = 0) {
  S.gaps = null;
  const g = await api("gaps", { topic, ref, lang });
  if (topic !== S.topic || ref !== S.ref || lang !== S.lang) return;
  if (g.pending) {
    $("#mhint").textContent = "Claude is classifying the unmatched paragraphs… (click any paragraph to read it in English)";
    if (tries < 40) setTimeout(() => loadGaps(topic, ref, lang, tries + 1), 6000);
    return;
  }
  S.gaps = g;
  const n = Object.values(g.items || {}), c = k => n.filter(x => x.kind === k).length;
  $("#mhint").innerHTML = `Click any paragraph to read it in English. Unmatched paragraphs: <b>${c("content")}</b> missing content,
    <b>${c("concept")}</b> no equivalent concept, <b>${c("context")}</b> audience context (classified by ${LOGO("claude")}Claude).`;
  drawMirror();
}

async function openPara(lang, d, gap) {
  const el = $("#paraPanel"); el.hidden = false;
  const kind = gap ? { content: "Missing in the other edition", concept: "No equivalent concept", context: "Audience context" }[gap.kind] : d.p != null ? "Has a counterpart" : "No counterpart";
  el.innerHTML = `<div class="para-head">${flag(lang)}<b>${NAME[lang]}</b><span class="mute">· ${esc(d.s || "Introduction")}</span>
      <span class="para-kind ${gap?.kind || ""}">${kind}${gap?.term ? `: <i>${esc(gap.term)}</i>` : ""}</span><button class="para-x" aria-label="Close">×</button></div>
    ${gap?.gist ? `<p class="para-gist">${esc(gap.gist)}</p>` : ""}
    <div class="para-cols"><div><div class="para-l">Original</div><p class="para-o">…</p></div>
      <div><div class="para-l">English</div><p class="para-en mute">Translating with ${LOGO("claude")}Claude…</p></div></div>`;
  el.querySelector(".para-x").onclick = () => { el.hidden = true; };
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const r = await api("translate", { topic: S.topic, lang, h: d.h });
  if (el.hidden) return;
  el.querySelector(".para-o").textContent = r.text || "";
  const en = el.querySelector(".para-en"); en.classList.remove("mute"); en.textContent = r.en || r.error || "";
}

// ---------- how the editions changed ----------
function renderGrowth() {
  const t = S.timeline, card = $("#story");
  if (!t?.history) { card.classList.add("nodata"); return; }
  card.classList.remove("nodata");
  const first = arr => arr.find(p => (p.chars ?? p.coverage) > 0);
  const chips = Object.keys(t.sizes || {}).map(l => {
    const sz = t.sizes[l], cv = t.series[l];
    const s0 = first(sz), s1 = sz[sz.length - 1];
    const c0 = cv && first(cv), c1 = cv && cv[cv.length - 1];
    if (!s0) return null;
    const grow = s0.chars ? Math.round(100 * (s1.chars - s0.chars) / s0.chars) : 0, dc = c0 ? Math.round(c1.coverage - c0.coverage) : null;
    return { l, grow, dc, from: s0.year, kchars: Math.round(s1.chars / 1000) };
  }).filter(Boolean).sort((a, b) => b.grow - a.grow);
  $("#growth").innerHTML = chips.map(c => `<span class="gchip ${c.dc != null && c.dc <= -5 ? "down" : c.grow >= 10 ? "up" : c.grow <= -10 ? "down" : ""}" title="Article size since ${c.from}${c.dc != null ? `; coverage of the ${EN[t.ref]} article ${c.dc >= 0 ? "+" : ""}${c.dc} points` : ""}">
    ${flag(c.l)}<b>${EN[c.l]}</b> ${c.grow >= 10 ? "↑" : c.grow <= -10 ? "↓" : "→"} ${c.grow > 0 ? "+" : ""}${c.grow}% size${c.dc != null ? ` · <span class="dc ${c.dc >= 5 ? "pos" : c.dc <= -5 ? "neg" : ""}">${c.dc >= 0 ? "+" : ""}${c.dc} coverage</span>` : ""}
    <span class="mute">since ${c.from}, now ${c.kchars}k</span></span>`).join("");
}

async function loadStory(topic, tries = 0) {
  const s = await api("story", { topic });
  if (topic !== S.topic) return;
  if (s.pending) {
    $("#storyHead").textContent = "Claude is reading the history…";
    $("#storyList").innerHTML = "";
    if (tries < 30) setTimeout(() => loadStory(topic, tries + 1), 6000);
    return;
  }
  if (s.no_history) { $("#story").classList.add("nodata"); return; }
  $("#storyBy").innerHTML = `story by ${LOGO("claude")}Claude, from the numbers on this page`;
  $("#storyHead").textContent = s.headline || "";
  $("#storyList").innerHTML = (s.story || []).map(it => `<li><span class="when">${esc(it.when)}</span><span>${marks(it.text)}</span></li>`).join("");
}

function renderAgree() {
  if (S.cons) {
    const w = S.cons.weights, seg = (v, wt, cls) => `<i class="${cls}" style="width:${(v ?? 0) * wt}%"></i>`;
    $("#agree").innerHTML = S.cons.langs.map(p => `<div class="bd ${p.lang === S.lang ? "on" : ""}" data-lang="${p.lang}">
      <span class="hname">${flag(p.lang)}${EN[p.lang]}</span>
      <span class="stack" title="coverage ${p.coverage} × ${w.coverage} + agreement ${p.agreement} × ${w.agreement} + sourcing ${p.sourcing} × ${w.sourcing}">${seg(p.coverage, w.coverage, "c")}${seg(p.agreement, w.agreement, "a")}${seg(p.sourcing, w.sourcing, "s")}</span>
      <b>${p.index ?? "–"}</b></div>`).join("") +
      `<div class="bdleg"><span><i class="c"></i>coverage ×${w.coverage}</span><span><i class="a"></i>agreement ×${w.agreement}</span><span><i class="s"></i>sourcing ×${w.sourcing}</span></div>`;
    return;
  }
  if (!S.scores) return;
  $("#agree").innerHTML = S.scores.languages.filter(l => l.lang !== S.base).map(l => `
    <div class="hbar ${l.lang === S.lang ? "on" : ""}" data-lang="${l.lang}" style="--c:${css(l.lang)}">
      <span class="hname">${flag(l.lang)}${EN[l.lang]}</span><span class="track"><span class="fill" style="display:block;width:${l.agreement ?? 0}%"></span></span>
      <b>${l.agreement ?? "–"}</b></div>`).join("");
}

function renderMix() {
  const list = S.cons?.factcheck?.conflicts || [], ks = Object.keys(CKIND);
  const max = Math.max(1, ...ks.map(k => list.filter(c => c.kind === k).length));
  $("#mixLang").textContent = `across all ${S.cons?.langs?.length || ""} editions`;
  $("#mix").innerHTML = ks.map(k => {
    const n = list.filter(c => c.kind === k).length;
    return `<div class="mixcol ${S.ckind !== "all" && S.ckind !== k ? "off" : ""}" data-ck="${k}" style="--k:${CKC[k]}">
      <span class="n">${n}</span><span class="well"><span class="bar" style="height:${(n / max) * 100}%"></span></span>
      <span class="l">${CKIND[k]}</span></div>`;
  }).join("");
}

function side(lang, orig, gloss) {
  return `<div class="side" style="--c:${css(lang)}">${orig
    ? `<div class="o">${esc(orig)}</div>${gloss && lang !== "en" ? `<div class="t">${esc(gloss)}</div>` : ""}`
    : `<div class="none">Not mentioned in ${EN[lang]}</div>`}</div>`;
}

function renderCompare() {
  const it = items(), an = S.align?.analysis, lang = S.lang, R0 = S.ref;
  $("#cTitle").innerHTML = `${flag(R0)}${EN[R0]} <span style="color:var(--mute);font-weight:400">vs</span> ${flag(lang)}${EN[lang]}`;
  $("#summary").textContent = an?.summary || `No detailed review for this pair yet. The mirror above shows how the two articles line up.`;
  const none = !it.length;                                   // nothing to list: hide the filter chips, the view switch and the empty list
  ["#filters", "#views", "#rows", "#colheads"].forEach(sel => { $(sel).hidden = none; });
  $("#filters").innerHTML = [`<button class="chip ${S.kind === "all" ? "on" : ""}" data-kind="all">All ${it.length}</button>`,
    ...KINDS.map(k => { const n = it.filter(i => i.kind === k).length;
      return n ? `<button class="chip ${S.kind === k ? "on" : ""}" data-kind="${k}" style="--k:${css(k)}"><i></i>${KIND[k]} ${n}</button>` : ""; })].join("");
  $("#colheads").innerHTML = [[R0, NAME[R0]], [lang, NAME[lang]]].map(([l, n]) =>
    `<span class="wphead" style="--c:${css(l)}">${WP(l)}<b>${n}</b><a href="https://${l}.wikipedia.org/w/index.php?oldid=${
      S.scores.languages.find(x => x.lang === l)?.rev_id}" target="_blank" rel="noopener">open article ↗</a></span>`).join("");
  const shown = it.filter(i => S.kind === "all" || i.kind === S.kind);
  $("#views").innerHTML = [["b", "Diff"], ["a", "Pairs"], ["c", "Table"]].map(([v, n]) =>
    `<button class="${S.view === v ? "on" : ""}" data-view="${v}">${n}</button>`).join("");
  $("#colheads").style.display = S.view === "a" ? "" : "none";
  $("#rows").className = `view-${S.view}`;
  const short = innerWidth < 700 && !S.showAll && shown.length > 6;
  $("#rows").innerHTML = shown.length ? VIEWS[S.view](short ? shown.slice(0, 6) : shown, lang, R0) +
      (short ? `<button class="showall" id="showAll">Show all ${shown.length} differences</button>` : "")
    : `<div class="pending">No differences of this kind.</div>`;
  if (short) $("#showAll").onclick = () => { S.showAll = true; renderCompare(); };
  renderMix();
}

// English first: translation (or the original, for English), numbers highlighted
const marks = t => esc(t).replace(/(\d[\d\u00a0 ,.–-]*\d%?|\d+%?)/g, "<mark>$1</mark>");
const say = (lang, f, who) => {
  const orig = who === "fi" ? f.fi : f.other, tr = who === "fi" ? f.fi_en : f.other_en;
  return { orig, en: lang === "en" ? orig : (tr || orig) };
};
const tagOf = f => `<span class="tag" style="--k:${css(f.kind)}">${KIND[f.kind]}</span>`;
const verified = f => f.verified ? `<span class="vchk" title="Both quotes appear word for word in the articles">✓</span>` : "";

const VIEWS = {
  // A: two tinted statement boxes
  a: (list, lang, R0) => list.map(f => {
    const L = say(R0, f, "fi"), R = say(lang, f, "other");
    const box = (l, x) => `<div class="sbox" style="--c:${css(l)}"><div class="sl">${flag(l)}${NAME[l]}</div>${x.orig
      ? `<div class="en">${marks(x.en)}</div>${x.en !== x.orig ? `<div class="orig">${esc(x.orig)}</div>` : ""}`
      : `<div class="none">Not mentioned</div>`}</div>`;
    return `<div class="pa"><div class="pa-head">${tagOf(f)}<span class="pa-note">${esc(f.note)}</span>${verified(f)}</div>
      <div class="pa-boxes">${box(R0, L)}${box(lang, R)}</div></div>`;
  }).join(""),
  // B: code-diff style lines
  b: (list, lang, R0) => list.map(f => {
    const L = say(R0, f, "fi"), R = say(lang, f, "other");
    const line = (l, sign, x) => `<div class="dl" style="--c:${css(l)}"><span class="dl-sign">${sign}</span>
      <span class="dl-lang">${flag(l)}${l.toUpperCase()}</span><span class="dl-text">${x.orig ? marks(x.en) : `<em>not mentioned</em>`}</span></div>`;
    const origs = [L, R].some(x => x.orig && x.orig !== x.en)
      ? `<details class="dl-orig"><summary>show original</summary><div>${L.orig ? `<p><b>${flag(R0)}${R0.toUpperCase()}</b> ${esc(L.orig)}</p>` : ""}${R.orig ? `<p><b>${flag(lang)}${lang.toUpperCase()}</b> ${esc(R.orig)}</p>` : ""}</div></details>` : "";
    return `<div class="db"><div class="db-head">${tagOf(f)}<span>${esc(f.note)}</span>${verified(f)}</div>
      <div class="dlines">${line(R0, "−", L)}${line(lang, "+", R)}</div>${origs}</div>`;
  }).join(""),
  // C: table, click a row for the originals
  c: (list, lang, R0) => `<table class="dt"><thead><tr><th>Type</th><th>What differs</th><th>${flag(R0)}${EN[R0]} says</th><th>${flag(lang)}${EN[lang]} says</th></tr></thead><tbody>
    ${list.map((f, i) => { const L = say(R0, f, "fi"), R = say(lang, f, "other");
      return `<tr class="dt-row" data-i="${i}"><td>${tagOf(f)}</td><td class="dt-note">${esc(f.note)}</td>
        <td>${L.orig ? marks(L.en) : `<em>—</em>`}</td><td>${R.orig ? marks(R.en) : `<em>—</em>`}</td></tr>
        <tr class="dt-more" hidden><td></td><td colspan="3"><div class="dt-origs"><div style="--c:${css(R0)}">${esc(L.orig || "—")}</div>
        <div style="--c:${css(lang)}">${esc(R.orig || "—")}</div></div></td></tr>`; }).join("")}</tbody></table>`,
};

function renderOnly() {
  const an = S.align?.analysis, lang = S.lang;
  $("#onlyFiTitle").innerHTML = `${flag(S.ref)}Only in ${EN[S.ref]}`;
  $("#onlyOtherTitle").innerHTML = `${flag(lang)}Only in ${EN[lang]}`;
  const list = (l, key, tr) => (l || []).map(m => `<div class="only"><div class="s">${esc(m.section)}</div>
    ${esc(m[tr] || m[key])}${m.note ? `<div class="n">${esc(m.note)}</div>` : ""}</div>`).join("") || `<div class="only hint">Nothing significant.</div>`;
  $("#onlyFi").innerHTML = list(an?.missing, "fi", "fi_en");
  $("#onlyOther").innerHTML = list(an?.only_here, "other", "other_en");
}

function renderPairs() {
  const a = S.align;
  $("#nPairs").textContent = a.pairs.length;
  $("#pairs").innerHTML = a.pairs.map(p => `<div class="pair"><div>${esc(p.fi.text)}</div>
    <div class="sim">${p.sim.toFixed(2)}</div><div>${esc(p.match.text)}</div></div>`).join("");
}

// ---------- who resembles whom ----------
let playTimer = null;
const stopPlay = () => { clearInterval(playTimer); playTimer = null; const b = $("#play"); if (b) b.textContent = "▶ Play"; };
function togglePlay() {
  if (playTimer) return stopPlay();
  const ys = S.pairs.years; let i = Math.max(0, ys.indexOf(S.year) + 1) % ys.length;
  S.year = ys[i]; renderHeat(); $("#play").textContent = "❚❚ Pause";
  playTimer = setInterval(() => { i += 1; if (i >= ys.length) return stopPlay(); S.year = ys[i]; renderHeat(); }, 900);
}
const heatColor = v => v == null ? "#f5f6f8" : d3.interpolateRgb("#f3f5fa", "#1f4fd1")(Math.pow(v / 100, 1.2));

// 3D glass tiles (kielipeili-glass.js, three.js) on wide screens with WebGL; the table stays the fallback
let glassMod = null, glassLoading = false;
function glassHeat(langs, C) {
  if (!glassMod) {
    if (!glassLoading) {
      glassLoading = true;
      import("./kielipeili-glass.js?v=1794712694").then(m => {
        if (!m.glassSupported()) { S.glassOk = false; renderHeat(); return; }
        glassMod = m; renderHeat();
      }).catch(e => { console.warn("Kielipeili glass off:", e); S.glassOk = false; renderHeat(); });
    }
    return false;
  }
  const host = $("#heat");
  if (!S.glass || !host.querySelector(".gh-stage")) {
    S.glass = glassMod.mountGlassHeat(host, {
      flag, name: l => EN[l],
      onPick: (a, b) => { setPair(a, b); goPage("compare"); },
      onHover: (e, d) => { const tip = $("#tip"); if (!d) { tip.hidden = true; return; }
        tip.hidden = false; tip.style.left = e.clientX + 14 + "px"; tip.style.top = e.clientY + 14 + "px";
        tip.innerHTML = `${flag(d.a)}${EN[d.a]} → ${flag(d.b)}${EN[d.b]}<br><b>${d.v == null ? "–" : Math.round(d.v) + "%"}</b> of the ${EN[d.a]} article has a counterpart in ${EN[d.b]}<br><span style="opacity:.7">${S.year === "now" ? "now" : "1 Jan " + S.year} · click to compare</span>`; },
    });
    S.glassKey = null;
  }
  const key = S.topic, animate = S.glassKey === key && S.glassYear !== S.year;
  S.glass.update({ langs, get: (a, b) => C[a]?.[b] ?? null }, animate);
  S.glass.select(S.ref, S.lang);
  S.glassKey = key; S.glassYear = S.year;
  return true;
}

function renderHeat() {
  const P = S.pairs; if (!P || !P.years.length) { $("#heat").innerHTML = `<div class="pending">No pair scores yet.</div>`; return; }
  const langs = P.langs.filter(l => P.cov.now?.[l]), C = P.cov[S.year] || {};
  $("#yearbar").innerHTML = (P.years.length > 1 ? `<button id="play" class="chip">${playTimer ? "❚❚ Pause" : "▶ Play"}</button>` : "") +
    P.years.map(y => `<button class="yr ${y === S.year ? "on" : ""}" data-year="${y}">${y === "now" ? "Now" : y}</button>`).join("");
  if (S.glassOk !== false && glassHeat(langs, C)) return;
  const sel = (a, b) => (S.ref === a && S.lang === b) || (S.ref === b && S.lang === a);
  $("#heat").innerHTML = `<table class="heat"><thead><tr><th></th>${langs.map(l => `<th>${flag(l)}<span>${l.toUpperCase()}</span></th>`).join("")}</tr></thead><tbody>
    ${langs.map(a => `<tr><th>${flag(a)}<span>${EN[a]}</span></th>${langs.map(b => {
      if (a === b) return `<td class="diag"></td>`;
      const v = C[a]?.[b], dark = (v ?? 0) > 55;
      return `<td data-pair="${a}-${b}" class="${sel(a, b) ? "sel" : ""}" style="background:${heatColor(v)};color:${dark ? "#fff" : "var(--ink-2)"}"
        title="${v == null ? "" : `${Math.round(v)}% of the ${EN[a]} article has a counterpart in ${EN[b]} (${S.year === "now" ? "now" : "1 Jan " + S.year})`}">${v == null || v === 0 ? (v === 0 ? "·" : "") : Math.round(v)}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderMoves() {
  const P = S.pairs; if (!P || !P.years.length) return;
  const langs = P.langs, sym = (y, a, b) => { const x = P.cov[y]?.[a]?.[b], z = P.cov[y]?.[b]?.[a]; return x && z ? (x + z) / 2 : null; };
  const near = [], moves = [];
  for (let i = 0; i < langs.length; i++) for (let j = i + 1; j < langs.length; j++) {
    const a = langs[i], b = langs[j], now = sym("now", a, b); if (now == null) continue;
    if (now >= 85) near.push({ a, b, now });
    const first = P.years.find(y => y !== "now" && sym(y, a, b) != null);
    if (first) { const d = now - sym(first, a, b); if (d >= 10) moves.push({ a, b, d, from: first, was: sym(first, a, b), now }); }
  }
  near.sort((x, y) => y.now - x.now); moves.sort((x, y) => y.d - x.d);
  const pr = (a, b) => `${flag(a)}${EN[a]} <span class="mute">↔</span> ${flag(b)}${EN[b]}`;
  $("#moves").innerHTML =
    (near.length ? `<h4>Near-copies</h4>${near.slice(0, 4).map(n => `<button class="move" data-pair="${n.a}-${n.b}">
      <span>${pr(n.a, n.b)}</span><b class="hot">${Math.round(n.now)}%</b></button>`).join("")}` : "") +
    `<h4>Moved closer</h4>${moves.slice(0, 5).map(m => `<button class="move" data-pair="${m.a}-${m.b}">
      <span>${pr(m.a, m.b)}<small>${Math.round(m.was)}% in ${m.from} → ${Math.round(m.now)}% now</small></span><b>+${Math.round(m.d)}</b></button>`).join("")
      || `<div class="mute" style="font-size:13px">No pair moved more than 10 points.</div>`}`;
}

function drawTimeline() {
  const t = S.timeline, svg = d3.select("#timeline"); svg.selectAll("*").remove();
  $("#timeCard").hidden = !t.history; if (!t.history) return;
  const W = svg.node().clientWidth, H = 220, m = { l: 28, r: 92, t: 10, b: 24 };
  const years = ["2008", "2012", "2016", "2020", "2024", "now"];
  const x = d3.scalePoint(years, [m.l, W - m.r]), y = d3.scaleLinear([0, 100], [H - m.b, m.t]);
  svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(d => d + "%"));
  svg.append("g").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSize(0).tickPadding(9));
  const ends = Object.entries(t.series).map(([l, p]) => ({ l, y: y(p[p.length - 1].coverage) })).sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => { if (i && e.y - ends[i - 1].y < 13) e.y = ends[i - 1].y + 13; });
  const ly = Object.fromEntries(ends.map(e => [e.l, e.y])), tip = $("#tip");
  const order = Object.keys(t.series).sort(l => l === S.lang ? 1 : -1);
  for (const lang of order) {
    const pts = t.series[lang], c = css(lang), on = lang === S.lang;
    if (on) svg.append("path").datum(pts).attr("fill", c).attr("opacity", .08)
      .attr("d", d3.area().x(d => x(d.year)).y0(H - m.b).y1(d => y(d.coverage)));
    svg.append("path").datum(pts).attr("fill", "none").attr("stroke", on ? c : "#c9cdd4").attr("stroke-width", on ? 2.4 : 1.4)
      .attr("d", d3.line().x(d => x(d.year)).y(d => y(d.coverage)));
    svg.selectAll(null).data(pts).join("circle").attr("cx", d => x(d.year)).attr("cy", d => y(d.coverage))
      .attr("r", on ? 3.5 : 2).attr("fill", on ? c : "#c9cdd4")
      .on("mousemove", (e, d) => { tip.hidden = false; tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY + 12 + "px";
        tip.innerHTML = `${EN[lang]} · ${d.year}<br><b>${d.coverage}%</b> of the ${EN[t.ref || S.base]} text`; })
      .on("mouseleave", () => tip.hidden = true);
    svg.append("image").attr("href", `img/flags/${lang}.svg`).attr("x", W - m.r + 8).attr("y", ly[lang] - 5)
      .attr("width", 14).attr("height", 10).attr("preserveAspectRatio", "xMidYMid slice").attr("opacity", on ? 1 : .7);
    svg.append("text").attr("x", W - m.r + 27).attr("y", ly[lang] + 4).style("fill", on ? c : "#9aa0a8")
      .style("font-weight", on ? 600 : 400).text(EN[lang]);
  }
}

init();
