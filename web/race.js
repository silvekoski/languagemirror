import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const N = 15, RUN_MS = 40000;
const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MON3 = MON.map(m => m.slice(0, 3));
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = d3.format(",");
const ymLabel = ym => `${MON3[ym % 100 - 1]} ${Math.floor(ym / 100)}`;
const ymLong = ym => `${MON[ym % 100 - 1]} ${Math.floor(ym / 100)}`;
function dur(m) {
  const y = Math.floor(m / 12), r = m % 12;
  if (!y) return `${r} month${r === 1 ? "" : "s"}`;
  return `${y} yr${r ? ` ${r} mo` : y > 1 ? "s" : ""}`;
}
const kb = b => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(1)} kB`;

const MODES = {
  bytes: { val: v => kb(v), unit: "Bar length: size of the article's latest version that month (bytes of wikitext).",
           noun: "largest article", tipVal: v => `${fmt(v)} bytes` },
  edits: { val: v => fmt(v), unit: "Bar length: human edits in the 12 months up to that month (bots excluded).",
           noun: "most edited article", tipVal: v => `${fmt(v)} human edits in 12 months` },
};

// ---------- colour: the Knowledge Galaxy's topic clusters (golden-angle hues) ----------
function hue(ci) { return ci == null ? null : ((ci * 0.61803398875) % 1) * 360; }
function barFill(p) { const h = hue(p?.[1]); return h == null ? "hsl(225,12%,32%)" : `hsl(${h},42%,34%)`; }
function capFill(p) { const h = hue(p?.[1]); return h == null ? "hsl(225,15%,62%)" : `hsl(${h},72%,66%)`; }

// ---------- state ----------
const params = new URLSearchParams(location.search);
const cache = {};
let mode = params.get("mode") === "edits" ? "edits" : "bytes";
let D, i = 0, playing = false, timer = null, selected = null, sideMode = "reigns";

async function load(m) {
  if (!cache[m]) {
    const r = await (await fetch(`/api/race/frames/${m}`)).json();
    r.leader = r.frames.map(f => f[0]?.[0] ?? null);
    r.stats = new Map(r.month_stats.map(s => [s.ym, s]));
    // reign start for each month: first month of the current leader's unbroken run at #1
    r.since = []; r.leader.forEach((p, k) => r.since.push(k && r.leader[k - 1] === p ? r.since[k - 1] : k));
    cache[m] = r;
  }
  return cache[m];
}

// ---------- chart ----------
const svg = d3.select("#chart");
const gAxis = svg.append("g").attr("class", "axis");
const gStamp = svg.append("g").attr("text-anchor", "end");   // behind the bars
const gBars = svg.append("g");
const tMo = gStamp.append("text").attr("class", "mo");
const tYr = gStamp.append("text").attr("class", "yr");
const tCorp = gStamp.append("text").attr("class", "corp");
let W = 900, H = 520, bh = 26, gap = 6, ML = 30, MR = 70;
const x = d3.scaleLinear();
const measure = svg.append("text").attr("class", "title").attr("opacity", 0);
const twCache = new Map();
function textW(s) {
  if (!twCache.has(s)) { measure.text(s); twCache.set(s, measure.node().getComputedTextLength()); }
  return twCache.get(s);
}

function layout() {
  W = $("chartBox").clientWidth;
  const small = W < 560;
  bh = small ? 20 : 24; gap = small ? 4 : 5; ML = small ? 22 : 30; MR = small ? 44 : 64;
  // narrow screens: the date stamp gets its own row under the bars instead of sitting behind them
  H = 22 + N * (bh + gap) + (small ? 52 : 0);
  svg.attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);
  x.range([ML, W - MR]);
  if (small) {
    gStamp.attr("transform", `translate(${W - 4},${H - 6})`);
    tYr.attr("x", 0).attr("y", 0);
    tMo.attr("x", -128).attr("y", -24); tCorp.attr("x", -128).attr("y", -6);
  } else {
    gStamp.attr("transform", `translate(${W - 8},${H - 40})`);
    tYr.attr("x", 0).attr("y", 0); tMo.attr("x", 0).attr("y", -84); tCorp.attr("x", 0).attr("y", 24);
  }
}
const yPos = r => 22 + r * (bh + gap);

function clipTitle(t, maxW) {
  if (textW(t) <= maxW) return t;
  let s = t;
  while (s.length > 4 && textW(s + "…") > maxW) s = s.slice(0, -1);
  return s + "…";
}

function render(k, ms = 0) {
  i = k;
  const f = D.frames[k].slice(0, N).map((e, r) => ({ id: e[0], v: e[1], title: e[2], r }));
  const max = f[0]?.v || 1;
  x.domain([0, max * 1.0]);
  const t = svg.transition().duration(ms).ease(ms > 400 ? d3.easeCubicInOut : d3.easeLinear);

  // axis gridlines
  const ticks = x.ticks(W < 560 ? 3 : 5).filter(v => v > 0);
  const tg = gAxis.selectAll("g").data(ticks, v => v).join(
    en => { const g = en.append("g").attr("opacity", 0).attr("transform", v => `translate(${x(v)},0)`);
            g.append("line").attr("y1", 14).attr("y2", H); g.append("text").attr("y", 10).attr("text-anchor", "middle"); return g; },
    up => up, ex => ex.transition(t).attr("opacity", 0).remove());
  tg.transition(t).attr("opacity", 1).attr("transform", v => `translate(${x(v)},0)`);
  tg.select("text").text(v => mode === "bytes" ? (v >= 1e6 ? `${v / 1e6} MB` : `${v / 1e3} kB`) : fmt(v));

  const bars = gBars.selectAll("g.bar").data(f, d => d.id).join(
    en => {
      const g = en.append("g").attr("class", "bar").attr("transform", `translate(0,${yPos(N + 1)})`).attr("opacity", 0);
      g.append("rect").attr("class", "body").attr("x", ML).attr("height", bh).attr("rx", 3).attr("width", 0);
      g.append("rect").attr("class", "cap").attr("height", bh).attr("width", 3).attr("x", ML);
      g.append("text").attr("class", "rank").attr("x", ML - 7).attr("y", bh / 2).attr("dy", ".35em").attr("text-anchor", "end");
      g.append("text").attr("class", "title").attr("x", ML + 9).attr("y", bh / 2).attr("dy", ".35em");
      g.append("text").attr("class", "val").attr("y", bh / 2).attr("dy", ".35em").attr("x", ML);
      g.each(function () { this.__v = 0; });
      return g;
    },
    up => up,
    ex => ex.transition(t).attr("transform", `translate(0,${yPos(N + 1)})`).attr("opacity", 0).remove()
  );
  bars.classed("sel", d => d.id === selected)
    .on("mousemove", (ev, d) => tip(ev, d)).on("mouseleave", hideTip)
    .on("click", (ev, d) => openDetail(d.id, D.months[i]));
  bars.transition(t).attr("transform", d => `translate(0,${yPos(d.r)})`).attr("opacity", 1);
  bars.select(".rank").text(d => d.r + 1);
  bars.select("rect.body").attr("fill", d => barFill(D.pages[d.id])).transition(t).attr("width", d => Math.max(2, x(d.v) - ML));
  bars.select("rect.cap").attr("fill", d => capFill(D.pages[d.id])).transition(t).attr("x", d => Math.max(ML, x(d.v) - 3));
  // title inside the bar when it fits, otherwise just past the bar end (value follows the title)
  const VW = W < 560 ? 40 : 58;            // room for the value label
  f.forEach(d => {
    const inRoom = x(d.v) - ML - 18, outRoom = W - x(d.v) - 8 - VW - 9, full = textW(d.title);
    d.inside = full <= inRoom || (full > outRoom && inRoom >= outRoom);
    d.t = clipTitle(d.title, Math.max(40, d.inside ? inRoom : outRoom)); d.tw = textW(d.t);
  });
  bars.select(".title").text(d => d.t).classed("out", d => !d.inside)
    .transition(t).attr("x", d => d.inside ? ML + 9 : x(d.v) + 8);
  bars.select(".val").transition(t)
    .attr("x", d => d.inside ? x(d.v) + 6 : x(d.v) + 8 + d.tw + 9)
    .tween("text", function (d) {
      const node = this, p = this.parentNode, a = p.__v ?? 0, ip = d3.interpolateNumber(a, d.v);
      return tt => { const v = ip(tt); p.__v = v; node.textContent = MODES[mode].val(Math.round(v)); };
    });
  bars.raise();

  // date stamp + corpus context
  const ym = D.months[k], st = D.stats.get(ym);
  tYr.text(Math.floor(ym / 100)); tMo.text(MON[ym % 100 - 1]);
  tCorp.html(mode === "bytes"
    ? `<tspan class="n">${fmt(st.articles)}</tspan> articles · <tspan class="n">${(st.total_bytes / 1e6).toFixed(1)} MB</tspan> in total`
    : `<tspan class="n">${fmt(st.human_edits)}</tspan> human edits this month`);
  caption(k);
  moveHead(k);
  $("busy").innerHTML = st.busiest_n
    ? `Busiest article in ${ymLabel(ym)}: <a href="https://fi.wikipedia.org/?curid=${st.busiest_page}" target="_blank">${esc(st.busiest_title)}</a> (${fmt(st.busiest_n)} human edits)` : "";
}

function caption(k) {
  const p = D.leader[k], s = D.since[k];
  if (p == null) { $("caption").innerHTML = "&nbsp;"; return; }
  const title = esc(D.frames[k][0][2]), held = k - s + 1;
  let html;
  if (held === 1 && k > 0 && D.leader[k - 1] != null) {
    html = `<span class="new">New #1</span><b>${title}</b> overtakes ${esc(D.frames[k - 1][0][2])}`;
  } else {
    html = `<b>${title}</b> is the ${MODES[mode].noun}: <span class="dur">${dur(held)}</span> at #1, since ${ymLabel(D.months[s])}`;
  }
  $("caption").innerHTML = html;
}

