// Knowledge Strata: one article's text as sediment, layered by the year each sentence was first written.
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = d3.format(",");
const kfmt = n => n >= 10000 ? d3.format(".0f")(n / 1000) + "k" : n >= 1000 ? d3.format(".1f")(n / 1000) + "k" : String(n);
const pct = x => x > 0 && x < 0.001 ? "<0.1%" : (x * 100 >= 10 ? Math.round(x * 100) : (x * 100).toFixed(1).replace(/\.0$/, "")) + "%";
const day = d3.utcFormat("%-d %b %Y"), dayLong = d3.utcFormat("%-d %B %Y"), stamp = d3.utcFormat("%Y-%m-%d %H:%M");
const parse = s => new Date(s);
const API = "/api/strata";
const DATA_END = new Date("2026-10-01T00:00:00Z");

// sediment palette, fixed for every article so a year always has the same colour:
// old = deep warm ochre -> sand -> new = pale cyan
const Y0 = 2003, Y1 = 2026;
const ramp = d3.piecewise(d3.interpolateLab, ["#7d3a12", "#a8561f", "#c98236", "#d9aa5e", "#d8c487", "#bcd3ad", "#9fd6cf", "#bdeef6"]);
const color = y => ramp((Math.min(Y1, Math.max(Y0, +y)) - Y0) / (Y1 - Y0));
const tint = (y, a) => { const c = d3.color(color(y)); c.opacity = a; return c.formatRgb(); };
const YEARS = d3.range(Y0, Y1 + 1).map(String);

const tip = $("tip");
function showTip(ev, html) {
  tip.innerHTML = html; tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 16, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 16;
  if (y + r.height > innerHeight - 8) y = Math.max(8, ev.clientY - r.height - 14);
  tip.style.left = Math.max(8, x) + "px"; tip.style.top = y + "px";
}
const hideTip = () => { tip.style.display = "none"; };
const cleanComment = c => (c || "").replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/\/\*\s*(.*?)\s*\*\//g, "§ $1").trim();
const short = u => u.length > 16 ? u.slice(0, 15) + "…" : u;
const userLink = u => `https://fi.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(u)}`;

let S = null;          // strata payload
let PID = null;
let sel = -1;          // selected sample index
let iso = null;        // isolated year
let reqSeq = 0;
let playing = false;
const state = new URLSearchParams(location.search);

// ------------------------------------------------------------------ picker
const picker = $("picker"), pick = $("pick"), pickList = $("pickList");
let pickItems = [], pickAct = -1;
async function loadPick(q) {
  const r = await fetch(`${API}/articles?q=${encodeURIComponent(q)}`);
  const items = await r.json();
  pickItems = items; pickAct = -1;
  const fam = items.filter(x => x.famous), rest = items.filter(x => !x.famous);
  const row = x => `<div class="item" data-id="${x.page_id}"><span class="star">${x.famous ? "★" : ""}</span>${esc(x.title)}<span class="n">${x.versions ? fmt(x.versions) + " versions" : ""}</span></div>`;
  pickList.innerHTML = (fam.length ? `<div class="grp">Famous, heavily edited</div>${fam.map(row).join("")}` : "") +
    (rest.length ? `<div class="grp">${q ? "Articles with stored text" : "Most edited articles with stored text"}</div>${rest.map(row).join("")}` : "") ||
    `<div class="grp">No article with stored text matches</div>`;
}
pick.addEventListener("focus", () => { picker.classList.add("open"); loadPick(pick.value); });
pick.addEventListener("input", () => loadPick(pick.value));
pick.addEventListener("keydown", e => {
  const els = [...pickList.querySelectorAll(".item")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); pickAct = Math.max(0, Math.min(els.length - 1, pickAct + (e.key === "ArrowDown" ? 1 : -1)));
    els.forEach((el, i) => el.classList.toggle("act", i === pickAct)); els[pickAct]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && els.length) { choose(+(els[Math.max(0, pickAct)].dataset.id)); }
  else if (e.key === "Escape") { pick.blur(); picker.classList.remove("open"); }
  e.stopPropagation();
});
pickList.addEventListener("mousedown", e => { const it = e.target.closest(".item"); if (it) { e.preventDefault(); choose(+it.dataset.id); } });
document.addEventListener("mousedown", e => { if (!picker.contains(e.target)) picker.classList.remove("open"); });
function choose(id) { picker.classList.remove("open"); pick.value = ""; pick.blur(); stopPlay(); load(id, null); }

