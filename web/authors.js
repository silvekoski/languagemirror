import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const API = "/api/authors";
const $ = (s, el = document) => el.querySelector(s);
const fmt = d3.format(",");
const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (key) => `${MON[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;
const dateName = (iso) => iso ? `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}` : "";
const wikiUser = (u) => `https://fi.wikipedia.org/wiki/K%C3%A4ytt%C3%A4j%C3%A4:${encodeURIComponent(u.replace(/ /g, "_"))}`;
const wikiContrib = (u) => `https://fi.wikipedia.org/wiki/Toiminnot:Muokkaukset/${encodeURIComponent(u.replace(/ /g, "_"))}`;
const curid = (id) => `https://fi.wikipedia.org/?curid=${id}`;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const tip = $("#tip");
function showTip(html, ev) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = Math.max(4, x) + "px";
  tip.style.top = Math.max(4, y) + "px";
}
const hideTip = () => { tip.hidden = true; };

// ---------- load ----------
const [O, L] = await Promise.all([fetch(`${API}/overview`).then((r) => r.json()), fetch(`${API}/lanes`).then((r) => r.json())]);
const M = O.months, NM = M.length, S = O.series, C = O.callouts;
const dates = M.map((k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, 15)));
const COH = O.cohorts;
const yearEnd = +M[NM - 1].slice(0, 4);
const partialNote = M[NM - 1].endsWith("-12") ? "" : ` (Jan–${MON[+M[NM - 1].slice(5, 7) - 1]})`;

// cohort colours: old generations warm (rust, amber, sand), newer ones cool (sage, sky, violet)
const cohortInterp = d3.piecewise(d3.interpolateHcl, ["#b8532e", "#ffb46b", "#efe1a4", "#8fd3b0", "#7fb2ff", "#b49cff"]);
const cohortColor = (c) => cohortInterp((c - COH[0]) / Math.max(1, COH[COH.length - 1] - COH[0]));
const BOT = css("--bot") || "#5fd4b0";
const BOTPAL = ["#5fd4b0", "#8ab4ff", "#ffd36e", "#ff7d8a", "#ffb46b", "#c9b3ff"];
const botColor = Object.fromEntries(O.bots.map((b, i) => [b.user, BOTPAL[i % BOTPAL.length]]));
const kinds = O.kinds;
const nReg = kinds.reg?.n ?? 0, nBot = kinds.bot?.n ?? 0;

// ---------- hero ----------
$("#dbstat").textContent = `${fmt(O.all_edits)} versions · ${fmt(nReg)} people · ${fmt(nBot)} bots`;
$("#q").placeholder = `Find any of ${fmt(nReg + nBot)} named editors…`;
const lw = C.last_word;
$("#lede").innerHTML = `Every one of the <b>${fmt(O.all_edits)}</b> versions of Finland's history on Finnish Wikipedia
  carries a name: <b>${fmt(nReg)}</b> registered people, <b>${fmt(nBot)}</b> bots and logged-out visitors. The knowledge
  changed because the <i>writers</i> changed: the class of ${C.cohort.biggest} built it, a small core keeps it, anonymous
  editing faded, and today a bot saved the latest version of <b>${pct(lw.bot / lw.pages)}</b> of all articles.`;

const facts = [
  { c: BOT, big: pct(lw.bot / lw.pages), lbl: `of the ${fmt(lw.pages)} articles were last saved by a bot`,
    src: lw.top.slice(0, 2).map(([u, n]) => `${esc(u)} ${fmt(n)}`).join(" · ") },
  { c: css("--anon"), big: `${pct(C.anon.peak_share)}<small>→</small>${pct(C.anon.now_share ?? C.anon.last_share)}`,
    lbl: `of edits were anonymous in ${C.anon.peak_year}; in ${C.anon.now_year}${partialNote}`,
    src: C.anon.temp_first ? `since ${monthName(C.anon.temp_first)} ${pct(C.anon.temp_share_since)} via temporary accounts` : "" },
  { c: cohortColor(C.cohort.biggest), big: fmt(C.cohort.size),
    lbl: `people first edited in ${C.cohort.biggest}, the biggest class`,
    src: `${fmt(C.cohort.still)} of them still edited in ${C.cohort.still_year}` },
  { c: css("--accent"), big: pct(C.concentration.top1pct),
    lbl: `of registered edits by the top 1% (${fmt(C.concentration.top1pct_n)} people)`,
    src: `top 120 accounts: ${pct(C.concentration.top120)} of all edits` },
];
$("#facts").innerHTML = facts.map((f) => `<div class="fact" style="--c:${f.c}"><div class="big">${f.big}</div>
  <div class="lbl">${f.lbl}</div><div class="src">${f.src}</div></div>`).join("");
$("#sqlOverview").textContent = O.sql;

// ---------- geology ----------
const P = new URLSearchParams(location.search);
const geo = { metric: ["editors", "active5", "edits"].includes(P.get("metric")) ? P.get("metric") : "editors",
  scale: P.get("scale") === "share" ? "share" : "abs", hi: null };
for (const [id, v] of [["#geoMetric", geo.metric], ["#geoScale", geo.scale]])
  document.querySelectorAll(`${id} button`).forEach((b) => b.classList.toggle("on", b.dataset.v === v));
const geoSvg = d3.select("#geoSvg");
const metricLabel = { editors: "editors", active5: "active editors (≥5 edits)", edits: "edits" };

function geoData() {
  const rows = d3.range(NM).map((i) => {
    const r = { i };
    let tot = 0;
    for (const c of COH) { r[c] = O.layers[c][geo.metric][i]; tot += r[c]; }
    r.total = tot;
    if (geo.scale === "share") for (const c of COH) r[c] = tot >= 10 ? r[c] / tot : 0;   // too few to split
    return r;
  });
  return { rows, stack: d3.stack().keys(COH).order(d3.stackOrderNone).offset(d3.stackOffsetNone)(rows) };
}