// ---------- tooltip ----------
const tipEl = $("tip");
function tip(ev, d) {
  const p = D.pages[d.id] || [];
  tipEl.hidden = false;
  tipEl.innerHTML = `<b>${esc(d.title)}</b><br><span class="mute">#${d.r + 1} in ${ymLong(D.months[i])} · ${MODES[mode].tipVal(d.v)}</span>`
    + (p[2] ? `<br><span class="mute">topic: ${esc(p[2])}</span>` : "")
    + `<br><span style="color:var(--accent)">click: read it as it stood then</span>`;
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = Math.min(ev.clientX + 14, innerWidth - r.width - 8) + "px";
  tipEl.style.top = Math.min(ev.clientY + 14, innerHeight - r.height - 8) + "px";
}
function hideTip() { tipEl.hidden = true; }

// ---------- reign ribbon (also the scrubber) ----------
const rib = d3.select("#ribbon");
const gSeg = rib.append("g"), gTicks = rib.append("g"), head = rib.append("g").attr("class", "head");
head.append("line").attr("y1", 0).attr("y2", 40);
head.append("rect").attr("x", -5).attr("y", 40).attr("width", 10).attr("height", 4).attr("rx", 2);
const rx = d3.scaleLinear();
let segs = [];
function drawRibbon() {
  const w = $("ribbon").clientWidth, RH = 34;
  rib.attr("viewBox", `0 0 ${w} 62`);
  rx.domain([0, D.months.length]).range([0, w]);
  segs = [];
  D.leader.forEach((p, k) => {
    const last = segs[segs.length - 1];
    if (last && last.p === p) last.b = k + 1; else segs.push({ p, a: k, b: k + 1, title: D.frames[k][0]?.[2] });
  });
  const s = gSeg.selectAll("g").data(segs).join(en => { const g = en.append("g"); g.append("rect"); g.append("text").attr("class", "seglab"); return g; });
  s.select("rect").attr("x", d => rx(d.a)).attr("width", d => Math.max(0.5, rx(d.b) - rx(d.a) - (rx(d.b) - rx(d.a) > 3 ? 1 : 0)))
    .attr("y", 4).attr("height", RH).attr("rx", 2).attr("fill", d => d.p == null ? "transparent" : capFill(D.pages[d.p]));
  s.select("text").attr("x", d => rx(d.a) + 6).attr("y", 4 + RH / 2).attr("dy", ".35em")
    .text(d => { const room = rx(d.b) - rx(d.a) - 12; if (room < 40) return ""; const t = d.title || "";
      const fit = Math.floor(room / 6.3); return t.length > fit ? t.slice(0, fit - 1) + "…" : t; });
  const yrs = d3.range(2004, 2027).filter(y => w > 700 || y % 4 === 0);
  gTicks.selectAll("text").data(yrs).join("text").attr("class", "tick").attr("text-anchor", "middle")
    .attr("x", y => rx(D.months.indexOf(y * 100 + 1))).attr("y", 56).text(y => y);
  moveHead(i);
}
function moveHead(k) { head.attr("transform", `translate(${rx(k + 0.5)},0)`); }
function scrubTo(ev) {
  const [mx] = d3.pointer(ev, rib.node());
  const k = Math.max(0, Math.min(D.months.length - 1, Math.floor(rx.invert(mx))));
  if (k !== i) { stop(); render(k, 200); }
}
rib.on("pointerdown", ev => { rib.node().setPointerCapture(ev.pointerId); scrubTo(ev); rib.on("pointermove", scrubTo); })
   .on("pointerup pointercancel", () => rib.on("pointermove", null))
   .on("mousemove.tip", ev => {
     const [mx] = d3.pointer(ev, rib.node()); const k = Math.floor(rx.invert(mx));
     const sg = segs.find(s => k >= s.a && k < s.b); if (!sg || sg.p == null) return hideTip();
     tipEl.hidden = false;
     tipEl.innerHTML = `<b>${esc(sg.title)}</b><br><span class="mute">#1 ${ymLabel(D.months[sg.a])} – ${ymLabel(D.months[sg.b - 1])} · ${dur(sg.b - sg.a)}</span>`;
     const r = tipEl.getBoundingClientRect();
     tipEl.style.left = Math.min(ev.clientX + 12, innerWidth - r.width - 8) + "px";
     tipEl.style.top = (ev.clientY - r.height - 12) + "px";
   }).on("mouseleave.tip", hideTip);