// ------------------------------------------------------------------ load
async function load(pid, t) {
  PID = pid; S = null; sel = -1; iso = null;
  $("title").innerHTML = "&nbsp;"; $("finding").innerHTML = ""; $("stats").innerHTML = "";
  d3.select("#flow").selectAll("*").remove();
  $("body").innerHTML = ""; $("vmeta").innerHTML = ""; $("when").textContent = "—"; $("agebar").innerHTML = "";
  const wrap = $("flowWrap");
  wrap.querySelectorAll(".err, .building").forEach(e => e.remove());
  let ov = null;
  for (;;) {
    const r = await fetch(`${API}/strata/${pid}`);
    if (pid !== PID) return;
    const j = await r.json();
    if (r.status === 200) { ov?.remove(); S = j; break; }
    if (r.status === 202) {
      if (!ov) { ov = document.createElement("div"); ov.className = "building"; wrap.appendChild(ov); }
      const b = j.building || {};
      const f = b.total ? b.done / b.total : 0;
      ov.innerHTML = `<div>Tracing the lineage of every sentence…<div class="bar"><i style="transform:scaleX(${f.toFixed(3)})"></i></div>
        <span class="mono">${esc(b.phase || "starting")}${b.total ? ` · ${fmt(b.done)} / ${fmt(b.total)} versions` : ""}</span><br>
        <span style="font-size:12px">first visit only: the result is cached in <code>viz_strata_*</code></span></div>`;
      $("title").textContent = j.title || "";
      await new Promise(res => setTimeout(res, 600));
      continue;
    }
    ov?.remove();
    wrap.insertAdjacentHTML("beforeend", `<div class="err building">${esc(j.error || "Could not load this article.")}</div>`);
    return;
  }
  render();
  const want = t ? parse(t) : null;
  let i = S.samples.length - 1;
  if (want && !isNaN(want)) i = Math.max(0, d3.bisector(s => s.date).right(S.samples, want) - 1);
  select(i, true);
}

// ------------------------------------------------------------------ render everything static
let X, Yc, layersG, crossG, selG, originG, H, W, M, coreX;