function drawGeo() {
  const el = geoSvg.node(), W = el.clientWidth, H = el.clientHeight;
  const m = { l: 40, r: W < 600 ? 12 : 150, t: 16, b: 22 };
  geoSvg.selectAll("*").remove();
  const { rows, stack } = geoData();
  const x = d3.scaleUtc().domain([dates[0], dates[NM - 1]]).range([m.l, W - m.r]);
  const ymax = geo.scale === "share" ? 1 : d3.max(rows, (r) => r.total);
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([H - m.b, m.t]);
  const fy = geo.scale === "share" ? d3.format(".0%") : d3.format("~s");
  geoSvg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat(""));
  const area = d3.area().x((d) => x(dates[d.data.i])).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(d3.curveMonotoneX);
  geoSvg.append("g").selectAll("path").data(stack).join("path").attr("class", "layer")
    .attr("d", area).attr("fill", (s) => cohortColor(+s.key)).attr("stroke", "#07080d").attr("stroke-width", 0.6)
    .attr("opacity", (s) => (geo.hi == null || geo.hi === +s.key ? 1 : 0.22));
  geoSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(W < 600 ? 5 : 12).tickSizeOuter(0));
  geoSvg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(fy).tickSizeOuter(0)).call((g) => g.select(".domain").remove());

  // annotations, all from the data
  const an = geoSvg.append("g").attr("class", "anno");
  if (geo.scale === "abs") {
    const pi = d3.maxIndex(rows, (r) => r.total);
    const px = x(dates[pi]), py = y(rows[pi].total);
    an.append("circle").attr("cx", px).attr("cy", py).attr("r", 2.5);
    const right = px < (W - m.r) * 0.6;
    an.append("line").attr("x1", px).attr("y1", py).attr("x2", px + (right ? 16 : -16)).attr("y2", py - 2);
    an.append("text").attr("x", px + (right ? 20 : -20)).attr("y", py + 2).attr("text-anchor", right ? "start" : "end")
      .text(`Peak: ${fmt(rows[pi].total)} ${metricLabel[geo.metric]}, ${monthName(M[pi])}`);
  }
  // the biggest class, labelled where its layer is thickest
  const big = C.cohort.biggest, sb = stack.find((s) => +s.key === big);
  if (sb) {
    const bi = d3.maxIndex(sb, (d) => d[1] - d[0]);
    const th = y(sb[bi][0]) - y(sb[bi][1]);
    if (th > 14) {
      an.append("text").attr("x", x(dates[bi])).attr("y", (y(sb[bi][0]) + y(sb[bi][1])) / 2 + 4)
        .attr("text-anchor", "middle").text(`Class of ${big}`);
    }
  }
  // right edge: today's mix
  if (m.r > 100) {
    const li = NM - 1, last = rows[li];
    const old = COH.filter((c) => c <= 2010).reduce((a, c) => a + O.layers[c][geo.metric][li], 0);
    const tot = COH.reduce((a, c) => a + O.layers[c][geo.metric][li], 0);
    const ty = y(geo.scale === "share" ? 1 : last.total);
    const tx = W - m.r + 10;
    an.append("text").attr("x", tx).attr("y", Math.max(m.t + 10, ty - 6)).text(`${monthName(M[li])}`);
    an.append("text").attr("x", tx).attr("y", Math.max(m.t + 10, ty - 6) + 15)
      .text(`${fmt(tot)} ${{ editors: "editors", active5: "active editors", edits: "edits" }[geo.metric]}`);
    an.append("text").attr("class", "sub2").attr("x", tx).attr("y", Math.max(m.t + 10, ty - 6) + 30)
      .text(`${pct(old / Math.max(1, tot))} from classes ≤2010`);
  }
  const hl = geoSvg.append("line").attr("class", "hoverline").attr("y1", m.t).attr("y2", H - m.b).attr("opacity", 0);
  geoSvg.on("mousemove", (ev) => {
    const [mx, my] = d3.pointer(ev);
    const i = Math.max(0, Math.min(NM - 1, d3.bisectCenter(dates, x.invert(mx))));
    const v = y.invert(my);
    const s = stack.find((s) => v >= s[i][0] && v <= s[i][1]);
    hl.attr("x1", x(dates[i])).attr("x2", x(dates[i])).attr("opacity", 1);
    const raw = O.layers, tot = COH.reduce((a, c) => a + raw[c][geo.metric][i], 0);
    const top = COH.map((c) => [c, raw[c][geo.metric][i]]).filter((d) => d[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    let html = `<div class="t">${monthName(M[i])}</div><div class="r"><span>Registered ${metricLabel[geo.metric]}</span><span><b>${fmt(tot)}</b></span></div>`;
    if (s) {
      const c = +s.key, n = raw[c][geo.metric][i];
      html += `<div class="r" style="color:${cohortColor(c)}"><span>Class of ${c}</span><span><b>${fmt(n)}</b> · ${pct(n / Math.max(1, tot))}</span></div>`;
    }
    html += `<div class="m">largest classes: ${top.map(([c, n]) => `${c} (${fmt(n)})`).join(", ")}</div>`;
    showTip(html, ev);
    setGeoHi(s ? +s.key : null, false);
  }).on("mouseleave", () => { hideTip(); hl.attr("opacity", 0); setGeoHi(null, false); });
}

function setGeoHi(c, redraw = true) {
  geo.hi = c;
  geoSvg.selectAll("path.layer").attr("opacity", (s) => (c == null || c === +s.key ? 1 : 0.22));
  d3.selectAll("#cohortKey span").classed("on", function () { return +this.dataset.c === c; });
  d3.selectAll("#retSvg .row").attr("opacity", function () { return c == null || +this.dataset.c === c ? 1 : 0.3; });
}

const key = $("#cohortKey");
key.innerHTML = `<em>${COH[0]}</em>` + COH.map((c) => `<span data-c="${c}" style="background:${cohortColor(c)}" title="Class of ${c}"></span>`).join("") + `<em>${COH[COH.length - 1]}</em>`;
key.querySelectorAll("span").forEach((sp) => {
  sp.addEventListener("mouseenter", (ev) => {
    const c = +sp.dataset.c;
    setGeoHi(c);
    const size = O.cohort_year.find((r) => r.cohort === c && r.year === c)?.editors ?? 0;
    showTip(`<div class="t">Class of ${c}</div><div class="m">${fmt(size)} registered people made their first edit here in ${c}</div>`, ev);
  });
  sp.addEventListener("mouseleave", () => { setGeoHi(null); hideTip(); });
});
for (const [id, k] of [["#geoMetric", "metric"], ["#geoScale", "scale"]]) {
  $(id).addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    geo[k] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    drawGeo();
  });
}

