// Framing check page: /api/nemotron/frame over Kielipeili's MariaDB alignment.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const NAMES = { fi: "Finnish", sv: "Swedish", en: "English", de: "German", ru: "Russian", uk: "Ukrainian" };
const name = l => NAMES[l] || l;
const params = new URLSearchParams(location.search);

function status(text, err = false) { $("status").textContent = text; $("status").className = "status" + (err ? " err" : ""); }

function mark(text, quote) {
  if (!quote) return esc(text);
  const i = text.indexOf(quote);
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + "<mark>" + esc(quote) + "</mark>" + esc(text.slice(i + quote.length));
}

async function langsFor(topic) {
  const r = await fetch(`/api/kielipeili/scores?topic=${encodeURIComponent(topic)}`).then(r => r.json());
  const langs = r.languages.map(l => l.lang);
  const fill = (sel, pick) => { sel.innerHTML = langs.map(l => `<option value="${l}">${esc(name(l))}</option>`).join(""); sel.value = pick; };
  fill($("ref"), params.get("ref") && langs.includes(params.get("ref")) ? params.get("ref") : r.base);
  const other = params.get("lang") && langs.includes(params.get("lang")) ? params.get("lang")
    : (langs.includes("ru") && $("ref").value !== "ru" ? "ru" : langs.find(l => l !== $("ref").value));
  fill($("lang"), other);
}

async function init() {
  const st = await fetch("/api/nemotron/status").then(r => r.json()).catch(() => ({ default: "claude" }));
  $("engine").value = params.get("engine") || st.default || "claude";
  if (!st.nemotron) $("engine").options[0].textContent += " (not configured)";
  const topics = await fetch("/api/kielipeili/topics").then(r => r.json());
  $("topic").innerHTML = topics.map(t => `<option value="${esc(t.topic)}">${esc(t.topic)}</option>`).join("");
  const want = params.get("topic") || (topics.find(t => t.topic === "Suomen sisällissota") || topics[0] || {}).topic;
  if (want) $("topic").value = want;
  await langsFor($("topic").value);
  $("topic").addEventListener("change", () => langsFor($("topic").value));
  status(st.nemotron ? "Nemotron is configured. Pick two editions and compare."
    : "Nemotron is not configured on this server (NVIDIA_API_KEY); Claude is used unless you pick Nemotron.");
}

function render(d) {
  const ra = d.revisions?.[d.ref], rb = d.revisions?.[d.lang];
  const link = (r, l) => r ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(name(l))} revision ${esc(r.rev_id)}</a> (${esc(r.ts.slice(0, 10))})` : esc(name(l));
  const c = d.check;
  const checkLine = `Quote check: first pass ${c.first_pass.verified}/${c.first_pass.quotes} quotes found word for word in the revisions` +
    (c.repair_round ? `; after one repair round ${c.after_repair.verified}/${c.after_repair.quotes}` : "; no repair needed") +
    ` · ${d.calls} model call${d.calls > 1 ? "s" : ""} · ${d.seconds} s${d.cached ? " (cached)" : ""} · ${d.n_pairs_aligned} aligned pairs in MariaDB, the ${d.items.length} told most differently sent`;
  const card = it => {
    const side = (lbl, l, sect, q, bad, text, en) => `<div class="side"><div class="head">${esc(lbl)} · ${esc(name(l))} · ${esc(sect || "-")}</div>
      ${q ? `<blockquote>${esc(q)}</blockquote><span class="ok">✓ exact quote from the revision</span>`
          : (bad ? `<span class="bad">✗ quote not found in the revision, not shown as evidence</span>` : "")}
      ${en ? `<div class="en">${esc(en)}</div>` : ""}
      <details><summary>full paragraph</summary><p>${mark(text, q)}</p></details></div>`;
    return `<article class="card"><h3><span class="kind ${esc(it.kind)}">${esc(it.kind)}</span>${esc(it.event)}
        <span class="mute" style="font-size:12px">cosine ${it.sim}</span></h3>
      <div>${esc(it.explanation)}</div>
      <div class="cols">${side("A", d.ref, it.section_a, it.quote_a, it.unverified_a, it.text_a, "")}
        ${side("B", d.lang, it.section_b, it.quote_b, it.unverified_b, it.text_b, it.quote_b ? it.quote_b_en : "")}</div></article>`;
  };
  $("result").innerHTML = `<div class="summary">
      <span class="engine ${d.engine === "claude" ? "claude" : ""}">${esc(d.label)}${d.engine === "nemotron" ? ` · ${esc(d.model)}` : ""}</span>
      <p>${esc(d.summary)}</p>
      <div class="check">${link(ra, d.ref)} vs ${link(rb, d.lang)}</div>
      <div class="check">${esc(checkLine)}</div></div>` + d.items.map(card).join("");
}

$("form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const q = new URLSearchParams({ topic: $("topic").value, ref: $("ref").value, lang: $("lang").value,
                                  at: $("at").value, n: $("n").value, engine: $("engine").value });
  history.replaceState(null, "", "?" + q);
  $("go").disabled = true; $("result").innerHTML = "";
  status(`${$("engine").selectedOptions[0].textContent} is reading ${name($("ref").value)} and ${name($("lang").value)} paragraph pairs… (10–60 s)`);
  try {
    const r = await fetch("/api/nemotron/frame?" + q);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    status(""); render(d);
  } catch (e) {
    status(e.message, true);
  } finally { $("go").disabled = false; }
});

init().catch(e => status("Could not load the article list: " + e.message, true));