function render() {
  buildEvents();
  S.samples.forEach(s => { s.date = parse(s.t); });
  S.origins.forEach(o => { o.date = parse(o.t); o.year = o.t.slice(0, 4); });
  const today = S.today, byY = today.by_year, tot = today.chars;
  const lastYear = +S.last.slice(0, 4);
  document.title = `${S.title} · Knowledge Strata`;
  $("title").innerHTML = `<a href="https://fi.wikipedia.org/?curid=${S.page_id}" target="_blank" rel="noopener">${esc(S.title)}</a>`;

  // headline finding, all computed from the payload
  const thick = Object.entries(byY).sort((a, b) => b[1] - a[1])[0] || [String(lastYear), 0];
  const old = d3.sum(Object.entries(byY).filter(([y]) => +y <= lastYear - 11), d => d[1]) / tot;
  const recent = d3.sum(Object.entries(byY).filter(([y]) => +y >= lastYear - 1), d => d[1]) / tot;
  const oldest = S.oldest[0] ? S.origins[S.oldest[0].oid] : null;
  const sw = y => `<span class="sw" style="background:${color(y)}"></span>`;
  $("finding").innerHTML = `The thickest layer of today's ${esc(S.title)} was written in ${sw(thick[0])}<b>${thick[0]}</b>
    (${pct(thick[1] / tot)} of its text). ${pct(old)} is more than ten years old, ${pct(recent)} was written in ${lastYear - 1}–${lastYear}` +
    (oldest ? `, and the oldest sentence still standing dates from ${sw(oldest.year)}${dayLong(oldest.date)}.` : ".");
  const years = (parse(S.last) - parse(S.first)) / 3.15576e10;
  $("stats").innerHTML = [
    [fmt(S.versions), "versions stored"], [years.toFixed(0), "years of edits"],
    [fmt(today.sentences), "sentences today"], [fmt(today.editors), "first authors"],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join("");
  $("flowNote").innerHTML = `${S.samples.length} sampled versions · arrow keys step`;

  // legend ramp
  $("y0").textContent = Y0; $("y1").textContent = Y1;
  $("ramp").innerHTML = YEARS.map(y => `<span data-y="${y}" style="background:${color(y)}"></span>`).join("");
  $("ramp").querySelectorAll("span").forEach(el => {
    el.onclick = () => isolate(iso === el.dataset.y ? null : el.dataset.y);
    el.onmousemove = ev => {
      const y = el.dataset.y, now = byY[y] || 0, dep = S.deposited_by_year[y] || 0;
      showTip(ev, `<div class="tt">${y}</div><div class="mm">${fmt(dep)} chars first written · ${fmt(now)} still in today's article</div><div class="mm">click to isolate this layer</div>`);
    };
    el.onmouseleave = hideTip;
  });

  drawFlow();
  drawSurvival();
  drawUsers();
  drawEvents();
  drawMethod();
}

function drawFlow() {
  const svg = d3.select("#flow"); svg.selectAll("*").remove();
  const el = $("flow"); W = el.clientWidth; H = el.clientHeight;
  const narrow = W < 560;
  M = { l: narrow ? 34 : 46, r: narrow ? 104 : 128, t: 34, b: 24 };
  const coreW = narrow ? 18 : 24;
  coreX = W - M.r + (narrow ? 10 : 22);
  const rows = S.samples.map(s => { const r = { date: s.date }; for (const y of YEARS) r[y] = s.y[y] || 0; return r; });
  const end = new Date(Math.max(+DATA_END, +S.samples.at(-1).date));
  rows.push({ ...rows.at(-1), date: end });
  const stack = d3.stack().keys(YEARS)(rows);
  const maxY = d3.max(rows, r => d3.sum(YEARS, y => r[y]));
  X = d3.scaleUtc().domain([S.samples[0].date, end]).range([M.l, W - M.r]);
  // event pins sit in rows above the strata; pick the first row where the label fits
  const rowsUsed = [];
  const pins = EVENTS.map(e => {
    const x = X(e.date), label = narrow ? "" : `${e.kind === "ero" ? "−" + kfmt(e.lost) : "+" + kfmt(e.chars)}${EVENTS.length <= 4 ? " " + short(e.user) : ""}`;
    const w = label.length * 6.3 + 22;
    const fits = (a, b) => a >= 0 && b <= W - 4;
    const free = (lvl, a, b) => !(rowsUsed[lvl] || []).some(([p, q]) => a < q + 6 && b > p - 6);
    for (let lvl = 0; ; lvl++) {
      for (const right of [true, false]) {
        const a = right ? x - 10 : x - w, b = right ? x + w : x + 10;
        if ((fits(a, b) || lvl > 5) && free(lvl, a, b)) { (rowsUsed[lvl] ||= []).push([a, b]); return { e, x, label, right, lvl }; }
      }
    }
  });
  M.t = Math.max(30, 14 + rowsUsed.length * 21 + 6);
  Yc = d3.scaleLinear().domain([0, maxY * 1.05]).range([H - M.b, M.t]);

  const yAx = svg.append("g").attr("class", "axis grid").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(Yc).ticks(5).tickSize(-(W - M.r - M.l)).tickFormat((d, i, all) => kfmt(d) + (i === all.length - 1 ? " chars" : "")));
  yAx.select(".domain").remove();
  yAx.selectAll("line").attr("stroke", "rgba(255,255,255,.05)");
  yAx.selectAll(".tick text").attr("text-anchor", (d, i, all) => i === all.length - 1 ? "start" : "end")
    .attr("x", (d, i, all) => i === all.length - 1 ? 4 : -6).attr("dy", (d, i, all) => i === all.length - 1 ? "-0.5em" : "0.32em");
  svg.append("g").attr("class", "axis xaxis").attr("transform", `translate(0,${H - M.b})`)
    .call(d3.axisBottom(X).ticks(narrow ? 5 : 11).tickSizeOuter(0));

  const area = d3.area().x(d => X(d.data.date)).y0(d => Yc(d[0])).y1(d => Yc(d[1])).curve(d3.curveMonotoneX);
  layersG = svg.append("g").attr("class", "layers");
  layersG.selectAll("path").data(stack.filter(s => d3.max(s, d => d[1] - d[0]) > 0)).join("path")
    .attr("class", "layer").attr("data-y", d => d.key)
    .attr("fill", d => color(d.key)).attr("stroke", "rgba(7,8,13,.55)").attr("stroke-width", .6)
    .attr("d", area);
  // rock grain: a faint speckle over the whole deposit
  const defs = svg.append("defs");
  const pat = defs.append("pattern").attr("id", "grain").attr("width", 7).attr("height", 5).attr("patternUnits", "userSpaceOnUse");
  pat.append("circle").attr("cx", 1).attr("cy", 1).attr("r", .55).attr("fill", "rgba(0,0,0,.28)");
  pat.append("circle").attr("cx", 4.5).attr("cy", 3.5).attr("r", .45).attr("fill", "rgba(255,255,255,.10)");
  svg.append("path").datum(rows).attr("fill", "url(#grain)").attr("pointer-events", "none")
    .attr("d", d3.area().x(r => X(r.date)).y0(Yc(0)).y1(r => Yc(d3.sum(YEARS, y => r[y]))).curve(d3.curveMonotoneX));
  // the total, as a thin crest line
  svg.append("path").datum(rows).attr("fill", "none").attr("stroke", "rgba(244,233,210,.55)").attr("stroke-width", 1)
    .attr("d", d3.line().x(r => X(r.date)).y(r => Yc(d3.sum(YEARS, y => r[y]))).curve(d3.curveMonotoneX));

  // core sample: what today's article is made of (100%)
  const core = svg.append("g").attr("class", "core");
  const tot = S.today.chars, top = M.t, bot = H - M.b, hh = bot - top;
  core.append("text").attr("x", coreX - 2).attr("y", top - 20).text("today's article").attr("fill", "var(--ink)").attr("font-weight", 600);
  core.append("text").attr("x", coreX - 2).attr("y", top - 7).text("is made of").attr("class", "pct");
  let acc = 0; const labs = [];
  for (const y of YEARS) {
    const v = S.today.by_year[y] || 0; if (!v) continue;
    const y1 = bot - (acc / tot) * hh, y0 = bot - ((acc + v) / tot) * hh;
    core.append("rect").attr("class", "layer").attr("data-y", y).attr("x", coreX).attr("y", y0 + .5).attr("width", coreW)
      .attr("height", Math.max(.5, y1 - y0 - 1)).attr("fill", color(y)).attr("rx", 1.5)
      .on("mousemove", ev => showTip(ev, `<div class="tt">${y}</div><div class="mm">${fmt(v)} characters of today's text (${pct(v / tot)}) were first written in ${y}</div>`))
      .on("mouseleave", hideTip).on("click", () => isolate(iso === y ? null : y));
    if (v / tot >= 0.045) labs.push({ y, v, mid: (y0 + y1) / 2 });
    acc += v;
  }
  // label collision: keep 13px apart, top-down
  labs.sort((a, b) => a.mid - b.mid);
  for (let i = 1; i < labs.length; i++) labs[i].mid = Math.max(labs[i].mid, labs[i - 1].mid + 13);
  for (const l of labs) {
    const t = core.append("text").attr("x", coreX + coreW + 6).attr("y", l.mid + 4);
    t.append("tspan").text(l.y + " ");
    t.append("tspan").attr("class", "pct").text(pct(l.v / tot));
  }

  // annotations: numbered pins for the events
  const ann = svg.append("g").attr("class", "ann");
  const totalAt = d => { const i = Math.max(0, d3.bisector(s => s.date).right(S.samples, d) - 1); return S.samples[i].chars; };
  pins.forEach(({ e, x, label, right, lvl }) => {
    const k = EVENTS.indexOf(e);
    const crest = Yc(Math.max(totalAt(e.date), totalAt(new Date(+e.date - 1))));
    const py = 14 + lvl * 21;
    const g = ann.append("g").attr("transform", `translate(${x},0)`).style("cursor", "pointer")
      .on("click", () => { stopPlay(); select(sampleAfter(e.date)); })
      .on("mousemove", ev => showTip(ev, eventTip(e))).on("mouseleave", hideTip);
    g.append("line").attr("y1", py + 8).attr("y2", crest).attr("stroke", "rgba(255,255,255,.32)").attr("stroke-dasharray", "2 3");
    g.append("circle").attr("cy", py).attr("r", 8).attr("fill", e.kind === "ero" ? "var(--revert)" : "#e7c27d")
      .attr("stroke", "var(--rock)").attr("stroke-width", 2);
    g.append("text").attr("y", py + 3.5).attr("text-anchor", "middle").attr("font-size", 10).attr("font-weight", 600)
      .attr("fill", "#0b0c12").attr("stroke", "none").text(k + 1);
    if (label) {
      const t = g.append("text").attr("x", right ? 12 : -12).attr("y", py + 4).attr("text-anchor", right ? "start" : "end");
      const [num, ...rest] = label.split(" ");
      t.append("tspan").attr("class", "k").text(num);
      if (rest.length) t.append("tspan").text(" " + rest.join(" "));
    }
  });

  originG = svg.append("g").attr("pointer-events", "none");
  crossG = svg.append("g").attr("pointer-events", "none").style("display", "none");
  crossG.append("line").attr("y1", M.t - 4).attr("y2", H - M.b).attr("stroke", "rgba(255,255,255,.5)");
  selG = svg.append("g").attr("pointer-events", "none");
  selG.append("rect").attr("y", M.t - 4).attr("height", H - M.b - M.t + 4).attr("width", 2).attr("x", -1).attr("fill", "var(--hl)");
  selG.append("rect").attr("class", "flag").attr("y", H - M.b + 3).attr("height", 18).attr("rx", 4).attr("fill", "var(--hl)");
  selG.append("text").attr("class", "flagt").attr("y", H - M.b + 16).attr("text-anchor", "middle").attr("font-size", 11)
    .attr("font-weight", 600).attr("fill", "#0b0c12");

  // interaction: hover = crosshair + layer under the pointer; click/drag = dig
  let dragging = false, dragTimer = null;
  const nearest = mx => {
    const d = X.invert(mx); const i = d3.bisector(s => s.date).center(S.samples, d);
    return Math.max(0, Math.min(S.samples.length - 1, i));
  };
  svg.on("pointermove", ev => {
    const [mx, my] = d3.pointer(ev);
    if (mx < M.l || mx > W - M.r) { crossG.style("display", "none"); if (!ev.target.closest(".core, .ann")) hideTip(); return; }
    const i = nearest(mx), s = S.samples[i];
    crossG.style("display", null).attr("transform", `translate(${X(s.date)},0)`);
    const val = Yc.invert(my); let acc = 0, under = null;
    for (const y of YEARS) { const v = s.y[y] || 0; if (val >= acc && val < acc + v) under = y; acc += v; }
    const top = Object.entries(s.y).sort((a, b) => b[1] - a[1]).slice(0, 5);
    showTip(ev, `<div class="tt">${dayLong(s.date)}</div>
      <div class="mm">version by ${esc(s.user)} · ${fmt(s.chars)} characters · ${fmt(s.n)} sentences</div>
      ${under ? `<div class="q" style="font-style:normal">Layer <b>${under}</b>: ${fmt(s.y[under])} characters (${pct(s.y[under] / s.chars)})</div>` : ""}
      <div class="rows">${top.map(([y, v]) => `<i style="background:${color(y)}"></i><span>${y}</span><span>${pct(v / s.chars)}</span>`).join("")}</div>
      <div class="mm" style="margin-top:5px">${dragging ? "" : "click to read the article as it stood then"}</div>`);
    if (!iso) highlight(under);
    if (dragging && i !== sel) { moveSel(i); clearTimeout(dragTimer); dragTimer = setTimeout(() => select(i), 140); }
  });
  svg.on("pointerleave", () => { crossG.style("display", "none"); hideTip(); if (!iso) highlight(null); });
  svg.on("pointerdown", ev => {
    const [mx] = d3.pointer(ev);
    if (mx < M.l || mx > W - M.r || ev.target.closest(".ann")) return;
    stopPlay(); dragging = true; svg.node().setPointerCapture(ev.pointerId);
    const i = nearest(mx); moveSel(i); select(i);
  });
  svg.on("pointerup pointercancel", () => { dragging = false; });
  if (sel >= 0) moveSel(sel);
  if (iso) highlight(iso);
}