// ---------- retention triangle ----------
function drawRet() {
  const svg = d3.select("#retSvg"), el = svg.node(), W = el.clientWidth, H = el.clientHeight;
  svg.selectAll("*").remove();
  const years = d3.range(COH[0], yearEnd + 1);
  const m = { l: 30, r: 4, t: 4, b: 18 };
  const cw = (W - m.l - m.r) / years.length, ch = (H - m.t - m.b) / COH.length;
  const size = {}, val = {};
  for (const r of O.cohort_year) {
    if (r.year === r.cohort) size[r.cohort] = r.editors;
    val[`${r.cohort}-${r.year}`] = r.editors;
  }
  const lg = d3.scaleLog().domain([0.004, 0.3]).range([0, 1]).clamp(true);
  const ramp = d3.interpolateRgbBasis(["#141826", "#3a3150", "#8a4f5c", "#e08a5a", "#ffd9a0"]);
  const col = (v) => (v > 0 ? ramp(lg(v)) : "#10131c");
  const g = svg.append("g");
  for (const [ri, c] of COH.entries()) {
    const row = g.append("g").attr("class", "row").attr("data-c", c);
    for (const [yi, y] of years.entries()) {
      if (y < c) continue;
      const v = val[`${c}-${y}`] ?? 0, s = size[c] || 1;
      row.append("rect").attr("x", m.l + yi * cw + 0.5).attr("y", m.t + ri * ch + 0.5)
        .attr("width", Math.max(1, cw - 1)).attr("height", Math.max(1, ch - 1)).attr("rx", 1)
        .attr("fill", y === c ? cohortColor(c) : col(v / s))
        .on("mousemove", (ev) => showTip(`<div class="t">Class of ${c} in ${y}</div>
          <div class="r"><span>still editing</span><span><b>${fmt(v)}</b> of ${fmt(s)}</span></div>
          <div class="m">${y === c ? "first year (100%)" : pct(v / s, 1) + " of the class"}${y === yearEnd ? partialNote : ""}</div>`, ev))
        .on("mouseenter", () => setGeoHi(c)).on("mouseleave", () => { hideTip(); setGeoHi(null); });
    }
    if (c % 5 === 0 || ri === 0 || c === COH[COH.length - 1])
      svg.append("text").attr("x", m.l - 4).attr("y", m.t + ri * ch + ch / 2 + 3.5).attr("text-anchor", "end")
        .attr("fill", css("--mute")).attr("font-size", 10).text(c);
  }
  for (const [yi, y] of years.entries()) if (y % 5 === 0 && m.l + yi * cw + cw / 2 < W - 12)
    svg.append("text").attr("x", m.l + yi * cw + cw / 2).attr("y", H - 5).attr("text-anchor", "middle")
      .attr("fill", css("--mute")).attr("font-size", 10).text(y);
  // median share of a class still active 5 years later
  const five = COH.filter((c) => c + 5 <= yearEnd && size[c] >= 50).map((c) => (val[`${c}-${c + 5}`] ?? 0) / size[c]);
  const ten = COH.filter((c) => c + 10 <= yearEnd && size[c] >= 50).map((c) => (val[`${c}-${c + 10}`] ?? 0) / size[c]);
  $("#retNote").innerHTML = `Five years after their first edit, a median <b>${pct(d3.median(five), 1)}</b> of a class
    is still editing; after ten years, <b>${pct(d3.median(ten), 1)}</b>. Of the ${fmt(C.cohort.size)} who started in
    ${C.cohort.biggest}, <b>${fmt(C.cohort.still)}</b> edited in ${C.cohort.still_year}.`;
}

// ---------- small multiples ----------
const roll = (a, k) => a.map((_, i) => { const s = Math.max(0, i - k + 1); return d3.sum(a.slice(s, i + 1)); });
function smFrame(sel, yMax, fy = d3.format(".0%")) {
  const svg = d3.select(sel), el = svg.node(), W = el.clientWidth, H = el.clientHeight;
  svg.selectAll("*").remove();
  const m = { l: 30, r: 8, t: 14, b: 18 };
  const x = d3.scaleUtc().domain([dates[0], dates[NM - 1]]).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, yMax]).nice().range([H - m.b, m.t]);
  svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(3).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(W < 340 ? 4 : 6).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(3).tickFormat(fy).tickSizeOuter(0)).call((g) => g.select(".domain").remove());
  return { svg, x, y, W, H, m };
}
function hoverMonths(f, html) {
  const hl = f.svg.append("line").attr("class", "hoverline").attr("y1", f.m.t).attr("y2", f.H - f.m.b).attr("opacity", 0);
  f.svg.on("mousemove", (ev) => {
    const [mx] = d3.pointer(ev);
    const i = Math.max(0, Math.min(NM - 1, d3.bisectCenter(dates, f.x.invert(mx))));
    hl.attr("x1", f.x(dates[i])).attr("x2", f.x(dates[i])).attr("opacity", 1);
    showTip(html(i), ev);
  }).on("mouseleave", () => { hideTip(); hl.attr("opacity", 0); });
}
function anno(f, i, yv, text, dx = 0, dy = -16, anchor = "middle") {
  const g = f.svg.append("g").attr("class", "anno");
  const px = f.x(dates[i]), py = f.y(yv);
  g.append("circle").attr("cx", px).attr("cy", py).attr("r", 2.2);
  g.append("line").attr("x1", px).attr("y1", py).attr("x2", px + dx * 0.7).attr("y2", py + dy + 4);
  g.append("text").attr("x", px + dx).attr("y", py + dy).attr("text-anchor", anchor).text(text);
}

