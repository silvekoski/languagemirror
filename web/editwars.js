import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const CLS = ["war", "dispute", "vandal", "bot", "self"];
const CHIP = { war: "war", dispute: "dispute", vandal: "vandalism", bot: "bot", self: "self" };
const CLS_NAME = { war: "edit war", dispute: "dispute", vandal: "vandalism cleanup", bot: "bot", self: "self-revert" };
const css = getComputedStyle(document.documentElement);
const COL = Object.fromEntries(CLS.map(c => [c, css.getPropertyValue({ war: "--war", dispute: "--dispute", vandal: "--vandal", bot: "--botc", self: "--self" }[c]).trim()]));
const REG = css.getPropertyValue("--reg").trim(), BOTC = COL.bot, ANONC = COL.vandal;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtN = d3.format(",");
const fmtDate = d3.utcFormat("%-d %b %Y"), fmtDT = d3.utcFormat("%-d %b %Y %H:%M"), fmtMon = d3.utcFormat("%b %Y");
const parse = s => new Date(s);
const api = p => fetch("/api/editwars/" + p).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
const wiki = (q) => `https://fi.wikipedia.org/w/index.php?${q}`;
function dur(s) {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} days`;
  if (s < 86400 * 730) return `${Math.round(s / 86400 / 30.4)} months`;
  return `${(s / 86400 / 365.25).toFixed(1)} years`;
}
const ANON_ID = "\u0000anon";

// ---------- state ----------
const url = new URLSearchParams(location.search);
const S = {
  sort: url.get("sort") || "war", q: "", year: +url.get("year") || null,
  cls: new Set((url.get("show") || "war,dispute,vandal,bot").split(",").filter(c => CLS.includes(c))),
  groupAnon: null, allLabels: false, minW: 1, xmode: url.get("x") === "time" ? "time" : "seq",
  range: null, sel: null, focus: null, A: null, pid: null,
};

// ---------- tooltip ----------
const tip = $("#tip");
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = Math.max(4, x) + "px"; tip.style.top = Math.max(4, y) + "px";
}
const hideTip = () => { tip.hidden = true; };

// ---------- overview: reverts per month ----------
const OV = await api("overview");
const total = d3.sum(Object.values(OV.totals));
$("#nRev").textContent = fmtN(total);
$("#nWar").textContent = fmtN(OV.totals.war || 0);
$("#dbstat").textContent = `${fmtN(OV.versions)} versions · ${fmtN(OV.articles)} articles with reverts`;
$("#sqlDerive").textContent = OV.sql;
$("#legend").innerHTML = CLS.map(c => `<span><i style="background:${COL[c]}"></i>${CLS_NAME[c]} ${fmtN(OV.totals[c] || 0)}</span>`).join("");

function drawGlobal() {
  // one column per year: cleanup (vandalism, bots, self-reverts) above the axis, contested reverts (wars, disputes)
  // mirrored below it on their own scale, so the rare fights are not flattened by the vandalism waves
  const svg = d3.select("#global"), node = svg.node();
  const W = node.clientWidth, H = node.clientHeight || 110, m = { l: 66, r: 6, t: 16, b: 6 };
  svg.attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();
  const years = d3.range(2003, 2027);
  const Y = years.map(yr => {
    const v = OV.series.filter(d => d.m.startsWith(yr));
    return Object.assign({ yr, edits: d3.sum(v, d => d.edits), partial: yr === 2026 }, Object.fromEntries(CLS.map(c => [c, d3.sum(v, d => d[c])])));
  });
  const UP = ["vandal", "bot", "self"], DN = ["war", "dispute"];
  const x = d3.scaleBand(years, [m.l, W - m.r]).padding(0.18);
  const mid = m.t + (H - m.t - m.b) * 0.56;
  const yU = d3.scaleLinear([0, d3.max(Y, d => d3.sum(UP, c => d[c]))], [mid - 1, m.t + 4]).nice();
  const yD = d3.scaleLinear([0, d3.max(Y, d => d3.sum(DN, c => d[c]))], [mid + 13, H - m.b]).nice();
  const hl = svg.append("rect").attr("fill", "rgba(255,255,255,.06)").attr("rx", 3).attr("y", m.t).attr("height", H - m.t - m.b).attr("opacity", 0);
  const gU = svg.append("g"), gD = svg.append("g");
  for (const d of Y) {
    let acc = 0;
    for (const c of UP) { if (!d[c]) continue; gU.append("rect").attr("x", x(d.yr)).attr("width", x.bandwidth()).attr("y", yU(acc + d[c])).attr("height", yU(acc) - yU(acc + d[c])).attr("fill", COL[c]).attr("opacity", d.partial ? .55 : 1); acc += d[c]; }
    acc = 0;
    for (const c of DN) { if (!d[c]) continue; gD.append("rect").attr("x", x(d.yr)).attr("width", x.bandwidth()).attr("y", yD(acc)).attr("height", yD(acc + d[c]) - yD(acc)).attr("fill", COL[c]).attr("opacity", d.partial ? .55 : 1); acc += d[c]; }
  }
  // year labels on the axis line
  svg.append("g").selectAll("text").data(years).join("text").attr("x", yr => x(yr) + x.bandwidth() / 2).attr("y", mid + 9)
    .attr("text-anchor", "middle").attr("class", "yrlab").text(yr => (W > 700 || yr % 2 === 0) ? (W > 900 ? yr : "’" + String(yr).slice(2)) : "");
  const ax = (sc, cls) => svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(sc).tickValues([sc.domain()[1]]).tickFormat(fmtN).tickSize(3)).call(g => g.select(".domain").remove());
  ax(yU); ax(yD);
  svg.append("text").attr("x", m.l - 6).attr("y", yU.range()[1] + 16).attr("text-anchor", "end").attr("class", "halflab").text("cleanup ↑");
  svg.append("text").attr("x", m.l - 6).attr("y", yD.range()[1] - 12).attr("text-anchor", "end").attr("class", "halflab war").text("contested ↓");
  // annotate the busiest edit-war year, computed from the data
  const peak = d3.greatest(Y, d => d.war);
  const pxm = x(peak.yr) + x.bandwidth() / 2, py = yD(peak.war + peak.dispute);
  const ann = svg.append("g").attr("pointer-events", "none");
  ann.append("line").attr("x1", pxm + x.bandwidth() / 2 + 2).attr("x2", pxm + 26).attr("y1", py - 4).attr("y2", py - 4).attr("stroke", COL.war);
  ann.append("text").attr("x", pxm + 30).attr("y", py - 1).attr("fill", COL.war).attr("font-size", 11)
    .text(`${peak.yr}: most edit-war reverts (${peak.war})`);
  const peakV = d3.greatest(Y, d => d.vandal);
  ann.append("text").attr("x", x(peakV.yr) + x.bandwidth() / 2).attr("y", yU(d3.sum(UP, c => peakV[c])) - 4).attr("fill", COL.vandal).attr("font-size", 11)
    .text(`${peakV.yr}: ${fmtN(peakV.vandal)} vandalism reverts`);
  const place = yr => hl.attr("x", x(yr) - 2).attr("width", x.bandwidth() + 4).attr("opacity", 1);
  if (S.year) place(S.year);
  svg.append("g").selectAll("rect").data(Y).join("rect")
    .attr("x", d => x(d.yr) - x.step() * x.paddingInner() / 2).attr("width", x.step())
    .attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("mousemove", (ev, d) => {
      place(d.yr);
      showTip(ev, `<b>${d.yr}</b>${d.partial ? " (to 1 Oct)" : ""} · ${fmtN(d.edits)} edits, ${fmtN(d3.sum(CLS, c => d[c]))} reverts<br>` +
        CLS.map(c => `<span style="color:${COL[c]}">■</span> ${CLS_NAME[c]} ${fmtN(d[c])}`).join("<br>") +
        `<div class="tsub">Click: rank articles by ${d.yr}</div>`);
    })
    .on("mouseleave", () => { hideTip(); if (S.year) place(S.year); else hl.attr("opacity", 0); })
    .on("click", (ev, d) => setYear(S.year === d.yr ? null : d.yr));
}

// ---------- leaderboard ----------
function sparkSvg(spark, w = 92, h = 20) {
  // yearly stacked columns 2003..2026: war at the bottom
  const max = d3.max(spark, r => d3.sum(r)) || 1, bw = w / spark.length;
  let out = "";
  spark.forEach((r, i) => {
    let y0 = h;
    r.forEach((v, k) => {
      if (!v) return;
      const hh = Math.max(1, v / max * h);
      out += `<rect x="${(i * bw).toFixed(1)}" y="${(y0 - hh).toFixed(1)}" width="${(bw - .8).toFixed(1)}" height="${hh.toFixed(1)}" fill="${COL[CLS[k]]}"/>`;
      y0 -= hh;
    });
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="0" y="${h - .5}" width="${w}" height=".5" fill="#ffffff22"/>${out}</svg>`;
}
function mixSvg(a, w = 60, h = 6) {
  const t = d3.sum(CLS, c => a["n_" + c]) || 1; let x = 0, out = "";
  for (const c of CLS) { const ww = a["n_" + c] / t * w; if (ww > 0) out += `<rect x="${x}" width="${ww}" height="${h}" fill="${COL[c]}"/>`; x += ww; }
  return `<svg width="${w}" height="${h}" style="border-radius:3px">${out}</svg>`;
}
const SORT_UNIT = { war: "war", pairs: "pairs", dispute: "disp.", vandal: "vand.", reverts: "reverts", rate: "%", recent: "" };
let listRows = [];
async function loadList() {
  const p = new URLSearchParams({ sort: S.sort, limit: 80 });
  if (S.q) p.set("q", S.q);
  if (S.year) p.set("year", S.year);
  const d = await api("articles?" + p);
  listRows = d.articles;
  const yf = $("#yearFilter");
  yf.hidden = !S.year;
  if (S.year) yf.innerHTML = `Reverts in <b>${S.year}</b> only <button title="Clear">×</button>`, yf.querySelector("button").onclick = () => setYear(null);
  const val = a => S.sort === "pairs" ? a.war_pairs : S.sort === "dispute" ? a.n_dispute : S.sort === "vandal" ? a.n_vandal
    : S.sort === "reverts" ? a.n_reverts : S.sort === "rate" ? (100 * a.n_reverts / a.versions).toFixed(1)
    : S.sort === "recent" ? fmtDate(parse(a.last_ts)) : a.n_war;
  $("#list").innerHTML = listRows.length ? listRows.map((a, i) => `<li data-pid="${a.page_id}" class="${a.page_id === S.pid ? "on" : ""}">
      <span class="rk">${i + 1}</span>
      <span class="t" title="${esc(a.title)}"><span class="tt">${esc(a.title)}</span>${a.has_text ? '<span class="txt" title="Full text history loaded: reverts can be diffed">TEXT</span>' : ""}</span>
      <span class="n" style="${S.sort === "war" || S.sort === "pairs" ? `color:${COL.war}` : ""}">${val(a)}<small>${SORT_UNIT[S.sort]}</small></span>
      <span class="viz">${sparkSvg(a.spark)}${mixSvg(a)}<span class="meta">${fmtN(a.n_reverts)} reverts / ${fmtN(a.versions)} v.</span></span>
    </li>`).join("") : `<li class="none" style="cursor:default">No article matches.</li>`;
}
$("#list").addEventListener("click", e => { const li = e.target.closest("li[data-pid]"); if (li) openArticle(+li.dataset.pid); });
$("#list").addEventListener("mousemove", e => {
  const li = e.target.closest("li[data-pid]"); if (!li) return hideTip();
  const a = listRows.find(r => r.page_id === +li.dataset.pid); if (!a) return;
  showTip(e, `<b>${esc(a.title)}</b><br>${CLS.map(c => `<span style="color:${COL[c]}">■</span> ${CLS_NAME[c]} ${a["n_" + c]}`).join(" · ")}
    <br><span class="tsub">${a.war_pairs} warring pair${a.war_pairs === 1 ? "" : "s"} (all years) · reverts ${fmtDate(parse(a.first_ts))} – ${fmtDate(parse(a.last_ts))}<br>sparkline: reverts per year, 2003–2026</span>`);
});
$("#list").addEventListener("mouseleave", hideTip);
$("#sort").value = S.sort;
$("#sort").onchange = e => { S.sort = e.target.value; syncUrl(); loadList(); };
let qT; $("#q").oninput = e => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); loadList(); }, 220); };
function setYear(y) { S.year = y; syncUrl(); drawGlobal(); loadList(); }