function moveSel(i) {
  const s = S.samples[i], x = X(s.date);
  selG.attr("transform", `translate(${x},0)`);
  const label = day(s.date), w = label.length * 6.4 + 14;
  const off = Math.max(M.l - x + w / 2, Math.min(0, (W - M.r) - x - w / 2));
  selG.select(".flag").attr("x", off - w / 2).attr("width", w);
  selG.select(".flagt").attr("x", off).text(label);
  const fx = x + off;
  d3.selectAll("#flow .xaxis .tick").style("opacity", d => Math.abs(X(d) - fx) < w / 2 + 16 ? 0 : 1);
}

function highlight(y) {
  const on = !!y;
  d3.selectAll("#flow .layers, #flow .core").classed("dim", on);
  d3.selectAll("#flow .layer").classed("on", function () { return this.dataset.y === y; })
    .style("opacity", function () { return !on || this.dataset.y === y ? null : (iso ? .16 : .32); });
}

function isolate(y) {
  iso = y;
  highlight(y);
  $("ramp").querySelectorAll("span").forEach(el => el.classList.toggle("on", el.dataset.y === y));
  const body = $("body");
  body.classList.toggle("iso", !!y);
  body.querySelectorAll(".s").forEach(el => el.classList.toggle("on", el.dataset.y === y));
}