function drawAnon() {
  const K = 12;
  const ra = roll(S.anon, K), re = roll(S.edits, K), rt = roll(S.anon_temp, K);
  const share = ra.map((a, i) => a / Math.max(1, re[i]));
  const tshare = rt.map((a, i) => a / Math.max(1, re[i]));
  const start = S.edits.findIndex((v, i) => re[i] >= 300);
  const f = smFrame("#smAnon svg", d3.max(share.slice(start)));
  const ar = d3.area().defined((_, i) => i >= start).x((_, i) => f.x(dates[i])).y0(f.y(0)).curve(d3.curveMonotoneX);
  f.svg.append("path").attr("d", ar.y1((d) => f.y(d))(share)).attr("fill", css("--anon")).attr("opacity", 0.35);
  f.svg.append("path").attr("d", d3.line().defined((_, i) => i >= start).x((_, i) => f.x(dates[i])).y((d) => f.y(d)).curve(d3.curveMonotoneX)(share))
    .attr("fill", "none").attr("stroke", css("--anon")).attr("stroke-width", 1.6);
  f.svg.append("path").attr("d", ar.y1((d) => f.y(d))(tshare)).attr("fill", "#e4d6ff").attr("opacity", 0.85);
  const pi = d3.maxIndex(share.map((v, i) => (i >= start ? v : -1)));
  anno(f, pi, share[pi], `${pct(share[pi])} · year to ${monthName(M[pi])}`, 14, -6, "start");
  anno(f, NM - 1, share[NM - 1], `${pct(share[NM - 1])}`, -6, -14, "end");
  hoverMonths(f, (i) => `<div class="t">${monthName(M[i])}</div>
    <div class="r"><span>anonymous edits</span><span><b>${fmt(S.anon[i])}</b> of ${fmt(S.edits[i])}</span></div>
    ${S.anon_temp[i] ? `<div class="r"><span>· via temporary accounts</span><span>${fmt(S.anon_temp[i])}</span></div>` : ""}
    <div class="r"><span>12-month share</span><span><b>${pct(share[i], 1)}</b></span></div>
    <div class="m">${fmt(S.anon_ids[i])} distinct IPs / temporary accounts this month</div>`);
  const a = C.anon;
  $("#smAnon .note").innerHTML = `In ${a.peak_year}, <b>${pct(a.peak_share)}</b> of edits came from logged-out editors;
    in ${a.now_year}${partialNote}, <b>${pct(a.now_share ?? a.last_share)}</b>.` +
    (a.temp_first ? ` Since ${monthName(a.temp_first)} they appear as temporary accounts instead of IPs <span class="mute">(light band)</span>.` : "") +
    ` <span class="mute">12-month rolling share.</span>`;
}

function drawBot() {
  const K = 3, re = roll(S.edits, K);
  const keys = [...O.bots.map((b) => b.user), "other"];
  const ser = Object.fromEntries(O.bots.map((b) => [b.user, roll(b.series, K)]));
  ser.other = roll(O.bot_other, K);
  const rows = d3.range(NM).map((i) => Object.fromEntries([["i", i], ...keys.map((k) => [k, ser[k][i] / Math.max(1, re[i])])]));
  const st = d3.stack().keys(keys)(rows);
  const f = smFrame("#smBot svg", d3.max(rows, (r) => d3.sum(keys, (k) => r[k])));
  f.svg.append("g").selectAll("path").data(st).join("path")
    .attr("d", d3.area().x((d) => f.x(dates[d.data.i])).y0((d) => f.y(d[0])).y1((d) => f.y(d[1])).curve(d3.curveMonotoneX))
    .attr("fill", (s) => s.key === "other" ? "#3b4258" : botColor[s.key]).attr("stroke", "#07080d").attr("stroke-width", 0.4);
  // the two biggest bots: a rule where each arrived, labels stacked at the top
  const mk = f.svg.append("g").attr("class", "anno");
  for (const [n, b] of O.bots.slice(0, 2).entries()) {
    const fi = b.series.findIndex((v) => v > 0), px = f.x(dates[fi]);
    mk.append("line").attr("x1", px).attr("x2", px).attr("y1", f.m.t - 4 + n * 12).attr("y2", f.H - f.m.b)
      .attr("stroke", botColor[b.user]).attr("stroke-dasharray", "2 2").attr("opacity", 0.8);
    mk.append("text").attr("x", px - 4).attr("y", f.m.t + 4 + n * 12).attr("text-anchor", "end")
      .text(`${b.user} · ${monthName(M[fi])}`);
  }
  // the highest earlier spike, labelled with the bot that made most of it that month
  const arrive = Math.min(...O.bots.slice(0, 2).map((b) => b.series.findIndex((v) => v > 0)));
  const tot = (r) => d3.sum(keys, (k) => r[k]);
  const pk = d3.maxIndex(rows.slice(0, Math.max(1, arrive - 12)), tot);
  const who = O.bots.map((b) => b.user).reduce((a, k) => (rows[pk][k] > (rows[pk][a] ?? -1) ? k : a), O.bots[0]?.user);
  if (who && rows[pk][who] > rows[pk].other) {
    const peakRaw = d3.maxIndex(O.bots.find((b) => b.user === who).series);
    mk.append("text").attr("x", f.x(dates[pk]) + 6).attr("y", f.y(tot(rows[pk])) + 8).attr("text-anchor", "start")
      .style("fill", botColor[who]).text(`${who} · ${monthName(M[peakRaw])}`);
  }
  $("#smBot .minikey").innerHTML = O.bots.map((b) => `<span><i class="sw" style="background:${botColor[b.user]}"></i>${esc(b.user)}</span>`).join("") +
    `<span><i class="sw" style="background:#3b4258"></i>${fmt(nBot - O.bots.length)} others</span>`;
  hoverMonths(f, (i) => {
    const tot = d3.sum(O.bots, (b) => b.series[i]) + O.bot_other[i];
    const lst = O.bots.filter((b) => b.series[i]).map((b) => `<div class="r"><span style="color:${botColor[b.user]}">${esc(b.user)}</span><span>${fmt(b.series[i])}</span></div>`).join("");
    return `<div class="t">${monthName(M[i])}</div><div class="r"><span>bot edits</span><span><b>${fmt(tot)}</b> of ${fmt(S.edits[i])} (${pct(tot / Math.max(1, S.edits[i]))})</span></div>${lst}
      ${O.bot_other[i] ? `<div class="r"><span>other bots</span><span>${fmt(O.bot_other[i])}</span></div>` : ""}`;
  });
  const b = C.bot, t = b.top;
  $("#smBot .note").innerHTML = `Bots peaked at <b>${pct(b.peak_share)}</b> of all edits in ${b.peak_year}. ` +
    (t ? `${esc(t.user)} arrived in ${monthName(t.first.slice(0, 7))} and made <b>${pct(t.share_bot_since)}</b> of all bot edits since,
      mostly <span class="mono">«${esc((t.summary?.example ?? "").split(".)")[0].slice(0, 60))}»</span>` +
      ((t.summary?.example ?? "").startsWith("Pelastettu") ? ` (“rescued 1 source, marked 0 as dead”: a dead link swapped for an archived copy).` : ".") : "");
}