$("#rivals").innerHTML = OV.rivalries.map((r, i) => `<li data-i="${i}">
  <div class="rv"><span class="who">${esc(r.a)}</span><span class="arr" title="${esc(r.a)} reverted ${esc(r.b)} ${r.ab}×, ${esc(r.b)} reverted ${esc(r.a)} ${r.ba}×">${r.ab} ⇄ ${r.ba}</span><span class="who">${esc(r.b)}</span></div>
  <div class="rv-sub">${esc(r.title)} · ${r.n} reverts · ${fmtDate(parse(r.first))}${r.first.slice(0, 10) !== r.last.slice(0, 10) ? " – " + fmtDate(parse(r.last)) : ""}</div></li>`).join("");
$("#rivals").addEventListener("click", e => {
  const li = e.target.closest("li[data-i]"); if (!li) return;
  const r = OV.rivalries[+li.dataset.i];
  openArticle(r.page_id, { pair: [r.a, r.b] });
});
function setTab(tab) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.dataset.tab === tab));
  $("#boardArticles").hidden = tab !== "articles";
  $("#rivals").hidden = tab !== "rivals";
}
document.querySelectorAll(".tab").forEach(b => b.onclick = () => setTab(b.dataset.tab));
if (url.get("tab") === "rivals") setTab("rivals");