const sampleAfter = d => Math.min(S.samples.length - 1, d3.bisector(s => s.date).left(S.samples, d));

// ------------------------------------------------------------------ events (erosions + deposits)
let EVENTS = [];
function buildEvents() {
  const big = Math.max(800, 0.015 * d3.max(S.samples, s => s.chars));   // a landslide, not a trim
  const ero = S.erosions.filter(e => e.lost >= big).map(e => ({ kind: "ero", ...e, date: parse(e.t), n: 1 }));
  const dep = S.deposits.map(d => { const o = S.origins[d.oid]; return { kind: "dep", ...o, chars: d.chars, surviving: d.surviving, date: parse(o.t), n: 1 }; });
  // one editor's run of edits within two weeks reads as one event
  const merge = list => {
    list.sort((a, b) => a.date - b.date);
    const out = [];
    for (const e of list) {
      const p = out.at(-1);
      if (p && p.user === e.user && e.date - p.end < 14 * 864e5) {
        p.n++; p.end = e.date; p.lost = (p.lost || 0) + (e.lost || 0); p.chars = (p.chars || 0) + (e.chars || 0);
        p.surviving = (p.surviving || 0) + (e.surviving || 0);
        if (!p.comment && e.comment) p.comment = e.comment;
      } else out.push({ ...e, end: e.date });
    }
    return out;
  };
  const top = (list, key) => merge(list).sort((a, b) => b[key] - a[key]).slice(0, 3);
  EVENTS = [...top(ero, "lost"), ...top(dep, "chars")].sort((a, b) => a.date - b.date);
}
const when = e => e.n > 1 && day(e.date) !== day(e.end) ? `${day(e.date)} – ${day(e.end)}` : dayLong(e.date);
function eventTip(e) {
  const c = cleanComment(e.comment);
  return e.kind === "ero"
    ? `<div class="tt">${when(e)} · ${esc(e.user)}</div><div class="mm">removed ${fmt(e.lost)} characters of readable text in ${e.n > 1 ? e.n + " lasting edits" : "one lasting edit"}</div>${c ? `<div class="q">“${esc(c)}”</div>` : ""}<div class="mm">click to dig there</div>`
    : `<div class="tt">${when(e)} · ${esc(e.user)}</div><div class="mm">wrote ${fmt(e.chars)} characters in ${e.n > 1 ? e.n + " edits" : "one edit"}; ${fmt(e.surviving)} (${pct(e.surviving / e.chars)}) still stand today</div>${c ? `<div class="q">“${esc(c)}”</div>` : ""}<div class="mm">click to dig there</div>`;
}
function drawEvents() {
  $("events").innerHTML = EVENTS.map((e, k) => {
    const c = cleanComment(e.comment);
    const what = e.kind === "ero" ? `removed <b>${fmt(e.lost)}</b> chars${e.n > 1 ? ` in ${e.n} edits` : ""}` : `wrote <b>${fmt(e.chars)}</b> chars${e.n > 1 ? ` in ${e.n} edits` : ""}, ${pct(e.surviving / e.chars)} still stand`;
    return `<div class="ev" data-k="${k}"><span class="pin ${e.kind}">${k + 1}</span><div>
      <div class="t">${e.n > 1 ? when(e) : day(e.date)} · <b>${esc(e.user)}</b> ${what}</div>${c ? `<div class="c">“${esc(c)}”</div>` : ""}</div></div>`;
  }).join("") || `<div class="sub">No large lasting deletions or deposits.</div>`;
  $("events").querySelectorAll(".ev").forEach(el => {
    el.onclick = () => { stopPlay(); select(sampleAfter(EVENTS[+el.dataset.k].date)); };
  });
}