function drawLast() {
  const segs = [];
  let botsTop = 0;
  for (const b of [...O.bots].sort((a, b) => b.last_word - a.last_word).slice(0, 2)) { segs.push({ k: b.user, n: b.last_word, c: botColor[b.user] }); botsTop += b.last_word; }
  segs.push({ k: "other bots", n: lw.bot - botsTop, c: "#2f8f78" });
  segs.push({ k: "registered people", n: lw.reg, c: css("--reg") || "#dfe5f2" });
  segs.push({ k: "anonymous", n: lw.anon, c: css("--anon") });
  const tot = d3.sum(segs, (s) => s.n);
  const box = $("#smLast .lastbar");
  box.innerHTML = `<div class="bar">${segs.map((s) => `<div style="flex:${s.n};background:${s.c}" data-k="${esc(s.k)}" data-n="${s.n}"></div>`).join("")}</div>
    <div class="rows">${segs.map((s) => `<i class="sw" style="background:${s.c}"></i><span class="k">${esc(s.k)}</span><span class="v">${fmt(s.n)} · ${pct(s.n / tot)}</span>`).join("")}</div>`;
  box.querySelectorAll(".bar div").forEach((d) => d.addEventListener("mousemove", (ev) =>
    showTip(`<div class="t">${d.dataset.k}</div><div class="m">saved the current version of ${fmt(+d.dataset.n)} of ${fmt(tot)} articles</div>`, ev)));
  box.querySelectorAll(".bar div").forEach((d) => d.addEventListener("mouseleave", hideTip));
  $("#smLast .note").innerHTML = `For <b>${fmt(lw.bot)}</b> of ${fmt(lw.pages)} articles, the newest version was saved by a bot,
    not a person; ${esc(lw.top[0][0])} alone holds ${fmt(lw.top[0][1])}. Click a bot in the careers below to see what it does.`;
}

let hourKind = "reg";
function drawHour() {
  const svg = d3.select("#smHour svg"), el = svg.node(), W = el.clientWidth, H = el.clientHeight;
  svg.selectAll("*").remove();
  const g = O.hours[hourKind];
  const m = { l: 28, r: 4, t: 4, b: 16 };
  const cw = (W - m.l - m.r) / 24, ch = (H - m.t - m.b) / 7;
  const mx = d3.max(g.flat());
  const base = { reg: "#dfe5f2", bot: BOT, ano: css("--anon") }[hourKind];
  const col = d3.scaleSequentialSqrt(d3.interpolateRgb("#141824", base)).domain([0, mx]);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      svg.append("rect").attr("x", m.l + h * cw + 0.5).attr("y", m.t + d * ch + 0.5).attr("width", cw - 1).attr("height", ch - 1)
        .attr("rx", 1.5).attr("fill", col(g[d][h]))
        .on("mousemove", (ev) => showTip(`<div class="t">${DOW[d]} ${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59</div><div class="m">${fmt(g[d][h])} edits, Helsinki time, 2003–${yearEnd}</div>`, ev))
        .on("mouseleave", hideTip);
    }
    svg.append("text").attr("x", m.l - 4).attr("y", m.t + d * ch + ch / 2 + 3).attr("text-anchor", "end")
      .attr("fill", css("--mute")).attr("font-size", 9.5).text(DOW[d]);
  }
  for (const h of [0, 6, 12, 18]) svg.append("text").attr("x", m.l + h * cw).attr("y", H - 3).attr("fill", css("--mute")).attr("font-size", 9.5).text(`${h}h`);
  const byH = d3.range(24).map((h) => d3.sum(g, (r) => r[h])), byD = g.map((r) => d3.sum(r));
  const ph = d3.maxIndex(byH), pd = d3.maxIndex(byD), lo = d3.minIndex(byH);
  const night = d3.sum(byH.slice(0, 6)) / d3.sum(byH);
  const who = { reg: "People", bot: "Bots", ano: "Anonymous editors" }[hourKind];
  $("#smHour .note").innerHTML = `${who} edit most at <b>${ph}–${ph + 1}h</b> and on <b>${DOW[pd]}s</b>; quietest at ${lo}h.
    <b>${pct(night)}</b> of their edits fall between midnight and 6 am.`;
}
$("#hourKind").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  hourKind = b.dataset.v;
  $("#hourKind").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  drawHour();
});

// ---------- career lanes (canvas) ----------
const lane = { filter: "all", sort: "first", rows: [], hover: -1, sel: null, N: 120 };
const cv = $("#laneCanvas"), ctx = cv.getContext("2d");
const MI0 = (+M[0].slice(0, 4) - 2003) * 12 + (+M[0].slice(5, 7) - 1);
let geomL = null;