// ---------- article ----------
function syncUrl() {
  const p = new URLSearchParams();
  if (S.pid) p.set("page", S.pid);
  if (S.sel) p.set("ev", S.sel);
  if (S.sort !== "war") p.set("sort", S.sort);
  if (S.year) p.set("year", S.year);
  if (S.xmode === "time") p.set("x", "time");
  history.replaceState(null, "", "?" + p);
}

async function openArticle(pid, opts = {}) {
  S.pid = pid; S.sel = null; S.focus = null;
  document.querySelectorAll("#list li").forEach(li => li.classList.toggle("on", +li.dataset.pid === pid));
  $("#title").textContent = "…";
  const A = await api("article/" + pid);
  if (S.pid !== pid) return;
  S.A = A;
  for (const e of A.edges) e.t = parse(e.ts);
  for (const e of A.events) e.t = parse(e.ts);
  A.nodeById = new Map(A.nodes.map(n => [n.id, n]));
  const kindOf = id => A.nodeById.get(id)?.kind || "reg";
  A.kindOf = kindOf;
  A.evById = new Map(A.events.map(e => [e.rev_id, e]));
  const nAnon = new Set(A.edges.filter(e => kindOf(e.reverted) === "anon").map(e => e.reverted)).size;
  S.groupAnon = nAnon > 25;
  $("#groupAnon").classList.toggle("on", S.groupAnon);
  const a = A.article;
  const isTop = pid === OV.default_page.page_id;
  $("#title").innerHTML = `<a href="https://fi.wikipedia.org/?curid=${pid}" target="_blank" rel="noopener" style="color:inherit">${esc(a.title)}</a>`;
  const ttrMed = d3.median(A.events.filter(e => e.cls === "vandal"), e => e.ttr_s);
  $("#sub").innerHTML = (isTop ? `<span class="c-war">Most contested article between registered editors</span> · ` : "") + `${fmtN(a.versions)} versions by ${fmtN(a.editors_total)} editors · reverts ${fmtDate(parse(a.first_ts))} – ${fmtDate(parse(a.last_ts))}`
    + (ttrMed != null ? ` · vandalism undone in ${dur(ttrMed)} (median)` : "")
    + ` · <a href="${wiki(`curid=${pid}&action=history`)}" target="_blank" rel="noopener">history ↗</a>`;
  $("#stats").innerHTML = [
    [a.n_reverts, "reverts"], [a.n_war, "edit-war reverts", COL.war], [a.war_pairs, "warring pairs", COL.war],
    [(100 * a.n_reverts / a.versions).toFixed(1) + "%", "of versions"]]
    .map(([v, l, c]) => `<div class="stat"><b style="${c ? `color:${c}` : ""}">${typeof v === "number" ? fmtN(v) : v}</b><span>${l}</span></div>`).join("");
  // crowded articles: open on the contested reverts only (hundreds of IP cleanups would bury the fights)
  if (S.autoHid) { S.cls.add("vandal"); S.autoHid = false; }
  const contested = A.events.filter(e => e.cls === "war" || e.cls === "dispute").length;
  if (!url.get("show") && A.events.length > 150 && contested >= 10 && S.cls.has("vandal")) { S.cls.delete("vandal"); S.autoHid = true; }
  $("#netNote").innerHTML = S.autoHid ? `vandalism cleanup (${fmtN(A.article.n_vandal)}) hidden to show the fights · click its chip to add it back` : "";
  $("#sqlArticle").textContent = A.sql;
  $("#sqlMs").textContent = `${A.ms} ms`;
  renderClsChips();
  // default time window: the span of the edit war if there is one
  S.range = null;
  if (opts.pair) {
    const pe = A.edges.filter(e => samePair(e, opts.pair));
    if (pe.length) S.range = padRange(d3.extent(pe, e => e.t));
    S.focus = { pair: opts.pair };
  } else if (A.article.n_war >= 6) S.range = warRange(10);
  renderPairs();
  drawContext();
  update();
  // default revert to show: a war revert of the article's fiercest pair, inside the time window
  const inRange = e => !S.range || (e.t >= S.range[0] && e.t <= S.range[1]);
  const topPair = opts.pair || (S.pairs?.[0] && [S.pairs[0].a, S.pairs[0].b]);
  const want = opts.ev && A.evById.get(opts.ev) ? opts.ev
    : (topPair && A.events.find(e => e.cls === "war" && samePair(e, topPair) && inRange(e)))?.rev_id
    ?? A.events.find(e => e.cls === "war" && inRange(e))?.rev_id
    ?? A.events.findLast(e => e.cls === "dispute" && inRange(e))?.rev_id ?? A.events.at(-1)?.rev_id;
  if (want) selectEvent(want);
  syncUrl();
}
const samePair = (e, [a, b]) => (e.reverter === a && e.reverted === b) || (e.reverter === b && e.reverted === a);
function padRange([a, b]) {
  const pad = Math.max((b - a) * 0.06, 86400e3 * 3);
  const [lo, hi] = d3.extent(S.A.edges, e => e.t);
  return [new Date(Math.max(+lo, +a - pad)), new Date(Math.min(+hi + 1, +b + pad))];
}
function warRange(minBurst = 1) {
  // the biggest burst of edit-war reverts (bursts split at quiet gaps of 30+ days), so one stray revert
  // years later doesn't flatten the view
  const t = S.A.edges.filter(e => e.cls === "war").map(e => +e.t).sort(d3.ascending);
  if (!t.length) return null;
  const bursts = [[t[0]]];
  for (let i = 1; i < t.length; i++) (t[i] - t[i - 1] > 30 * 86400e3 ? bursts.push([t[i]]) : bursts.at(-1).push(t[i]));
  const best = d3.greatest(bursts, b => b.length);
  if (best.length < minBurst) return null;   // a small skirmish: opening on it would hide most of the article
  return padRange([new Date(best[0]), new Date(best.at(-1))]);
}
function renderClsChips() {
  const A = S.A, cnt = d3.rollup(A.events, v => v.length, e => e.cls);
  $("#clsChips").innerHTML = CLS.map(c => `<button class="chip ${S.cls.has(c) ? "on" : ""}" data-c="${c}"><span class="dot" style="background:${COL[c]}"></span>${CHIP[c]} <b>${cnt.get(c) || 0}</b></button>`).join(" ");
  document.querySelectorAll("#clsChips .chip").forEach(b => b.onclick = () => {
    const c = b.dataset.c; S.cls.has(c) ? S.cls.delete(c) : S.cls.add(c);
    b.classList.toggle("on", S.cls.has(c)); if (c === "vandal") { S.autoHid = false; $("#netNote").innerHTML = ""; } drawContext(); update();
  });
}