// ------------------------------------------------------------------ survival
function drawSurvival() {
  const svg = d3.select("#surv"); svg.selectAll("*").remove();
  const w = $("surv").clientWidth, h = 200, m = { l: 30, r: 14, t: 8, b: 20 };
  const dep = S.deposited_by_year, sur = S.surviving_by_year;
  const x = d3.scaleBand().domain(YEARS).range([m.l, w - m.r]).padding(.18);
  const y = d3.scaleLinear().domain([0, d3.max(YEARS, k => dep[k] || 0) || 1]).nice(3).range([h - m.b, m.t]);
  const ax = svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(3).tickSize(-(w - m.l - m.r)).tickFormat(kfmt));
  ax.select(".domain").remove(); ax.selectAll("line").attr("stroke", "rgba(255,255,255,.05)");
  ax.selectAll("text").attr("fill", "var(--mute)").attr("font-size", 10);
  svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).tickValues(YEARS.filter(k => k % 5 === 0)).tickSize(3))
    .call(g => { g.select(".domain").attr("stroke", "rgba(255,255,255,.15)"); g.selectAll("text").attr("fill", "var(--mute)").attr("font-size", 10); g.selectAll("line").attr("stroke", "rgba(255,255,255,.2)"); });
  const g = svg.append("g");
  for (const k of YEARS) {
    const d = dep[k] || 0, s = sur[k] || 0; if (!d) continue;
    g.append("rect").attr("x", x(k)).attr("width", x.bandwidth()).attr("y", y(d)).attr("height", y(0) - y(d))
      .attr("fill", tint(k, .12)).attr("stroke", color(k)).attr("stroke-width", 1).attr("rx", 2);
    g.append("rect").attr("x", x(k) + 1.5).attr("width", Math.max(0, x.bandwidth() - 3)).attr("y", y(s)).attr("height", Math.max(0, y(0) - y(s)))
      .attr("fill", color(k)).attr("rx", 1.5);
    g.append("rect").attr("x", x(k) - 2).attr("width", x.bandwidth() + 4).attr("y", m.t).attr("height", h - m.b - m.t).attr("fill", "transparent")
      .on("mousemove", ev => showTip(ev, `<div class="tt">${k}</div><div class="mm">${fmt(d)} characters first written in sampled versions<br>${fmt(s)} still in today's article (${pct(s / d)})</div>`))
      .on("mouseleave", hideTip).style("cursor", "pointer").on("click", () => isolate(iso === k ? null : k));
  }
  // one-line reading of the chart, computed from the same numbers
  const tD = d3.sum(YEARS, k => dep[k] || 0), tS = d3.sum(YEARS, k => sur[k] || 0);
  const big = YEARS.filter(k => (dep[k] || 0) >= 0.08 * tD);
  const best = big.length ? d3.greatest(big, k => (sur[k] || 0) / dep[k]) : null;
  const worst = big.length > 1 ? d3.least(big, k => (sur[k] || 0) / dep[k]) : null;
  const sw = k => `<span class="sw" style="background:${color(k)}"></span>`;
  $("survNote").innerHTML = tD ? `Of <b>${kfmt(tD)}</b> characters written across the sampled versions, <b>${pct(tS / tD)}</b> still stand.` +
    (best && worst && best !== worst ? ` Best kept: ${sw(best)}<b>${best}</b> (${pct((sur[best] || 0) / dep[best])}); most eroded: ${sw(worst)}<b>${worst}</b> (${pct((sur[worst] || 0) / dep[worst])}).` : "") : "";
}

// ------------------------------------------------------------------ authors
function drawUsers() {
  const t = S.today, tot = t.chars;
  $("usersSub").textContent = `First authors of today's ${fmt(t.sentences)} sentences: ${fmt(t.editors)} editors. Top:`;
  const max = t.top_users[0]?.[1] || 1;
  $("users").innerHTML = t.top_users.slice(0, 6).map(([u, v]) => `<div class="u"><a class="nm" href="${userLink(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(u)}</a>
    <div class="b"><i style="width:${(v / max * 100).toFixed(1)}%;background:rgba(216,199,164,.75)"></i></div><span class="v">${pct(v / tot)}</span></div>`).join("");
  const k = t.by_kind, ks = [["registered", "var(--ink-2)", "registered"], ["anonymous", "var(--anon)", "anonymous"], ["bot", "var(--bot)", "bots"]];
  $("kinds").innerHTML = ks.filter(([n]) => k[n]).map(([n, c]) => `<i style="flex:${k[n]};background:${c}" title="${n}"></i>`).join("");
  $("kindlab").innerHTML = ks.map(([n, c, l]) => `<span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c}"></i> ${l} <b>${pct((k[n] || 0) / tot)}</b></span>`).join("");
}