// ---------- playback ----------
const playBtn = $("play");
function step() {
  if (i >= D.months.length - 1) return stop();
  const ms = RUN_MS / D.months.length;
  render(i + 1, ms);
  timer = setTimeout(step, ms);
}
function play() {
  if (i >= D.months.length - 1) render(0, 0);
  playing = true; playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", "Pause");
  clearTimeout(timer); timer = setTimeout(step, 250);
}
function stop() { playing = false; clearTimeout(timer); playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", "Play"); }
playBtn.onclick = () => playing ? stop() : play();
addEventListener("keydown", ev => {
  if (ev.target.closest("input,textarea,summary")) return;
  if (ev.code === "Space") { ev.preventDefault(); playing ? stop() : play(); }
  if (ev.key === "ArrowRight") { stop(); render(Math.min(D.months.length - 1, i + 1), 300); }
  if (ev.key === "ArrowLeft") { stop(); render(Math.max(0, i - 1), 300); }
});

// ---------- side panel: reigns overview / article as of then ----------
function reigns() {
  sideMode = "reigns"; selected = null;
  const tot = new Map();
  segs.forEach(s => { if (s.p == null) return; const e = tot.get(s.p) || { p: s.p, m: 0, runs: [], title: s.title };
    e.m += s.b - s.a; e.runs.push(s); e.title = s.title; tot.set(s.p, e); });
  const list = [...tot.values()].sort((a, b) => b.m - a.m);
  const longest = segs.filter(s => s.p != null).sort((a, b) => (b.b - b.a) - (a.b - a.a))[0];
  const title = mode === "bytes" ? "Longest at #1 by size" : "Longest at #1 by attention";
  const runsTxt = e => e.runs.length === 1 ? `${ymLabel(D.months[e.runs[0].a])} – ${ymLabel(D.months[e.runs[0].b - 1])}`
    : `${e.runs.length} reigns, first ${ymLabel(D.months[e.runs[0].a])}`;
  $("side").innerHTML = `<h3>${title}, 2003–2026</h3>
    ${list.slice(0, 6).map(e => `<div class="reign" data-p="${e.p}" data-k="${e.runs[e.runs.length - 1].a}">
      <i style="background:${capFill(D.pages[e.p])}"></i><span class="t">${esc(D.pages[e.p]?.[0] || e.title)}</span>
      <span class="m">${dur(e.m)}</span><span class="p">${runsTxt(e)}</span></div>`).join("")}
    <p class="fact"><b>${list.length}</b> different articles have been #1. Longest unbroken run:
      <b>${esc(longest.title)}</b>, ${dur(longest.b - longest.a)} (${ymLabel(D.months[longest.a])} – ${ymLabel(D.months[longest.b - 1])}).</p>
    <p class="fact mute" style="border:0;padding-top:0;margin-top:6px">Click a bar to open that article exactly as it stood that month, read from MariaDB's system-versioned history.</p>`;
  $("side").querySelectorAll(".reign").forEach(el => el.onclick = () => { stop(); render(+el.dataset.k, 600); });
}

async function openDetail(pid, ym) {
  stop(); selected = pid; sideMode = "detail";
  gBars.selectAll("g.bar").classed("sel", d => d.id === pid);
  const p = D.pages[pid] || [];
  $("side").innerHTML = `<button class="back">← all #1 reigns</button><h3>As of ${ymLong(ym)}</h3>
    <h2>${esc(p[0] || "")}</h2><div class="spin">Reading <code>FOR SYSTEM_TIME AS OF</code>…</div>`;
  $("side").querySelector(".back").onclick = reigns;
  const a = await (await fetch(`/api/race/asof/${pid}/${ym}`)).json();
  if (selected !== pid) return;
  const h = a.history;
  const frame = D.frames[D.months.indexOf(ym)].findIndex(e => e[0] === pid);
  let body = `<button class="back">← all #1 reigns</button><h3>As of ${ymLong(ym)}${frame >= 0 ? ` · #${frame + 1}` : ""}</h3>
    <h2>${esc(a.title || p[0])}</h2>
    <div class="sub">${p[2] ? `topic: ${esc(p[2])} · ` : ""}first written ${h.first_year ?? "?"}</div>
    <div class="stats">
      <div class="stat"><b>${kb(a.len ?? h.bytes ?? 0)}</b><span>size of this version</span></div>
      <div class="stat"><b>${fmt(h.versions)}</b><span>versions so far</span></div>
      <div class="stat"><b>${fmt(h.editors)}</b><span>distinct editors so far</span></div>
      <div class="stat"><b style="color:var(--revert)">${fmt(+h.reverts || 0)}</b><span>reverts so far</span></div>
    </div>`;
  if (a.text_status === "ok") {
    body += `<div class="excerpt">${(a.excerpt || []).map(t => `<p>${esc(t.length > 420 ? t.slice(0, 420) + "…" : t)}</p>`).join("") || "<p class='mute'>(no prose paragraphs in this version)</p>"}</div>
      <div class="ver">Version <a href="https://fi.wikipedia.org/?oldid=${a.rev_id}" target="_blank">${a.rev_id}</a> by <b>${esc(a.user || "hidden")}</b>,
        live ${esc(a.valid_from.slice(0, 10))} → ${a.valid_to.startsWith("2038") ? "today" : esc(a.valid_to.slice(0, 10))}${a.comment ? `<br>“${esc(a.comment.slice(0, 140))}”` : ""}</div>`;
  } else {
    body += `<div class="note">${a.text_status === "not_loaded"
      ? "The full text of this article's history is not in the versioned <code>article</code> table (only articles under 0.5 MB of history plus 50 famous ones are loaded, and the bulk load is still running). Counts above come from <code>revision</code>."
      : "No version of this article existed yet at that time."}</div>`;
  }
  body += `<div class="ver"><a href="https://fi.wikipedia.org/?curid=${pid}" target="_blank">Open today's article on fi.wikipedia.org ↗</a></div>
    <details><summary>The SQL (FOR SYSTEM_TIME AS OF)</summary><pre>${esc(a.sql)}</pre></details>`;
  $("side").innerHTML = body;
  $("side").querySelector(".back").onclick = reigns;
}

// ---------- mode switching / boot ----------
function setLede() {
  const b = cache.bytes;
  if (!b) return;
  const last = b.months.length - 1, st = b.stats.get(b.months[last]);
  const total = b.month_stats.reduce((s, m) => s + m.edits, 0);
  // the longest single reign in the size race, and who ended it
  let best = null;
  b.leader.forEach((p, k) => { const s = b.since[k]; if (!best || k - s > best.b - best.a) best = { p, a: s, b: k }; });
  const ended = best.b + 1 < b.months.length ? b.frames[best.b + 1][0][2] : null;
  $("lede").innerHTML = `${fmt(total)} versions of ${fmt(st.articles)} Finnish history articles, replayed month by month.
    <b>${esc(b.frames[best.b][0][2])}</b> was the largest for ${dur(best.b - best.a + 1)}`
    + (ended ? ` until <b>${esc(ended)}</b> overtook it in ${ymLong(b.months[best.b + 1])}` : "")
    + `: what the encyclopedia wrote most about, and where editors put their attention.`;
}

async function setMode(m, k) {
  mode = m; stop();
  document.querySelectorAll(".modes .chip").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  D = await load(m);
  $("unitNote").textContent = MODES[m].unit;
  $("sqlPre").textContent = D.sql;
  layout(); drawRibbon();
  gBars.selectAll("g.bar").remove();
  render(k ?? D.months.length - 1, 0);
  if (sideMode === "detail" && selected) openDetail(selected, D.months[i]); else reigns();
  const u = new URL(location); u.searchParams.set("mode", m); history.replaceState(null, "", u);
}
document.querySelectorAll(".modes .chip").forEach(b => b.onclick = () => setMode(b.dataset.mode, i));

await load("bytes");
setLede();
const t0 = +params.get("t");
await setMode(mode, undefined);
if (t0) { const k = D.months.indexOf(t0); if (k >= 0) render(k, 0); }
if (params.get("page")) openDetail(+params.get("page"), D.months[i]);
if (params.get("play") === "1") play();
let rT; addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => { layout(); drawRibbon(); render(i, 0); }, 120); });