function laneRows() {
  let u = L.users.filter((x) => lane.filter === "all" || x.kind === lane.filter).slice(0, lane.N);
  const by = {
    first: (a, b) => a.first.localeCompare(b.first), edits: (a, b) => b.edits - a.edits,
    last: (a, b) => b.last.localeCompare(a.last),
    span: (a, b) => (Date.parse(b.last) - Date.parse(b.first)) - (Date.parse(a.last) - Date.parse(a.first)),
  }[lane.sort];
  return u.sort(by);
}
function laneColor(u) { return u.kind === "bot" ? BOT : cohortColor(u.cohort); }

function drawLanes() {
  lane.rows = laneRows();
  $("#nLanes").textContent = lane.rows.length;
  const W = cv.parentElement.clientWidth, narrow = W < 600;
  const rowH = narrow ? 8 : 9, labelW = narrow ? 92 : 150, top = 22, rightW = narrow ? 0 : 64;
  const H = top + lane.rows.length * rowH + 4;
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const x0 = labelW + 6, x1 = W - rightW - 4, cw = (x1 - x0) / NM;
  geomL = { rowH, labelW, top, x0, x1, cw, W };
  // year grid
  ctx.font = "10px Instrument Sans, sans-serif";
  ctx.textAlign = "center";
  for (let y = +M[0].slice(0, 4); y <= yearEnd; y++) {
    const i = (y - 2003) * 12 - MI0;
    if (i < 0) continue;
    const gx = x0 + i * cw;
    ctx.fillStyle = "rgba(255,255,255,0.045)";
    ctx.fillRect(gx, top - 4, 1, H - top);
    if (y % (narrow ? 5 : 2) === 0) { ctx.fillStyle = "#8a93a8"; ctx.fillText(y, gx, 12); }
  }
  const mx = d3.max(lane.rows, (u) => d3.max(u.cells, (c) => c[1])) || 1;
  const a = d3.scaleLog().domain([1, Math.min(mx, 400)]).range([0.18, 1]).clamp(true);
  for (const [r, u] of lane.rows.entries()) {
    const yy = top + r * rowH;
    if (r === lane.hover || u.user === lane.sel) {
      ctx.fillStyle = u.user === lane.sel ? "rgba(255,180,107,0.13)" : "rgba(255,255,255,0.07)";
      ctx.fillRect(0, yy - 0.5, W, rowH);
    }
    const col = d3.color(laneColor(u));
    // name
    ctx.textAlign = "right";
    ctx.font = `${u.user === lane.sel ? 600 : 400} ${rowH >= 9 ? 9.5 : 8.5}px Instrument Sans, sans-serif`;
    ctx.fillStyle = u.kind === "bot" ? BOT : (r === lane.hover || u.user === lane.sel ? "#e8ecf4" : "#aeb6c7");
    let name = u.user;
    while (ctx.measureText(name).width > labelW - 4 && name.length > 3) name = name.slice(0, -2) + "…";
    ctx.fillText(name, labelW, yy + rowH - 1.2);
    // career span line
    const fi = (+u.first.slice(0, 4) - 2003) * 12 + +u.first.slice(5, 7) - 1 - MI0;
    const li = (+u.last.slice(0, 4) - 2003) * 12 + +u.last.slice(5, 7) - 1 - MI0;
    ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},0.18)`;
    ctx.fillRect(x0 + fi * cw, yy + rowH / 2 - 0.5, Math.max(1, (li - fi + 1) * cw), 1);
    for (const [mi, n] of u.cells) {
      const i = mi - MI0;
      if (i < 0 || i >= NM) continue;
      const al = a(n), hh = Math.max(1.5, (rowH - 1.5) * Math.min(1, 0.35 + 0.65 * al));
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${al})`;
      ctx.fillRect(x0 + i * cw, yy + (rowH - 1 - hh) / 2, Math.max(1, cw - 0.4), hh);
    }
    if (rightW) {
      ctx.textAlign = "right";
      ctx.font = "8.5px JetBrains Mono, monospace";
      ctx.fillStyle = "#6c7590";
      ctx.fillText(fmt(u.edits), W - 2, yy + rowH - 1.2);
    }
  }
}
function laneAt(ev) {
  const r = cv.getBoundingClientRect(), y = ev.clientY - r.top, x = ev.clientX - r.left;
  const row = Math.floor((y - geomL.top) / geomL.rowH);
  const mi = Math.floor((x - geomL.x0) / geomL.cw);
  return { row: row >= 0 && row < lane.rows.length ? row : -1, mi };
}
cv.addEventListener("mousemove", (ev) => {
  const { row, mi } = laneAt(ev);
  if (row !== lane.hover) { lane.hover = row; drawLanes(); }
  if (row < 0) return hideTip();
  const u = lane.rows[row];
  const cell = mi >= 0 && mi < NM ? u.cells.find((c) => c[0] - MI0 === mi) : null;
  showTip(`<div class="t">${esc(u.user)} ${u.kind === "bot" ? '<span class="badge bot">bot</span>' : ""}</div>
    ${mi >= 0 && mi < NM ? `<div class="r"><span>${monthName(M[mi])}</span><span><b>${fmt(cell ? cell[1] : 0)}</b> edits</span></div>` : ""}
    <div class="r"><span>total</span><span><b>${fmt(u.edits)}</b> edits · ${fmt(u.pages)} articles</span></div>
    <div class="r"><span>active</span><span>${u.first.slice(0, 4)}–${u.last.slice(0, 4)} · ${u.months} months</span></div>
    <div class="m">most edited: ${u.top.map(([t, n]) => `${esc(t)} (${fmt(n)})`).join(", ")}</div>`, ev);
});
cv.addEventListener("mouseleave", () => { lane.hover = -1; drawLanes(); hideTip(); });
cv.addEventListener("click", (ev) => { const { row } = laneAt(ev); if (row >= 0) openEditor(lane.rows[row].user); });
$("#laneFilter").addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  lane.filter = b.dataset.v;
  $("#laneFilter").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  drawLanes();
});
$("#laneSort").addEventListener("change", (ev) => { lane.sort = ev.target.value; drawLanes(); });