function drawMethod() {
  const exact = S.origins.filter(o => o.exact).length;
  $("method").innerHTML = `<p>All ${fmt(S.versions)} stored versions were streamed with <code>FOR SYSTEM_TIME ALL</code>; ${S.samples.length} of them
    (evenly spread over time, plus the versions on either side of the biggest size changes that lasted at least 6 hours) were cleaned to
    readable text and split into sentences.</p>
    <p>A sentence keeps its original age when the same wording (ignoring case, whitespace and punctuation) appeared in an earlier sample, or when it is
    at least 85% similar to a sentence that just disappeared. New wording is traced to the exact edit that wrote it by searching back through
    every unsampled version in between. ${fmt(exact)} of ${fmt(S.origins.length)} origins are exact edits; the other ${fmt(S.origins.length - exact)}
    could only be pinned to a sampling interval (dotted underline). Built in ${(S.build_ms / 1000).toFixed(1)} s and cached in <code>viz_strata_article</code> /
    <code>viz_strata_sentence</code>.</p>`;
}

// ------------------------------------------------------------------ reader (FOR SYSTEM_TIME AS OF)
async function select(i, initial = false) {
  if (!S) return;
  i = Math.max(0, Math.min(S.samples.length - 1, i));
  sel = i; moveSel(i);
  const s = S.samples[i];
  const q = new URLSearchParams({ page: PID, t: s.t });
  history.replaceState(null, "", `?${q}`);
  const seq = ++reqSeq;
  $("body").classList.add("loading");
  const r = await fetch(`${API}/asof/${PID}?t=${encodeURIComponent(s.t)}`);
  const j = await r.json();
  if (seq !== reqSeq) return j;
  $("body").classList.remove("loading");
  if (!r.ok) { $("body").innerHTML = `<div class="err">${esc(j.error)}</div>`; return j; }
  renderReader(j, s, i);
  return j;
}

function renderReader(v, s, i) {
  const at = parse(v.start), isLast = i === S.samples.length - 1;
  $("whenLab").textContent = isLast ? "Today's article · latest version" : "The article as of";
  $("when").textContent = dayLong(at);
  const c = cleanComment(v.comment);
  $("vmeta").innerHTML = `version <a href="https://fi.wikipedia.org/?oldid=${v.rev}" target="_blank" rel="noopener">${v.rev}</a> by
    <b>${esc(v.user)}</b>${c ? ` · <i>“${esc(c.length > 90 ? c.slice(0, 88) + "…" : c)}”</i>` : ""}<br>
    ${fmt(s.chars)} characters of readable text · in force ${stamp(at)}${v.end ? ` → ${stamp(parse(v.end))}` : " → now"} UTC`;
  const byY = {}; let tot = 0, nFresh = 0, cFresh = 0;
  const prevDate = i > 0 ? S.samples[i - 1].date : null;
  const html = v.blocks.map(b => {
    const inner = b.s.map(([txt, oid]) => {
      const o = S.origins[oid];
      if (!o) return `<span class="s untraced" data-o="-1">${esc(txt)}</span>`;
      byY[o.year] = (byY[o.year] || 0) + txt.length; tot += txt.length;
      const fresh = prevDate && o.date > prevDate;
      if (fresh) { nFresh++; cFresh += txt.length; }
      return `<span class="s${o.exact ? "" : " inexact"}${fresh ? " fresh" : ""}${iso === o.year ? " on" : ""}" data-o="${oid}" data-y="${o.year}" style="background:${tint(o.year, .17)};box-shadow:inset 0 -2px 0 ${tint(o.year, .9)}${o.exact ? "" : `;text-decoration:underline dotted ${color(o.year)}`}">${esc(txt)}</span>`;
    }).join(" ");
    return b.k === "h" ? `<h3>${inner}</h3>` : b.k === "li" ? `<p class="li">• ${inner}</p>` : `<p>${inner}</p>`;
  }).join("");
  const body = $("body");
  const keep = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = playing ? keep : 0;
  $("vmeta").insertAdjacentHTML("beforeend", i > 0 ? `<br><span class="freshlab">new</span> ${nFresh ? `${fmt(nFresh)} sentence${nFresh === 1 ? "" : "s"} (${fmt(cFresh)} chars) written since the previous sample, ${day(prevDate)}` : `nothing new since the previous sample, ${day(prevDate)}`}` : "");
  $("agebar").innerHTML = YEARS.filter(y => byY[y]).map(y => `<i style="flex:${byY[y]};background:${color(y)}" title="${y}: ${pct(byY[y] / tot)}"></i>`).join("");
  $("sql").innerHTML = `<div class="sub" style="margin-top:6px">The reader (${v.ms} ms):</div><pre class="sql">${hl(v.sql)}</pre>
    <div class="sub">The lineage build streams every version once:</div><pre class="sql">${hl(`SELECT rev_id, text FROM article\nFOR SYSTEM_TIME ALL\nWHERE page_id = ${PID}\nORDER BY row_start;   -- ${fmt(S.versions)} versions`)}</pre>`;
}
const hl = sql => esc(sql).replace(/\b(SELECT|FROM|FOR SYSTEM_TIME|AS OF|TIMESTAMP|ALL|WHERE|ORDER BY|AND)\b/g, '<span class="kw">$1</span>');