function renderPairs() {
  const A = S.A;
  const war = A.edges.filter(e => e.cls === "war");
  let src = war, label = "war";
  if (!war.length) { src = A.edges.filter(e => e.cls === "dispute"); label = "dispute"; }
  const pairs = d3.rollups(src, v => v, e => [e.reverter, e.reverted].sort().join("\u0001"))
    .map(([k, v]) => { const [a, b] = k.split("\u0001"); return { a, b, ab: v.filter(e => e.reverter === a).length, ba: v.filter(e => e.reverter === b).length, n: v.length, ext: d3.extent(v, e => e.t) }; })
    .sort((x, y) => y.n - x.n).slice(0, 4);
  S.pairs = pairs;
  const p0 = pairs[0];
  const sameDay = p0 && fmtDate(p0.ext[0]) === fmtDate(p0.ext[1]);
  const days = p0 ? Math.max(1, Math.round((p0.ext[1] - p0.ext[0]) / 86400e3)) : 0;
  $("#story").innerHTML = !p0 ? "" : label === "war"
    ? `<b>${esc(p0.a)}</b> and <b>${esc(p0.b)}</b> undid each other ${p0.n} times ${sameDay ? `on ${fmtDate(p0.ext[0])}` : days < 60 ? `${days <= 1 ? "within a day" : `in ${days} days`}, ${fmtDate(p0.ext[0])} – ${fmtDate(p0.ext[1])}` : `between ${fmtMon(p0.ext[0])} and ${fmtMon(p0.ext[1])}`}.`
      + (pairs.length > 1 ? ` <span class="mute">${A.article.war_pairs} pairs fought here in all.</span>` : "")
    : `No two registered editors reverted each other here; ${esc(p0.a)} and ${esc(p0.b)} had the biggest one-way dispute (${p0.n}).`;
  $("#pairsBox h3").textContent = label === "war" ? "Rivalries in this article" : "No edit war here · top one-way disputes";
  if (!pairs.length) { $("#pairs").innerHTML = `<p class="none">Only vandalism cleanup and self-reverts: nobody registered fought over this text.</p>`; return; }
  const c = COL[label];
  $("#pairs").innerHTML = pairs.map((p, i) => `<div class="pair" data-i="${i}">
    <div class="names"><b title="${esc(p.a)}">${esc(p.a)}</b><span class="mono tugn" style="color:${c}" title="${esc(p.a)} reverted ${esc(p.b)} ${p.ab}×, ${esc(p.b)} reverted ${esc(p.a)} ${p.ba}×">${p.ab} ⇄ ${p.ba}</span><b title="${esc(p.b)}">${esc(p.b)}</b></div>
    <div class="tug"><i style="width:${p.ab / p.n * 100}%;background:${c}"></i><i style="width:${p.ba / p.n * 100}%;background:${c};opacity:.45"></i></div>
    <div class="when"><span>${fmtDate(p.ext[0])}${+p.ext[1] - +p.ext[0] > 86400e3 ? " – " + fmtDate(p.ext[1]) : ""}</span><span>${p.n} reverts</span></div></div>`).join("");
  document.querySelectorAll("#pairs .pair").forEach(el => {
    const p = pairs[+el.dataset.i];
    el.onclick = () => {
      const on = S.focus?.pair && S.focus.pair[0] === p.a && S.focus.pair[1] === p.b;
      S.focus = on ? null : { pair: [p.a, p.b] };
      if (!on) { S.range = padRange(p.ext); moveBrush(); }
      document.querySelectorAll("#pairs .pair").forEach(x => x.classList.toggle("on", !on && x === el));
      update();
    };
    el.onmouseenter = () => highlight({ pair: [p.a, p.b] });
    el.onmouseleave = () => highlight(S.focus);
    if (S.focus?.pair && [p.a, p.b].join() === [...S.focus.pair].sort().join()) el.classList.add("on");
  });
}

// ---------- the filtered view ----------
function visibleEdges() {
  const A = S.A;
  return A.edges.filter(e => S.cls.has(e.cls) && (!S.range || (e.t >= S.range[0] && e.t <= S.range[1])));
}
const nid = id => (S.groupAnon && S.A.kindOf(id) === "anon") ? ANON_ID : id;

function update() {
  const E = visibleEdges();
  drawNet(E);
  drawLanes(E);
  const span = S.range ? `${fmtDate(S.range[0])} – ${fmtDate(S.range[1])}` : "whole history";
  const nEv = new Set(E.map(e => e.rev_id)).size;
  $("#tlCap").textContent = `${fmtN(nEv)} revert${nEv === 1 ? "" : "s"} shown · ${span}`;
}

// ---------- network ----------
const net = d3.select("#net");
const defs = net.append("defs");
CLS.forEach(c => defs.append("marker").attr("id", "ar-" + c).attr("viewBox", "0 -5 10 10").attr("refX", 9).attr("refY", 0)
  .attr("markerUnits", "userSpaceOnUse").attr("markerWidth", 11).attr("markerHeight", 11).attr("orient", "auto").append("path").attr("d", "M0,-4L10,0L0,4").attr("fill", COL[c]));
const gZoom = net.append("g");
const gLinks = gZoom.append("g"), gNodes = gZoom.append("g");
const zoom = d3.zoom().scaleExtent([0.3, 4]).on("zoom", e => gZoom.attr("transform", e.transform));
net.call(zoom).on("dblclick.zoom", null);
const posCache = new Map();
let posSize = null;                       // the panel size the cached positions were laid out for
let sim = null, NET = { nodes: [], links: [] };
const RANK = { war: 5, dispute: 4, vandal: 3, bot: 2, self: 1 };