// ---------- editor profile ----------
const prof = $("#prof");
let profToken = 0;
async function openEditor(name, push = true) {
  const tok = ++profToken;
  lane.sel = name; drawLanes();
  if (push) { const u = new URL(location); u.searchParams.set("u", name); history.replaceState(null, "", u); }
  prof.innerHTML = `<div class="loading">Loading ${esc(name)}…</div>`;
  const r = await fetch(`${API}/editor?u=${encodeURIComponent(name)}`);
  if (tok !== profToken) return;
  if (!r.ok) { prof.innerHTML = `<div class="loading">No editor called ${esc(name)}.</div>`; return; }
  renderEditor(await r.json(), tok);
}

function renderEditor(u, tok) {
  const c = u.kind === "bot" ? BOT : cohortColor(u.cohort);
  const isBot = u.kind === "bot";
  const span = `${dateName(u.first_ts)} → ${dateName(u.last_ts)}`;
  const yrs = (Date.parse(u.last_ts) - Date.parse(u.first_ts)) / 3.156e10;
  prof.innerHTML = `
    <div class="kick"><span class="badge ${isBot ? "bot" : "reg"}" style="--c:${c}">${isBot ? "bot" : "person"}</span>
      ${isBot ? "" : `Class of ${u.cohort} ·`} #${fmt(u.rnk)} of ${fmt(nReg + nBot)} by edits</div>
    <h2 style="color:${c}">${esc(u.user)}</h2>
    <div class="who">${span} · ${yrs >= 1 ? `${yrs.toFixed(1)} years` : `${Math.max(1, Math.round(yrs * 365))} days`}, active in ${fmt(u.months)} months
      ${isBot ? "" : `· #${fmt(u.cohort_rank)} of ${fmt(u.cohort_size)} in the class of ${u.cohort}`}</div>
    <div class="links"><a href="${wikiUser(u.user)}" target="_blank" rel="noopener">User page ↗</a>
      <a href="${wikiContrib(u.user)}" target="_blank" rel="noopener">All contributions ↗</a></div>
    <div class="stats">
      <div class="stat"><b>${fmt(u.edits)}</b><span>edits here</span></div>
      <div class="stat"><b>${fmt(u.pages)}</b><span>articles touched</span></div>
      <div class="stat"><b>${fmt(u.created)}</b><span>articles started</span></div>
      <div class="stat"><b>${fmt(u.last_word)}</b><span>still has the last word</span></div>
      <div class="stat"><b>${pct(u.reverts / u.edits, 1)}</b><span>of edits are reverts (${fmt(u.reverts)})</span></div>
      <div class="stat"><b>${pct(u.undone / u.edits, 1)}</b><span>undone by others (${fmt(u.undone)})</span></div>
      <div class="stat"><b>${pct(u.minor / u.edits)}</b><span>marked minor</span></div>
      <div class="stat"><b>${d3.format(".2~s")(u.added - u.removed).replace("G", "B")}B</b><span>net bytes (+${d3.format(".2~s")(u.added)} / −${d3.format(".2~s")(u.removed)})</span></div>
    </div>
    <h3>Edits per year <span><i class="sw" style="background:${c}"></i> edits <i class="sw" style="background:var(--revert)"></i> later undone</span></h3>
    <svg id="pYears" height="92"></svg>
    ${u.hours ? `<h3>When <span>Helsinki time</span></h3><svg id="pHours" height="70"></svg>` : ""}
    <h3>Most edited articles</h3>
    <ul class="plist" style="--c:${c}">${u.pages_top.map((p) => `<li><a href="${curid(p.page_id)}" target="_blank" rel="noopener" title="${esc(p.title)}">${esc(p.title)}</a>
      <div class="b" style="width:${(100 * p.edits / u.pages_top[0].edits).toFixed(1)}%"></div><span class="v">${fmt(p.edits)}</span></li>`).join("")}</ul>
    ${u.created_top.length ? `<h3>Articles they started <span>by versions since</span></h3>
      <ul class="plist" style="--c:${css("--warm")}">${u.created_top.map((p) => `<li><a href="${curid(p.page_id)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <div class="b" style="width:${(100 * p.edits / u.created_top[0].edits).toFixed(1)}%"></div><span class="v">${fmt(p.edits)}</span></li>`).join("")}</ul>` : ""}
    ${u.last_word_pages.length ? `<h3>Saved the current version of <span>${fmt(u.last_word)} articles</span></h3>
      <div class="small mute">${u.last_word_pages.map((p) => `<a href="${curid(p.page_id)}" target="_blank" rel="noopener">${esc(p.title)}</a>`).join(" · ")}${u.last_word > u.last_word_pages.length ? " …" : ""}</div>` : ""}
    ${u.summaries.length ? `<h3>Typical edit summaries <span>digits folded</span></h3>
      <ul class="summ">${u.summaries.map((s) => `<li><span>${s.example ? esc(s.example) : "<em>(no summary)</em>"}</span><span class="v">${fmt(s.n)}×</span></li>`).join("")}</ul>` : ""}
    <div id="firstWords"><h3>First words <span>FOR SYSTEM_TIME AS OF</span></h3><div class="loading">Reading the first version of an article they started…</div></div>
    <details><summary>The SQL behind this profile</summary><pre class="sql">${esc(u.sql)}</pre></details>`;
  drawYears(u, c);
  if (u.hours) drawMiniHours(u.hours, c);
  fetch(`${API}/firstwords?u=${encodeURIComponent(u.user)}`).then((r) => r.json()).then((f) => {
    if (tok !== profToken) return;
    const box = $("#firstWords");
    if (f.none || f.error) {
      box.innerHTML = u.created ? `<h3>First words</h3><div class="small mute">None of the ${fmt(f.created ?? u.created)} articles ${esc(u.user)} started has its text history loaded (the text subset covers articles whose whole history is under 0.5 MB).</div>` : "";
      return;
    }
    const grow = f.now_len ? `${fmt(f.len)} → ${fmt(f.now_len)} bytes today, ${fmt(f.versions)} versions later` : `${fmt(f.len)} bytes`;
    box.innerHTML = `<h3>First words <span>FOR SYSTEM_TIME AS OF</span></h3>
      <div class="first"><div class="meta"><a href="${curid(f.page_id)}" target="_blank" rel="noopener">${esc(f.title)}</a>
        as ${esc(u.user)} started it, ${dateName(f.ts)} · <a href="https://fi.wikipedia.org/?oldid=${f.rev_id}" target="_blank" rel="noopener">rev ${f.rev_id} ↗</a></div>
        <blockquote>${esc(f.text)}${f.text.length >= 700 ? "…" : ""}</blockquote>
        <div class="meta">${grow}</div></div>
      <details><summary>The SQL</summary><pre class="sql">${esc(f.sql)}</pre></details>`;
  }).catch(() => {});
}

function drawYears(u, c) {
  const svg = d3.select("#pYears"), W = svg.node().clientWidth, H = 92;
  const m = { l: 28, r: 2, t: 6, b: 16 };
  const yrs = d3.range(2003, yearEnd + 1);
  const by = Object.fromEntries(u.years.map((r) => [r.year, r]));
  const x = d3.scaleBand().domain(yrs).range([m.l, W - m.r]).padding(0.18);
  const y = d3.scaleLinear().domain([0, d3.max(u.years, (r) => r.edits) || 1]).nice().range([H - m.b, m.t]);
  svg.append("g").attr("class", "grid").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickSize(-(W - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickFormat(d3.format("~s"))).call((g) => g.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(yrs.filter((y) => y % 4 === 3)).tickSizeOuter(0));
  for (const yr of yrs) {
    const r = by[yr]; if (!r) continue;
    svg.append("rect").attr("x", x(yr)).attr("width", x.bandwidth()).attr("y", y(r.edits)).attr("height", y(0) - y(r.edits)).attr("fill", c).attr("rx", 1.5);
    if (r.undone) svg.append("rect").attr("x", x(yr)).attr("width", x.bandwidth()).attr("y", y(r.undone)).attr("height", Math.max(1, y(0) - y(r.undone))).attr("fill", css("--revert"));
    svg.append("rect").attr("x", x(yr) - 1).attr("width", x.bandwidth() + 2).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", "transparent")
      .on("mousemove", (ev) => showTip(`<div class="t">${esc(u.user)} in ${yr}</div>
        <div class="r"><span>edits</span><span><b>${fmt(r.edits)}</b></span></div>
        <div class="r"><span>minor</span><span>${fmt(r.minor)}</span></div>
        <div class="r"><span>reverts made</span><span>${fmt(r.reverts)}</span></div>
        <div class="r"><span>undone by others</span><span>${fmt(r.undone)}</span></div>
        <div class="r"><span>bytes added / removed</span><span>+${fmt(r.added)} / −${fmt(r.removed)}</span></div>`, ev))
      .on("mouseleave", hideTip);
  }
}

function drawMiniHours(g, c) {
  const svg = d3.select("#pHours"), W = svg.node().clientWidth, H = 70;
  const m = { l: 28, r: 2, t: 2, b: 12 };
  const cw = (W - m.l - m.r) / 24, ch = (H - m.t - m.b) / 7;
  const col = d3.scaleSequentialSqrt(d3.interpolateRgb("#141824", c)).domain([0, d3.max(g.flat()) || 1]);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) svg.append("rect").attr("x", m.l + h * cw + 0.4).attr("y", m.t + d * ch + 0.4)
      .attr("width", cw - 0.8).attr("height", ch - 0.8).attr("rx", 1).attr("fill", col(g[d][h]))
      .on("mousemove", (ev) => showTip(`${DOW[d]} ${h}:00 · <b>${fmt(g[d][h])}</b> edits`, ev)).on("mouseleave", hideTip);
    if (d % 2 === 0) svg.append("text").attr("x", m.l - 4).attr("y", m.t + d * ch + ch - 1).attr("text-anchor", "end").attr("fill", css("--mute")).attr("font-size", 8.5).text(DOW[d]);
  }
  for (const h of [0, 6, 12, 18]) svg.append("text").attr("x", m.l + h * cw).attr("y", H - 1).attr("fill", css("--mute")).attr("font-size", 8.5).text(`${h}h`);
}

// ---------- search ----------
const q = $("#q"), qres = $("#qres");
let qTimer;
q.addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(async () => {
    const v = q.value.trim();
    if (!v) { qres.innerHTML = ""; return; }
    const r = await (await fetch(`${API}/search?q=${encodeURIComponent(v)}`)).json();
    qres.innerHTML = r.map((x) => `<div data-u="${esc(x.user)}"><span style="color:${x.kind === "bot" ? BOT : cohortColor(x.cohort)}">${esc(x.user)}</span>
      <span class="mute small">${x.kind === "bot" ? "bot" : x.cohort}</span><span class="n">${fmt(x.edits)}</span></div>`).join("") ||
      `<div class="mute">No named editor matches.</div>`;
  }, 160);
});
qres.addEventListener("click", (ev) => {
  const d = ev.target.closest("[data-u]"); if (!d) return;
  qres.innerHTML = ""; q.value = "";
  openEditor(d.dataset.u);
});
q.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { const d = qres.querySelector("[data-u]"); if (d) { qres.innerHTML = ""; q.value = ""; openEditor(d.dataset.u); } }
  if (ev.key === "Escape") { qres.innerHTML = ""; }
});

// ---------- go ----------
function drawAll() { drawGeo(); drawRet(); drawAnon(); drawBot(); drawLast(); drawHour(); drawLanes(); }
let rz, lastW = document.body.clientWidth;   // width before drawing: if drawing adds a scrollbar, the observer redraws
drawAll();
new ResizeObserver(() => {   // redraw when the layout width changes (window resize, rotation, scrollbar)
  const w = document.body.clientWidth;
  if (w === lastW) return;
  lastW = w; clearTimeout(rz); rz = setTimeout(drawAll, 120);
}).observe(document.body);
const start = new URLSearchParams(location.search).get("u") || L.users[0].user;
await openEditor(start, false);
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