// sentence hover: who wrote it, and where it sits in the strata
const body = $("body");
body.addEventListener("mousemove", ev => {
  const el = ev.target.closest(".s");
  if (!el) { hideTip(); originG?.selectAll("*").remove(); body.querySelector(".hot")?.classList.remove("hot"); return; }
  if (!el.classList.contains("hot")) { body.querySelector(".hot")?.classList.remove("hot"); el.classList.add("hot"); }
  const oid = +el.dataset.o, o = S.origins[oid], cur = S.samples[sel];
  if (!o) { showTip(ev, `<div class="tt">Not traced</div><div class="mm">This exact wording never appears in the sampled versions.</div>`); return; }
  const ageY = (cur.date - o.date) / 3.15576e10;
  const c = cleanComment(o.comment);
  showTip(ev, `<div class="tt"><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color(o.year)}"></span>
      ${o.exact ? `Written ${dayLong(o.date)}` : `Written between ${day(parse(o.lo))} and ${day(o.date)}`}</div>
    <div class="mm">${o.exact ? `by <b style="color:var(--ink)">${esc(o.user)}</b>${o.anon ? " (anonymous)" : o.bot ? " (bot)" : ""} · edit ${o.rev}` : `first seen in the version by ${esc(o.user)}`}</div>
    ${c && o.exact ? `<div class="q">“${esc(c.length > 140 ? c.slice(0, 138) + "…" : c)}”</div>` : ""}
    <div class="mm" style="margin-top:4px">${ageY >= 1 ? `${ageY.toFixed(1)} years old` : ageY * 12 >= 1 ? `${(ageY * 12).toFixed(0)} months old` : `${Math.max(0, Math.round(ageY * 365))} days old`} at this moment${o.exact ? " · click to see the edit" : ""}</div>`);
  // mark the origin on the strata
  if (originG) {
    originG.selectAll("*").remove();
    const x = X(o.date);
    originG.append("line").attr("x1", x).attr("x2", x).attr("y1", M.t - 4).attr("y2", H - M.b).attr("stroke", color(o.year)).attr("stroke-width", 1.5).attr("stroke-dasharray", "3 3");
    originG.append("circle").attr("cx", x).attr("cy", H - M.b).attr("r", 5).attr("fill", color(o.year)).attr("stroke", "var(--rock)").attr("stroke-width", 2);
    originG.append("line").attr("x1", x).attr("x2", X(cur.date)).attr("y1", H - M.b - 8).attr("y2", H - M.b - 8).attr("stroke", color(o.year)).attr("stroke-width", 1).attr("opacity", .7);
  }
});
body.addEventListener("mouseleave", () => { hideTip(); originG?.selectAll("*").remove(); body.querySelector(".hot")?.classList.remove("hot"); });
body.addEventListener("click", ev => {
  const el = ev.target.closest(".s"); if (!el) return;
  const o = S.origins[+el.dataset.o];
  if (o?.exact) window.open(`https://fi.wikipedia.org/?diff=${o.rev}`, "_blank", "noopener");
});

// ------------------------------------------------------------------ controls
$("prev").onclick = () => { stopPlay(); select(sel - 1); };
$("next").onclick = () => { stopPlay(); select(sel + 1); };
$("today").onclick = () => { stopPlay(); select(S.samples.length - 1); };
document.addEventListener("keydown", e => {
  if (!S || e.target.matches("input")) return;
  if (e.key === "ArrowLeft") { stopPlay(); select(sel - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { stopPlay(); select(sel + 1); e.preventDefault(); }
  if (e.key === "Escape") isolate(null);
});
function stopPlay() { playing = false; $("play").textContent = "▶ Replay"; $("play").classList.remove("on"); }
$("play").onclick = async () => {
  if (playing) return stopPlay();
  if (!S) return;
  playing = true; $("play").textContent = "❚❚ Pause"; $("play").classList.add("on");
  let i = sel >= S.samples.length - 1 ? 0 : sel;
  while (playing && i < S.samples.length) {
    const t0 = performance.now();
    await select(i);
    const wait = 420 - (performance.now() - t0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    i++;
  }
  stopPlay();
};
// redraw when the boxes change size (window resize, scrollbar appearing, fonts settling)
let rT = null, lastW = [0, 0];
new ResizeObserver(() => {
  const w = [$("flowWrap").clientWidth, $("surv").parentElement.clientWidth];
  if (w[0] === lastW[0] && w[1] === lastW[1]) return;
  lastW = w; clearTimeout(rT);
  rT = setTimeout(() => { if (S) { drawFlow(); drawSurvival(); if (sel >= 0) moveSel(sel); } }, 120);
}).observe(document.body);

// ------------------------------------------------------------------ go
load(+(state.get("page") || 1256), state.get("t"));