function drawNet(E) {
  const A = S.A, W = net.node().clientWidth, H = net.node().clientHeight;
  // the panel changed size (rotation, resize, layout settling): stretch the old layout to fit, then re-settle
  const resized = posSize && (Math.abs(W - posSize[0]) > 2 || Math.abs(H - posSize[1]) > 2);
  if (resized) for (const p of posCache.values()) { p.x *= W / posSize[0]; p.y *= H / posSize[1]; }
  posSize = [W, H];
  const agg = new Map();
  for (const e of E) {
    const s = nid(e.reverter), t = nid(e.reverted);
    if (s === t) continue;
    const k = s + "\u0001" + t;
    let l = agg.get(k);
    if (!l) agg.set(k, l = { id: k, source: s, target: t, n: 0, cls: e.cls, edges: [] });
    l.n++; l.edges.push(e);
    if (RANK[e.cls] > RANK[l.cls]) l.cls = e.cls;
  }
  const links = [...agg.values()].filter(l => l.n >= S.minW);
  const ids = new Set(links.flatMap(l => [l.source, l.target]));
  const anonMembers = new Set();
  let nodes0 = 0;                         // deterministic phyllotaxis start, so the same article looks the same
  const nodes = [...ids].map(id => {
    let n;
    if (id === ANON_ID) {
      const mem = A.nodes.filter(x => x.kind === "anon");
      mem.forEach(m => anonMembers.add(m.id));
      n = { id, kind: "anon", edits: d3.sum(mem, m => m.edits), label: `anonymous ×${new Set(E.flatMap(e => [e.reverter, e.reverted]).filter(u => A.kindOf(u) === "anon")).size}`, group: true };
    } else {
      const src = A.nodeById.get(id) || { id, kind: "reg", edits: 1 };
      n = { ...src, label: src.kind === "anon" ? "IP " + id : id };
    }
    const p = posCache.get(id);
    if (p) Object.assign(n, { x: p.x, y: p.y });
    else { const i = posCache.size + nodes0++, a = i * 2.39996; n.x = W / 2 + 9 * Math.sqrt(i) * Math.cos(a); n.y = H / 2 + 9 * Math.sqrt(i) * Math.sin(a); }
    return n;
  });
  const deg = d3.rollup(links.flatMap(l => [[l.source, l.n, l.cls], [l.target, l.n, l.cls]]), v => ({ n: d3.sum(v, d => d[1]), war: v.some(d => d[2] === "war" || d[2] === "dispute") }), d => d[0]);
  const maxEd = d3.max(nodes, n => n.edits) || 1;
  const r = d3.scaleSqrt([1, Math.max(maxEd, 10)], [4, Math.min(24, Math.max(12, W / 36))]);
  nodes.forEach(n => { n.r = r(Math.max(1, n.edits)); n.deg = deg.get(n.id)?.n || 0; n.fight = deg.get(n.id)?.war; });
  const topDeg = new Set(nodes.filter(n => n.kind !== "anon" || n.group).sort((a, b) => b.deg - a.deg).slice(0, 14).map(n => n.id));
  nodes.forEach(n => { n.showLabel = S.allLabels || n.group || (n.kind !== "anon" && (n.fight || topDeg.has(n.id))); });
  const pairSet = new Set(links.map(l => l.source + "\u0001" + l.target));
  links.forEach(l => { l.mutual = pairSet.has(l.target + "\u0001" + l.source); });
  $("#netEmpty").hidden = nodes.length > 0;
  NET = { nodes, links };

  const wScale = d3.scaleSqrt([1, d3.max(links, l => l.n) || 1], [1.2, 7]);
  const lk = gLinks.selectAll("path").data(links, d => d.id).join("path").attr("class", "link")
    .attr("stroke", d => COL[d.cls]).attr("stroke-width", d => wScale(d.n)).attr("stroke-opacity", d => d.cls === "vandal" ? .45 : .85)
    .attr("marker-end", d => `url(#ar-${d.cls})`)
    .on("mousemove", (ev, d) => {
      const ext = d3.extent(d.edges, e => e.t), ttr = d3.median(d.edges, e => e.ttr_s);
      const s = nodes.find(n => n.id === d.source.id || n.id === d.source), t = nodes.find(n => n.id === d.target.id || n.id === d.target);
      showTip(ev, `<b>${esc(s?.label)}</b> reverted <b>${esc(t?.label)}</b> <b style="color:${COL[d.cls]}">${d.n}×</b>
        <br><span class="tsub">${CLS.filter(c => d.edges.some(e => e.cls === c)).map(c => `${CLS_NAME[c]} ${d.edges.filter(e => e.cls === c).length}`).join(" · ")}
        <br>${fmtDate(ext[0])}${+ext[1] - +ext[0] > 86400e3 ? " – " + fmtDate(ext[1]) : ""} · median time to revert ${dur(ttr)}</span>`);
      highlight({ link: d });
    })
    .on("mouseleave", () => { hideTip(); highlight(S.focus); })
    .on("click", (ev, d) => selectEvent(d.edges.at(-1).rev_id));

  const nd = gNodes.selectAll("g.node").data(nodes, d => d.id).join(enter => {
    const g = enter.append("g").attr("class", "node");
    g.append("path");
    g.append("text").attr("dy", "0.32em");
    return g;
  });
  nd.classed("big", d => d.fight && d.kind === "reg");
  nd.select("path").attr("d", d => d.kind === "bot"
      ? `M${-d.r},${-d.r}h${2 * d.r}v${2 * d.r}h${-2 * d.r}Z`
      : d3.symbol(d3.symbolCircle, Math.PI * d.r * d.r)())
    .attr("fill", d => d.kind === "anon" ? (d.group ? "rgba(180,140,255,.18)" : "rgba(180,140,255,.08)") : d.kind === "bot" ? BOTC : REG)
    .attr("fill-opacity", d => d.kind === "reg" ? (d.fight ? 0.95 : 0.55) : 1)
    .attr("stroke", d => d.kind === "anon" ? ANONC : d.fight ? COL.war : "rgba(0,0,0,.6)")
    .attr("stroke-width", d => d.kind === "anon" ? 1.3 : d.fight ? 2 : 1)
    .attr("stroke-dasharray", d => d.kind === "anon" ? "3 2" : null);
  nd.select("text").attr("x", d => d.r + 4).text(d => d.showLabel ? d.label : "");
  nd.on("mousemove", (ev, d) => {
      const out = links.filter(l => (l.source.id ?? l.source) === d.id), inn = links.filter(l => (l.target.id ?? l.target) === d.id);
      showTip(ev, `<b>${esc(d.label)}</b> <span class="tsub">${d.group ? "anonymous editors in these reverts" : d.kind === "reg" ? "registered" : d.kind}</span><br>
        ${fmtN(d.edits)} edit${d.edits === 1 ? "" : "s"} to this article${d.first && !d.group ? `, ${fmtDate(parse(d.first))} – ${fmtDate(parse(d.last))}` : ""}<br>
        reverted others <b>${d3.sum(out, l => l.n)}×</b> · was reverted <b>${d3.sum(inn, l => l.n)}×</b> <span class="tsub">(in view)</span>`);
      highlight({ node: d.id });
    })
    .on("mouseleave", () => { hideTip(); highlight(S.focus); })
    .on("click", (ev, d) => { S.focus = S.focus?.node === d.id ? null : { node: d.id }; highlight(S.focus); drawLanes(visibleEdges()); })
    .call(d3.drag()
      .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  if (sim) sim.stop();
  const k = Math.sqrt(nodes.length);
  const crowd = Math.min(1, Math.max(0, (nodes.length - 30) / 60));   // big hairballs: pull harder to the middle
  // typical spacing so that the graph fills the panel: few nodes -> long links, many nodes -> short
  const spread = Math.max(26, Math.min(170, Math.sqrt(W * H / Math.max(4, nodes.length)) * 0.75));
  sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(l => spread * 0.45 + l.source.r + l.target.r).strength(l => l.cls === "vandal" ? .2 : .5))
    .force("charge", d3.forceManyBody().strength(d => -spread * 2.4 - d.r * (nodes.length > 40 ? 5 : 14)))
    .force("collide", d3.forceCollide(d => d.r + (d.showLabel ? Math.min(46, 6 + d.label.length * 2.6) : 3)).iterations(2))
    .force("x", d3.forceX(W / 2).strength(.04 + k / 500 + crowd * .1)).force("y", d3.forceY(H / 2).strength(.07 + k / 400 + crowd * .16))
    // keep nodes inside the panel as a force, so it also applies during the synchronous sim.tick() pre-settle
    // (tick events don't fire there; clamping only afterwards piled the nodes against the walls)
    .force("bounds", () => { for (const n of nodes) { n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x)); n.y = Math.max(n.r + 4, Math.min(H - n.r - 26, n.y)); } })
    .alpha(posCache.size ? .5 : 1).alphaDecay(.035)
    .on("tick", () => {
      for (const n of nodes) posCache.set(n.id, { x: n.x, y: n.y });
      lk.attr("d", linkPath);
      nd.attr("transform", d => `translate(${d.x},${d.y})`);
    });
  // settle most of the layout before the first paint so the first look is already readable
  if (resized || !posCache.size || nodes.some(n => !posCache.has(n.id))) sim.tick(Math.min(220, 60 + nodes.length));
  for (const n of nodes) posCache.set(n.id, { x: n.x, y: n.y });
  lk.attr("d", linkPath); nd.attr("transform", d => `translate(${d.x},${d.y})`);
  highlight(S.focus);
}
function linkPath(l) {
  const s = l.source, t = l.target, dx = t.x - s.x, dy = t.y - s.y, d = Math.hypot(dx, dy) || 1;
  const bend = l.mutual ? 0.22 : 0.08;                       // two-way fights bow apart so both arrows show
  const mx = (s.x + t.x) / 2 - dy * bend, my = (s.y + t.y) / 2 + dx * bend;
  // stop the arrow at the target's rim
  const ex = t.x - mx, ey = t.y - my, ed = Math.hypot(ex, ey) || 1, rr = t.r + 2.5;
  return `M${s.x},${s.y}Q${mx},${my} ${t.x - ex / ed * rr},${t.y - ey / ed * rr}`;
}
function highlight(f) {
  const nodes = gNodes.selectAll("g.node"), links = gLinks.selectAll("path");
  if (!f) { nodes.classed("dim", false); links.classed("dim", false); laneHighlight(null); return; }
  let keepN, keepL;
  if (f.node) {
    keepL = l => l.source.id === f.node || l.target.id === f.node;
    const nb = new Set([f.node]); NET.links.filter(keepL).forEach(l => { nb.add(l.source.id); nb.add(l.target.id); });
    keepN = n => nb.has(n.id);
  } else if (f.pair) {
    const P = f.pair.map(nid);
    keepL = l => P.includes(l.source.id) && P.includes(l.target.id);
    keepN = n => P.includes(n.id);
  } else if (f.link) {
    keepL = l => l === f.link; keepN = n => n.id === f.link.source.id || n.id === f.link.target.id;
  }
  nodes.classed("dim", n => !keepN(n)); links.classed("dim", l => !keepL(l));
  laneHighlight(f);
}

// ---------- timeline: lanes (focus) + context strip with brush ----------
const lanesSvg = d3.select("#lanes"), ctxSvg = d3.select("#context");
let LANE = null;
function laneKey(id) {
  if (S.A.kindOf(id) === "anon") return ANON_ID;
  return LANE.idx.has(id) ? id : "\u0000other";
}
function drawLanes(E) {
  const A = S.A, W = lanesSvg.node().clientWidth;
  const m = { l: 128, r: 14, t: 6, b: 22 };
  // lanes: the most involved registered editors in view, then everybody anonymous, then the rest
  const inv = new Map();
  for (const e of E) for (const u of [e.reverter, e.reverted]) if (A.kindOf(u) !== "anon") inv.set(u, (inv.get(u) || 0) + (e.cls === "war" ? 3 : e.cls === "dispute" ? 2 : 1));
  const NL = innerWidth < 760 ? 5 : 8;
  const top = [...inv].sort((a, b) => b[1] - a[1]).slice(0, NL).map(d => d[0]);
  const lanes = [...top];
  const hasAnon = E.some(e => A.kindOf(e.reverted) === "anon" || A.kindOf(e.reverter) === "anon");
  const hasOther = E.some(e => [e.reverter, e.reverted].some(u => A.kindOf(u) !== "anon" && !top.includes(u)));
  if (hasAnon) lanes.push(ANON_ID);
  if (hasOther) lanes.push("\u0000other");
  LANE = { idx: new Set(top) };
  const LH = 19, H = m.t + m.b + Math.max(2, lanes.length) * LH;
  lanesSvg.attr("height", H).attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();
  const y = d3.scalePoint(lanes, [m.t + LH / 2, H - m.b - LH / 2]);
  const sorted = [...E].sort((a, b) => a.t - b.t);
  const evOrder = [...new Set(sorted.map(e => e.rev_id))];
  const seqIdx = new Map(evOrder.map((r, i) => [r, i]));
  let x, xa;
  if (S.xmode === "seq") {
    x = d3.scaleLinear([-0.5, Math.max(evOrder.length - 0.5, 0.5)], [m.l, W - m.r]);
    const want = Math.max(2, Math.floor((W - m.l) / 90)), step = Math.max(1, Math.ceil(evOrder.length / want));
    const tv = []; let lastLab = "";
    for (let i = 0; i < evOrder.length; i += step) { const lab = fmtMon(A.evById.get(evOrder[i]).t); if (lab !== lastLab) tv.push(i); lastLab = lab; }
    xa = d3.axisBottom(x).tickValues(tv).tickFormat(i => fmtMon(A.evById.get(evOrder[i]).t));
  } else {
    const dom = S.range || d3.extent(A.edges, e => e.t);
    x = d3.scaleUtc(dom, [m.l, W - m.r]);
    xa = d3.axisBottom(x).ticks(W / 110);
  }
  const X = e => S.xmode === "seq" ? x(seqIdx.get(e.rev_id)) : x(e.t);
  lanesSvg.append("g").selectAll("line").data(lanes).join("line").attr("x1", m.l).attr("x2", W - m.r)
    .attr("y1", d => y(d)).attr("y2", d => y(d)).attr("stroke", "rgba(255,255,255,.05)");
  lanesSvg.append("g").selectAll("text").data(lanes).join("text")
    .attr("class", d => "lane-label" + (d === ANON_ID ? " anon" : "")).attr("x", m.l - 8).attr("y", d => y(d)).attr("dy", "0.32em").attr("text-anchor", "end")
    .text(d => d === ANON_ID ? "anonymous (IPs)" : d === "\u0000other" ? "other editors" : (d.length > 18 ? d.slice(0, 17) + "…" : d))
    .append("title").text(d => d.startsWith("\u0000") ? "" : d);
  lanesSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b + 4})`).call(xa).call(g => g.select(".domain").remove());
  const g = lanesSvg.append("g");
  const evs = g.selectAll("g.ev").data(sorted).join("g").attr("class", "ev").attr("data-rev", d => d.rev_id);
  evs.append("line").attr("x1", X).attr("x2", X).attr("y1", e => y(laneKey(e.reverter))).attr("y2", e => y(laneKey(e.reverted)))
    .attr("stroke", e => COL[e.cls]).attr("stroke-opacity", .6).attr("stroke-width", 1.4);
  evs.append("path").attr("transform", e => `translate(${X(e)},${y(laneKey(e.reverted))})`)
    .attr("d", e => {                 // a small chevron at the reverted end, pointing at them
      const up = y(laneKey(e.reverted)) < y(laneKey(e.reverter));
      return up ? "M-3.5,4L0,0L3.5,4" : y(laneKey(e.reverted)) === y(laneKey(e.reverter)) ? "M-3,3L3,-3M-3,-3L3,3" : "M-3.5,-4L0,0L3.5,-4";
    })
    .attr("stroke", e => COL[e.cls]).attr("fill", "none").attr("stroke-width", 1.4);
  evs.append("circle").attr("cx", X).attr("cy", e => y(laneKey(e.reverter))).attr("r", e => e.cls === "war" ? 4.5 : 3.4)
    .attr("fill", e => COL[e.cls]).attr("stroke", "var(--bg)").attr("stroke-width", 1);
  evs.append("rect").attr("x", e => X(e) - 4).attr("width", 8)
    .attr("y", e => Math.min(y(laneKey(e.reverter)), y(laneKey(e.reverted))) - 6)
    .attr("height", e => Math.abs(y(laneKey(e.reverter)) - y(laneKey(e.reverted))) + 12).attr("fill", "transparent");
  evs.on("mousemove", (ev, e) => {
      const r = A.evById.get(e.rev_id);
      showTip(ev, `<span class="badge" style="color:${COL[e.cls]}">${CLS_NAME[e.cls]}</span> <span class="tsub">${fmtDT(e.t)} UTC</span><br>
        <b>${esc(e.reverter)}</b> undid ${e.n} version${e.n === 1 ? "" : "s"} by <b>${esc(e.reverted)}</b> after ${dur(e.ttr_s)}
        ${r?.comment ? `<div class="tsub" style="margin-top:4px">“${esc(r.comment)}”</div>` : ""}<div class="tsub">Click to see what was undone</div>`);
    })
    .on("mouseleave", hideTip)
    .on("click", (ev, e) => selectEvent(e.rev_id));
  evs.classed("sel", e => e.rev_id === S.sel);
  laneHighlight(S.focus);
}
function laneHighlight(f) {
  const evs = lanesSvg.selectAll("g.ev");
  if (!f) return evs.attr("opacity", 1);
  let keep;
  if (f.node) keep = e => nid(e.reverter) === f.node || nid(e.reverted) === f.node;
  else if (f.pair) keep = e => samePair(e, f.pair);
  else if (f.link) keep = e => f.link.edges.includes(e);
  evs.attr("opacity", e => keep(e) ? 1 : .12);
}

let brush, ctxX;
function drawContext() {
  const A = S.A, W = ctxSvg.node().clientWidth, H = 46, m = { l: 128, r: 14, t: 4, b: 16 };
  ctxSvg.attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();
  const [lo, hi] = d3.extent(A.edges, e => e.t);
  ctxX = d3.scaleUtc([new Date(+lo - 86400e3 * 2), new Date(+hi + 86400e3 * 2)], [m.l, W - m.r]);
  // reverts per bin as a stacked mini histogram
  const bins = d3.bin().value(e => e.t).domain(ctxX.domain()).thresholds(ctxX.ticks(Math.min(160, Math.floor((W - m.l) / 5))));
  const E = A.edges.filter(e => S.cls.has(e.cls));
  const bs = bins(E);
  const ymax = d3.max(bs, b => b.length) || 1;
  const yy = d3.scaleSqrt([0, ymax], [H - m.b, m.t]);
  const g = ctxSvg.append("g");
  for (const b of bs) {
    let y0 = H - m.b; const total = b.length;
    if (!total) continue;
    const top = yy(total), h = (H - m.b) - top;
    for (const c of CLS) {
      const n = b.filter(e => e.cls === c).length; if (!n) continue;
      const hh = h * n / total;
      g.append("rect").attr("x", ctxX(b.x0)).attr("width", Math.max(1, ctxX(b.x1) - ctxX(b.x0) - .5)).attr("y", y0 - hh).attr("height", hh).attr("fill", COL[c]).attr("opacity", .85);
      y0 -= hh;
    }
  }
  ctxSvg.append("text").attr("x", m.l - 8).attr("y", (H - m.b) / 2 + 4).attr("text-anchor", "end").attr("class", "lane-label").attr("fill", "var(--mute)").text("drag to filter ⟷");
  ctxSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(ctxX).ticks(W / 90).tickSize(3)).call(g => g.select(".domain").attr("stroke", "rgba(255,255,255,.12)"));
  brush = d3.brushX().extent([[m.l, m.t - 2], [W - m.r, H - m.b]])
    .on("brush end", ev => {
      if (!ev.sourceEvent) return;
      S.range = ev.selection ? ev.selection.map(ctxX.invert) : null;
      update();
    });
  ctxSvg.append("g").attr("class", "brush").call(brush);
  moveBrush();
}
function moveBrush() {
  const b = ctxSvg.select("g.brush");
  if (!b.empty()) b.call(brush.move, S.range ? S.range.map(ctxX) : null);
}
$("#zoomWar").onclick = () => { S.range = warRange(); moveBrush(); update(); };
$("#zoomAll").onclick = () => { S.range = null; moveBrush(); update(); };
document.querySelectorAll("[data-x]").forEach(b => b.onclick = () => {
  S.xmode = b.dataset.x; document.querySelectorAll("[data-x]").forEach(x => x.classList.toggle("on", x === b)); syncUrl(); drawLanes(visibleEdges());
});
document.querySelectorAll("[data-x]").forEach(x => x.classList.toggle("on", x.dataset.x === S.xmode));
$("#groupAnon").onclick = () => { S.groupAnon = !S.groupAnon; $("#groupAnon").classList.toggle("on", S.groupAnon); update(); };
$("#labelsBtn").onclick = () => { S.allLabels = !S.allLabels; $("#labelsBtn").classList.toggle("on", S.allLabels); update(); };
$("#minW").oninput = e => { S.minW = +e.target.value; $("#minWv").textContent = S.minW; update(); };

// ---------- one revert: who, when, and what text it threw away ----------
async function selectEvent(rev) {
  S.sel = rev; syncUrl();
  lanesSvg.selectAll("g.ev").classed("sel", e => e.rev_id === rev);
  const A = S.A, e = A.evById.get(rev);
  if (!e) return;
  const c = COL[e.cls];
  $("#evHead").textContent = "Selected revert";
  $("#ev").innerHTML = `<div class="evcard">
    <div style="margin-bottom:6px"><span class="badge" style="color:${c}">${CLS_NAME[e.cls]}</span> <span class="mute small">${fmtDT(e.t)} UTC</span></div>
    <div class="who"><b>${esc(e.reverter)}</b> <span class="mute">${e.reverter_kind === "reg" ? "" : "(" + e.reverter_kind + ")"}</span> undid
      ${e.n_versions} version${e.n_versions === 1 ? "" : "s"} by <b>${esc(e.reverted)}</b>${e.reverted_kind === "anon" ? ' <span class="mute">(anonymous)</span>' : ""}${e.n_editors > 1 ? ` and ${e.n_editors - 1} other${e.n_editors > 2 ? "s" : ""}` : ""}.</div>
    <div class="facts"><div><b>${dur(e.ttr_s)}</b><span>until undone</span></div><div><b>${e.delta > 0 ? "+" : ""}${fmtN(e.delta ?? 0)}</b><span>bytes by the revert</span></div>
      <div><b>${fmtN(A.events.filter(x => x.reverter === e.reverter && x.reverted === e.reverted).length)}</b><span>times this pair</span></div></div>
    ${e.undone_comment ? `<div class="cmt"><span class="lbl">${esc(e.reverted)} wrote</span>${esc(e.undone_comment)}</div>` : ""}
    ${e.comment ? `<div class="cmt"><span class="lbl">${esc(e.reverter)} replied</span>${esc(e.comment)}</div>` : ""}
    <div class="diff" id="diffBox"><p class="mute small">Reading the article as of ${fmtDT(new Date(+e.t - 1))} …</p></div>
    <div class="links"><a href="${wiki(`diff=${e.rev_id}&oldid=${e.undone_rev_id}`)}" target="_blank" rel="noopener">this revert on Wikipedia ↗</a>
      <a href="${wiki(`diff=${e.undone_rev_id}&oldid=${e.restored_rev_id}`)}" target="_blank" rel="noopener">the undone edit ↗</a></div></div>`;
  let D;
  try { D = await api("diff/" + rev); } catch { $("#diffBox").innerHTML = ""; return; }
  if (S.sel !== rev) return;
  $("#sqlDiff").textContent = D.sql + (D.text ? `\n-- ${D.ms} ms for both` : "\n-- (no text history loaded for this article yet: 0 rows)");
  const vl = D.versions.slice(0, -1);
  const vhtml = vl.length ? `<h4>The undone version${vl.length === 1 ? "" : "s"}</h4><div class="vlist">${vl.slice(-6).map(v => `<div><span class="ts">${fmtDT(parse(v.ts))}</span><span class="u" style="color:${v.kind === "anon" ? ANONC : "inherit"}">${esc(v.user)}</span><span class="c" title="${esc(v.comment)}">${v.delta > 0 ? "+" : ""}${v.delta} B ${esc(v.comment || "")}</span></div>`).join("")}${vl.length > 6 ? `<div class="mute">… ${vl.length - 6} earlier</div>` : ""}</div>` : "";
  if (!D.text) {
    $("#diffBox").innerHTML = vhtml + `<p class="mute small">This article's full-text history is not in MariaDB yet (only histories under 0.5 MB plus 50 famous articles are loaded), so the words can't be diffed here. Follow the Wikipedia link.</p>`;
    return;
  }
  const clip = t => t.length > 420 ? esc(t.slice(0, 380)) + `<span class="mute"> … +${fmtN(t.length - 380)} characters</span>` : esc(t);
  const hunks = D.hunks.slice(0, 6).map(h => `<div class="hunk ${D.raw ? "raw" : ""}">${h.ctx ? `<div class="ctx">… ${esc(h.ctx.slice(-140))}</div>` : ""}${h.parts.map(p =>
      p.words ? `<p>${p.words.map(([op, t]) => op === "=" ? esc(t.length > 260 ? t.slice(0, 120) + " … " + t.slice(-120) : t) : op === "-" ? `<del>${esc(t)}</del>` : `<ins>${esc(t)}</ins>`).join("")}</p>`
      : p.removed != null ? `<p><del>${clip(p.removed)}</del></p>` : `<p><ins>${clip(p.added)}</ins></p>`).join("")}</div>`).join("")
    + (D.hunks.length > 6 ? `<p class="mute small">… ${D.hunks.length >= 12 ? "12 or more" : D.hunks.length} changed passages in all.</p>` : "");
  $("#diffBox").innerHTML = `<h4>What the revert changed <span style="text-transform:none;letter-spacing:0">(<del style="color:#ff8b98">thrown out</del> · <ins style="color:#9fe8cf;text-decoration:none">restored</ins>${D.raw ? ", wiki markup" : ""})</span></h4>`
    + (hunks || `<p class="mute small">No visible text difference (the change was in markup that the cleaner drops).</p>`) + vhtml
    + `<p class="mute small" style="margin-top:6px">Read with <span class="mono">FOR SYSTEM_TIME AS OF</span> one microsecond before and at the revert (${D.ms} ms).</p>`;
}

// ---------- boot ----------
drawGlobal();
await loadList();
openArticle(+url.get("page") || OV.default_page.page_id, { ev: +url.get("ev") || null });
let rT; addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => { drawGlobal(); if (S.A) { drawContext(); update(); } }, 200); });
// the panel can change size without a window resize (fonts, scrollbars, the side panel filling): re-lay the network
let lastNet = [net.node().clientWidth, net.node().clientHeight], nT;
new ResizeObserver(() => {
  const now = [net.node().clientWidth, net.node().clientHeight];
  if (Math.abs(now[0] - lastNet[0]) < 2 && Math.abs(now[1] - lastNet[1]) < 2) return;
  lastNet = now; clearTimeout(nT); nT = setTimeout(() => { if (S.A) drawNet(visibleEdges()); }, 120);
}).observe(net.node());
