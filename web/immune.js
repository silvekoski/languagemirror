import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const KINDS = ["anon", "temp", "reg", "bot"];
const KLABEL = { anon: "IP address", temp: "Temporary account", reg: "Registered", bot: "Bot" };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const KCOL = { anon: css("--anon"), temp: css("--temp"), reg: css("--reg"), bot: css("--bot") };
const RED = css("--revert"), INK = css("--ink"), MUTE = css("--mute"), FAINT = css("--faint");
const fmtN = d3.format(","), pct = (x, d = 0) => (100 * x).toFixed(d) + "%";
const TICKS = [[1, "1 s"], [60, "1 min"], [3600, "1 h"], [86400, "1 day"], [7 * 86400, "1 week"],
  [30.44 * 86400, "1 month"], [365.25 * 86400, "1 year"], [3652.5 * 86400, "10 years"]];

function dur(s) {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`;
  if (s < 30.44 * 86400) return `${(s / 86400).toFixed(s < 864000 ? 1 : 0)} days`;
  if (s < 365.25 * 86400) return `${(s / 30.44 / 86400).toFixed(1)} months`;
  return `${(s / 365.25 / 86400).toFixed(1)} years`;
}

const tip = document.getElementById("tip");
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
}
const hideTip = () => (tip.hidden = true);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function svgIn(el, h) {
  el.innerHTML = "";
  const w = el.clientWidth;
  return { svg: d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("height", h), w, h };
}
function legend(el, items) {
  el.innerHTML = items.map(([c, l, line]) => `<span><i class="${line ? "line" : ""}" style="background:${c}"></i>${l}</span>`).join("");
}

let D;
const data = await fetch("/api/immune/overview").then((r) => r.json());
D = data;
const M = D.meta;
const yearOf = Object.fromEntries(D.years.map((y) => [y.year, y]));
const YEARS = D.years.map((y) => y.year);
const lastDay = new Date(M.last_ts.replace(" ", "T") + "Z");

/* ---------- header ---------- */
document.getElementById("span").textContent = `${fmtN(M.n_reverts)} reverts · ${fmtN(M.n_bad)} undone versions`;
const best = D.years.filter((y) => y.n >= 500).reduce((a, b) => (b.p50 < a.p50 ? b : a));
const last = D.years[D.years.length - 1];
document.getElementById("lede").innerHTML =
  `Each time an editor restores an earlier text, the versions in between were rejected — Wikipedia's immune response.
   Of <b>${fmtN(M.n_bad)}</b> such bad versions, half were gone within <b>${dur(M.median_s)}</b>.
   But healing has slowed: in <b>${best.year}</b> the median bad version lived <b>${dur(best.p50)}</b>; in <b>${last.year}</b> it lived <b>${dur(last.p50)}</b>.`;
document.getElementById("kpis").innerHTML = [
  [fmtN(M.n_bad), "bad versions undone by someone else", ""],
  [dur(M.median_s), "median lifetime of a bad version", "hot"],
  [pct(M.within_minute), "gone within a minute", ""],
  [fmtN(M.over_year), "survived more than a year", "hot"],
].map(([b, s, c]) => `<div class="kpi ${c}"><b>${b}</b><span>${s}</span></div>`).join("");

/* ---------- 1. violins ---------- */
function drawViolin() {
  const el = document.getElementById("violin");
  const narrow = el.clientWidth < 600;
  const { svg, w, h } = svgIn(el, narrow ? 340 : 400);
  const m = { l: narrow ? 50 : 64, r: narrow ? 8 : 16, t: 26, b: 26 };
  const x = d3.scaleBand().domain(YEARS).range([m.l, w - m.r]).padding(0.08);
  const y = d3.scaleLinear().domain([0, 9]).range([h - m.b, m.t]);
  const byYear = d3.group(D.bins, (d) => d.year);
  let maxShare = 0;
  for (const [yr, bs] of byYear) for (const b of bs) maxShare = Math.max(maxShare, b.n / yearOf[yr].n);
  const half = x.bandwidth() / 2;
  const wScale = d3.scaleLinear().domain([0, maxShare]).range([0, half * 0.98]);

  for (const [s, l] of TICKS.slice(1)) {
    if (Math.log10(s) > 9) continue;
    svg.append("line").attr("class", "grid-line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(Math.log10(s))).attr("y2", y(Math.log10(s)));
    svg.append("text").attr("class", "axis").attr("x", m.l - 8).attr("y", y(Math.log10(s)) + 4).attr("text-anchor", "end")
      .append("tspan").attr("fill", MUTE).style("font-size", "11px").text(l);
  }
  const area = d3.area().curve(d3.curveCatmullRom).y((d) => y(d.c));
  const g = svg.append("g");
  for (const yr of YEARS) {
    const bs = byYear.get(yr) || [];
    const n = yearOf[yr].n, map = new Map(bs.map((b) => [b.bin, b.n]));
    const lo = d3.min(bs, (b) => b.bin), hi = d3.max(bs, (b) => b.bin);
    const pts = [];
    for (let b = lo - 1; b <= hi + 1; b++) pts.push({ c: Math.max(0, (b + 0.5) * M.bin), s: (map.get(b) || 0) / n });
    const cx = x(yr) + half;
    g.append("path").datum(pts).attr("d", area.x0((d) => cx - wScale(d.s)).x1((d) => cx + wScale(d.s)))
      .attr("fill", RED).attr("fill-opacity", 0.32).attr("stroke", RED).attr("stroke-opacity", 0.7).attr("stroke-width", 1);
    const yr0 = yearOf[yr];
    g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", y(Math.log10(Math.max(1, yr0.p25)))).attr("y2", y(Math.log10(Math.max(1, yr0.p75))))
      .attr("stroke", INK).attr("stroke-opacity", 0.55).attr("stroke-width", 3).attr("stroke-linecap", "round");
  }
  const med = D.years.map((d) => [x(d.year) + half, y(Math.log10(Math.max(1, d.p50)))]);
  svg.append("path").attr("d", d3.line().curve(d3.curveMonotoneX)(med)).attr("fill", "none").attr("stroke", INK).attr("stroke-width", 1.8);
  svg.selectAll("circle.med").data(D.years).join("circle").attr("class", "med").attr("r", 3.5)
    .attr("cx", (d) => x(d.year) + half).attr("cy", (d) => y(Math.log10(Math.max(1, d.p50)))).attr("fill", INK);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
    .call(d3.axisBottom(x).tickValues(YEARS.filter((yy) => !narrow || yy % 4 === 0)).tickFormat((d) => (narrow ? d : "’" + String(d).slice(2))).tickSize(0).tickPadding(8))
    .call((s) => s.select(".domain").remove());

  // annotations: fastest year vs the latest year (both computed)
  const ann = (d, text, dy, anchor) => {
    const px = x(d.year) + half, py = y(Math.log10(d.p50));
    svg.append("line").attr("x1", px).attr("x2", px).attr("y1", py + (dy < 0 ? -6 : 6)).attr("y2", py + dy).attr("stroke", INK).attr("stroke-opacity", 0.5);
    svg.append("text").attr("class", "anno-big").attr("x", px).attr("y", py + dy + (dy < 0 ? -6 : 14)).attr("text-anchor", anchor).text(text);
  };
  ann(best, `${best.year}: median ${dur(best.p50)}`, -70, "middle");
  ann(last, `${last.year}: median ${dur(last.p50)}`, -95, "end");
  if (last.year === lastDay.getUTCFullYear())
    svg.append("text").attr("class", "anno mute").attr("x", w - m.r).attr("y", m.t - 10).attr("text-anchor", "end")
      .text(`${last.year} through ${lastDay.toISOString().slice(0, 10)}`);

  // hover columns
  svg.append("g").selectAll("rect").data(D.years).join("rect")
    .attr("x", (d) => x(d.year)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", h - m.t - m.b)
    .attr("fill", "transparent")
    .on("mousemove", (ev, d) => showTip(ev, `<b>${d.year}</b> · ${fmtN(d.n)} bad versions<br>
      median <b>${dur(d.p50)}</b> <span class="k">(middle half ${dur(d.p25)} – ${dur(d.p75)})</span><br>
      ${pct(d.within_hour)} undone within an hour, ${pct(d.within_day)} within a day<br>
      <span class="k">1 in 10 survived longer than ${dur(d.p90)}</span>`))
    .on("mouseleave", hideTip);
  document.getElementById("v-legend").innerHTML =
    `<span><i style="background:${RED};opacity:.6"></i>share of the year's bad versions</span>
     <span><i class="line" style="background:${INK}"></i>median</span>
     <span><i style="background:${INK};opacity:.55;width:3px"></i>middle 50%</span>`;
}

/* ---------- 2. who gets reverted ---------- */
let whoMode = "share";
function drawWho() {
  const el = document.getElementById("who");
  const { svg, w, h } = svgIn(el, 260);
  const m = { l: 40, r: 10, t: 22, b: 24 };
  const x = d3.scaleBand().domain(YEARS).range([m.l, w - m.r]).padding(0.18);
  const narrow = w < 500;
  const ys = D.years;
  let y;
  if (whoMode === "share") {
    y = d3.scaleLinear().domain([0, 1]).range([h - m.b, m.t]);
    const st = d3.stack().keys(KINDS).value((d, k) => d["bad_" + k] / d.n)(ys);
    svg.append("g").selectAll("g").data(st).join("g").attr("fill", (s) => KCOL[s.key])
      .selectAll("rect").data((s) => s.map((p) => ((p.key = s.key), p))).join("rect")
      .attr("x", (p) => x(p.data.year)).attr("width", x.bandwidth())
      .attr("y", (p) => y(p[1])).attr("height", (p) => Math.max(0, y(p[0]) - y(p[1])))
      .on("mousemove", (ev, p) => showTip(ev, `<b>${p.data.year}</b><br>` + KINDS.map((k) =>
        `<span style="color:${KCOL[k]}">■</span> ${KLABEL[k]}: ${fmtN(p.data["bad_" + k])} <span class="k">(${pct(p.data["bad_" + k] / p.data.n)})</span>`).join("<br>")))
      .on("mouseleave", hideTip);
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%")).tickSize(0).tickPadding(6)).call((s) => s.select(".domain").remove());
  } else {
    const rate = (d, k) => (d["ed_" + k] >= 300 ? d["bad_" + k] / d["ed_" + k] : null);
    const mx = d3.max(ys, (d) => d3.max(["anon", "temp", "reg"], (k) => rate(d, k)));
    y = d3.scaleLinear().domain([0, mx * 1.08]).range([h - m.b, m.t]);
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%")).tickSize(-(w - m.l - m.r)).tickPadding(6))
      .call((s) => s.select(".domain").remove()).call((s) => s.selectAll("line").attr("stroke", "rgba(255,255,255,.05)"));
    for (const k of ["anon", "temp", "reg"]) {
      const pts = ys.filter((d) => rate(d, k) !== null);
      svg.append("path").attr("d", d3.line().defined((d) => true).x((d) => x(d.year) + x.bandwidth() / 2).y((d) => y(rate(d, k)))(pts))
        .attr("fill", "none").attr("stroke", KCOL[k]).attr("stroke-width", 2);
      svg.selectAll(null).data(pts).join("circle").attr("r", 3).attr("fill", KCOL[k])
        .attr("cx", (d) => x(d.year) + x.bandwidth() / 2).attr("cy", (d) => y(rate(d, k)))
        .on("mousemove", (ev, d) => showTip(ev, `<b>${d.year}</b> · ${KLABEL[k]}<br>${fmtN(d["bad_" + k])} of ${fmtN(d["ed_" + k])} edits undone by others: <b>${pct(rate(d, k), 1)}</b>`))
        .on("mouseleave", hideTip);
    }
  }
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
    .call(d3.axisBottom(x).tickValues(YEARS.filter((yy) => yy % (narrow ? 4 : 2) === 0)).tickSize(0).tickPadding(7))
    .call((s) => s.select(".domain").remove());
  // the switch from IP addresses to temporary accounts, as seen in the data
  const sw = new Date(M.first_temp.replace(" ", "T") + "Z");
  const frac = (sw - Date.UTC(sw.getUTCFullYear(), 0, 1)) / (365.25 * 864e5);
  const sx = x(sw.getUTCFullYear()) + x.step() * frac - (x.step() - x.bandwidth()) / 2;
  svg.append("line").attr("x1", sx).attr("x2", sx).attr("y1", m.t - 8).attr("y2", h - m.b).attr("stroke", INK).attr("stroke-dasharray", "3 3");
  svg.append("text").attr("class", "anno").attr("x", sx - 6).attr("y", m.t - 10).attr("text-anchor", "end")
    .text(`${sw.toISOString().slice(0, 10)}: IPs → temp accounts`);
  const lastIp = M.last_ip.slice(0, 16), firstTemp = M.first_temp.slice(0, 16);
  const ip24 = yearOf[2024], t26 = yearOf[2026];
  document.getElementById("who-sub").innerHTML = whoMode === "share"
    ? `Who saved each undone version. Logged-out editors made <b>${pct((ip24.bad_anon + ip24.bad_temp) / ip24.n)}</b> of them in 2024. The last IP edit in this data is ${lastIp}, the first temporary account ${firstTemp} (UTC).`
    : `Of all edits by each kind of editor that year, the share later undone by someone else. ${t26 ? `In ${t26.year} temporary accounts: <b>${pct(t26.bad_temp / t26.ed_temp, 1)}</b> vs registered <b>${pct(t26.bad_reg / t26.ed_reg, 1)}</b>.` : ""}`;
  legend(document.getElementById("who-legend"), (whoMode === "share" ? KINDS : ["anon", "temp", "reg"]).map((k) => [KCOL[k], KLABEL[k]]));
}
document.getElementById("who-mode").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  whoMode = b.dataset.m;
  for (const c of e.currentTarget.children) c.classList.toggle("on", c === b);
  drawWho();
});

/* ---------- 3. hour of day ---------- */
function drawHours() {
  const el = document.getElementById("hours");
  const { svg, w, h } = svgIn(el, 260);
  const m = { l: 40, r: 12, t: 40, b: 26 };
  const H = D.hours;
  const tot = { a: d3.sum(H, (d) => d.all_edits), b: d3.sum(H, (d) => d.bad_edits), r: d3.sum(H, (d) => d.reverts) };
  const ser = [["all_edits", "a", FAINT, "All edits", "4 4"], ["bad_edits", "b", RED, "Bad versions saved", null], ["reverts", "r", INK, "Reverts made", null]];
  const x = d3.scaleLinear().domain([0, 23]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(H, (d) => Math.max(d.all_edits / tot.a, d.bad_edits / tot.b, d.reverts / tot.r)) * 1.1]).range([h - m.b, m.t]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(".0%")).tickSize(-(w - m.l - m.r)).tickPadding(6))
    .call((s) => s.select(".domain").remove()).call((s) => s.selectAll("line").attr("stroke", "rgba(255,255,255,.05)"));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
    .call(d3.axisBottom(x).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat((d) => String(d).padStart(2, "0") + ":00").tickSize(0).tickPadding(7))
    .call((s) => s.select(".domain").remove());
  // the gap between bad versions and reverts: where the immune system lags
  svg.append("path").datum(H).attr("fill", RED).attr("fill-opacity", 0.12)
    .attr("d", d3.area().curve(d3.curveMonotoneX).x((d) => x(d.hour)).y0((d) => y(d.reverts / tot.r)).y1((d) => y(Math.max(d.reverts / tot.r, d.bad_edits / tot.b))));
  for (const [k, t, c, , dash] of ser)
    svg.append("path").datum(H).attr("fill", "none").attr("stroke", c).attr("stroke-width", k === "all_edits" ? 1.5 : 2.2)
      .attr("stroke-dasharray", dash).attr("d", d3.line().curve(d3.curveMonotoneX).x((d) => x(d.hour)).y((d) => y(d[k] / tot[t])));
  const big = H.filter((d) => d.all_edits >= 20000);
  const hi = big.reduce((a, b) => (b.bad_edits / b.all_edits > a.bad_edits / a.all_edits ? b : a));
  const lo = big.reduce((a, b) => (b.bad_edits / b.all_edits < a.bad_edits / a.all_edits ? b : a));
  const hh = (n) => String(n).padStart(2, "0");
  const topY = y(Math.max(hi.all_edits / tot.a, hi.bad_edits / tot.b, hi.reverts / tot.r));
  svg.append("circle").attr("cx", x(hi.hour)).attr("cy", y(hi.bad_edits / tot.b)).attr("r", 4).attr("fill", RED);
  svg.append("line").attr("x1", x(hi.hour)).attr("x2", x(hi.hour)).attr("y1", y(hi.bad_edits / tot.b) - 6).attr("y2", m.t - 20).attr("stroke", RED).attr("stroke-opacity", .6);
  const lab = svg.append("text").attr("class", "anno").attr("y", m.t - 24)
    .text(`${hh(hi.hour)}:00 — riskiest hour: ${pct(hi.bad_edits / hi.all_edits, 1)} of edits undone`);
  const tw = lab.node().getComputedTextLength();
  lab.attr("x", Math.max(4, Math.min(x(hi.hour) - 12, w - m.r - tw)));
  void topY;
  const vline = svg.append("line").attr("y1", m.t).attr("y2", h - m.b).attr("stroke", "rgba(255,255,255,.25)").style("display", "none");
  svg.append("rect").attr("x", m.l).attr("width", w - m.l - m.r).attr("y", m.t).attr("height", h - m.t - m.b).attr("fill", "transparent")
    .on("mousemove", (ev) => {
      const hr = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])))), d = H[hr];
      vline.style("display", null).attr("x1", x(hr)).attr("x2", x(hr));
      showTip(ev, `<b>${hh(hr)}:00–${hh(hr)}:59</b> Helsinki time<br>${fmtN(d.all_edits)} edits, ${fmtN(d.bad_edits)} later undone (<b>${pct(d.bad_edits / d.all_edits, 1)}</b>)<br>${fmtN(d.reverts)} reverts made`);
    })
    .on("mouseleave", () => { vline.style("display", "none"); hideTip(); });
  document.getElementById("hour-sub").innerHTML =
    `Share of each day's total by hour, Helsinki time. Bad versions peak in school hours: at ${hh(hi.hour)}:00 <b>${pct(hi.bad_edits / hi.all_edits, 1)}</b> of all edits are later undone, at ${hh(lo.hour)}:00 only <b>${pct(lo.bad_edits / lo.all_edits, 1)}</b>.`;
  legend(document.getElementById("hour-legend"), ser.map(([, , c, l]) => [c, l, true]).concat([[RED + "33", "bad versions outpace reverts"]]));
}

/* ---------- 4. lifetime histogram ---------- */
function drawHist() {
  const el = document.getElementById("hist");
  const { svg, w, h } = svgIn(el, el.clientWidth < 600 ? 260 : 300);
  const m = { l: 44, r: 12, t: 26, b: 26 };
  const nb = d3.max(D.hist, (d) => d.bin) + 1;
  const rowsB = d3.range(nb).map((b) => {
    const o = { bin: b }; for (const k of KINDS) o[k] = 0;
    for (const d of D.hist) if (d.bin === b) o[d.kind] = d.n;
    return o;
  });
  const x = d3.scaleLinear().domain([0, nb * M.bin]).range([m.l, w - m.r]);
  const st = d3.stack().keys(KINDS)(rowsB);
  const y = d3.scaleLinear().domain([0, d3.max(st[st.length - 1], (p) => p[1]) * 1.08]).range([h - m.b, m.t]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~s")).tickSize(-(w - m.l - m.r)).tickPadding(6))
    .call((s) => s.select(".domain").remove()).call((s) => s.selectAll("line").attr("stroke", "rgba(255,255,255,.05)"));
  svg.append("g").selectAll("g").data(st).join("g").attr("fill", (s) => KCOL[s.key])
    .selectAll("rect").data((s) => s).join("rect")
    .attr("x", (p) => x(p.data.bin * M.bin) + 0.5).attr("width", Math.max(1, x(M.bin) - x(0) - 1))
    .attr("y", (p) => y(p[1])).attr("height", (p) => Math.max(0, y(p[0]) - y(p[1])))
    .on("mousemove", (ev, p) => {
      const b = p.data, n = d3.sum(KINDS, (k) => b[k]);
      showTip(ev, `<b>${dur(10 ** (b.bin * M.bin))} – ${dur(10 ** ((b.bin + 1) * M.bin))}</b><br>${fmtN(n)} bad versions (${pct(n / M.n_bad, 1)})<br>` +
        KINDS.filter((k) => b[k]).map((k) => `<span style="color:${KCOL[k]}">■</span> ${KLABEL[k]} ${fmtN(b[k])}`).join("<br>"));
    })
    .on("mouseleave", hideTip);
  const ticks = TICKS.filter(([s]) => Math.log10(s) <= nb * M.bin && (w > 500 || ![1, 7 * 86400, 30.44 * 86400].includes(s)));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
    .call(d3.axisBottom(x).tickValues(ticks.map(([s]) => Math.log10(s))).tickFormat((v) => ticks.find(([s]) => Math.abs(Math.log10(s) - v) < 1e-9)[1]).tickSize(4).tickPadding(5));
  const mark = (s, text, row) => {
    const px = x(Math.log10(s));
    svg.append("line").attr("x1", px).attr("x2", px).attr("y1", m.t - 4 + row * 14).attr("y2", h - m.b).attr("stroke", INK).attr("stroke-opacity", 0.35).attr("stroke-dasharray", "2 3");
    svg.append("text").attr("class", "anno").attr("x", px + 5).attr("y", m.t + 6 + row * 14).text(text);
  };
  mark(60, `${pct(M.within_minute)} ≤ 1 min`, 0);
  mark(3600, `${pct(M.within_hour)} ≤ 1 h`, 1);
  mark(86400, `${pct(M.within_day)} ≤ 1 day`, 2);
  const L = D.longest[0];
  document.getElementById("hist-sub").innerHTML =
    `Log-binned lifetime of every undone version, coloured by who saved it. Most die in minutes; the tail is long.
     The longest-lived: a version of <a href="https://fi.wikipedia.org/?oldid=${L.rev_id}" target="_blank" rel="noopener">${esc(L.title)}</a>
     saved ${String(L.ts).slice(5, 16)} by ${KLABEL[L.kind].toLowerCase()}, undone after <b>${dur(L.lifetime_s)}</b>.`;
  legend(document.getElementById("hist-legend"), KINDS.map((k) => [KCOL[k], KLABEL[k]]));
}

/* ---------- 5. most vandalised articles ---------- */
const artsEl = document.getElementById("arts");
const maxBad = D.articles[0].n_bad;
artsEl.innerHTML = D.articles.map((a, i) => {
  const mx = d3.max(a.years);
  const pts = a.years.map((v, j) => `${(j / 23) * 110},${22 - (v / mx) * 20}`).join(" ");
  return `<div class="art" data-id="${a.page_id}" title="">
    <span class="rk">${i + 1}</span>
    <span class="t">${esc(a.title)}${a.has_text ? "" : ""}</span>
    <span class="bar" style="width:${(90 * a.n_bad) / maxBad}px"><span style="width:${(100 * a.bad_anon) / a.n_bad}%"></span></span>
    <span class="sp"><svg viewBox="0 0 110 24"><polyline points="0,22 ${pts} 110,22" fill="${RED}" fill-opacity=".18" stroke="${RED}" stroke-width="1.2"/></svg></span>
    <span class="n">${fmtN(a.n_bad)}</span></div>`;
}).join("");
artsEl.addEventListener("mousemove", (ev) => {
  const r = ev.target.closest(".art"); if (!r) return;
  const a = D.articles.find((x) => x.page_id === +r.dataset.id);
  showTip(ev, `<b>${esc(a.title)}</b><br>${fmtN(a.n_bad)} undone versions in ${fmtN(a.n_reverts)} reverts (of ${fmtN(a.versions)} versions)<br>
    ${pct(a.bad_anon / a.n_bad)} by IPs / temporary accounts · median lifetime ${dur(a.median_s)}<br>
    <span class="k">worst year ${a.peak_year} (${a.peak_n})${a.has_text ? " · full text in MariaDB: click to see what readers saw" : ""}</span>`);
});
artsEl.addEventListener("mouseleave", hideTip);
artsEl.addEventListener("click", (ev) => { const r = ev.target.closest(".art"); if (r) openArticle(+r.dataset.id, true); });

/* ---------- article detail + FOR SYSTEM_TIME diff ---------- */
let detail = null;
async function openArticle(pid, scroll) {
  for (const r of artsEl.children) r.classList.toggle("on", +r.dataset.id === pid);
  const sec = document.getElementById("detail");
  sec.hidden = false;
  document.getElementById("d-title").textContent = D.articles.find((a) => a.page_id === pid)?.title || "";
  document.getElementById("d-sub").textContent = "Loading…";
  document.getElementById("d-chart").innerHTML = "";
  document.getElementById("d-version").innerHTML = "";
  if (scroll) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  detail = await fetch(`/api/immune/article/${pid}`).then((r) => r.json());
  detail.bad.forEach((b) => (b.t = new Date(b.ts)));
  drawDetail();
  // default: the longest-lived version by a logged-out editor (the typical vandal), else the longest-lived one
  const pool = detail.bad.filter((b) => b.kind === "anon" || b.kind === "temp");
  const pick = detail.has_text ? (pool.length ? pool : detail.bad).reduce((a, b) => (b.lifetime_s > a.lifetime_s ? b : a)) : null;
  if (pick) openVersion(pick.rev_id);
  else document.getElementById("d-version").innerHTML = `<p class="mute small">The full text of this article's history is not loaded into the <code>article</code> table (only small articles and 50 famous ones are), so the bad versions cannot be shown here. Each dot links to Wikipedia.</p>`;
}
function drawDetail() {
  if (!detail) return;
  const el = document.getElementById("d-chart");
  const { svg, w, h } = svgIn(el, 230);
  const m = { l: 56, r: 12, t: 12, b: 26 };
  const x = d3.scaleUtc().domain([new Date(Date.UTC(2004, 0, 1)), lastDay]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, 9]).range([h - m.b, m.t]);
  for (const [s, l] of TICKS.filter(([s]) => [60, 3600, 86400, 30.44 * 86400, 365.25 * 86400].includes(s))) {
    svg.append("line").attr("class", "grid-line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(Math.log10(s))).attr("y2", y(Math.log10(s)));
    svg.append("text").attr("x", m.l - 8).attr("y", y(Math.log10(s)) + 4).attr("text-anchor", "end").attr("fill", MUTE).style("font-size", "11px").text(l);
  }
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - m.b})`)
    .call(d3.axisBottom(x).ticks(w < 500 ? 5 : 12).tickSize(0).tickPadding(7)).call((s) => s.select(".domain").remove());
  svg.append("g").selectAll("circle").data(detail.bad).join("circle").attr("class", "dot")
    .attr("cx", (d) => x(d.t)).attr("cy", (d) => y(Math.log10(Math.max(1, d.lifetime_s)))).attr("r", 3.2)
    .attr("fill", (d) => KCOL[d.kind]).attr("fill-opacity", 0.75)
    .on("mousemove", (ev, d) => showTip(ev, `<b>${d.t.toISOString().slice(0, 16).replace("T", " ")}</b> UTC · ${KLABEL[d.kind]} <span class="k">${esc(d.user)}</span><br>
      ${d.delta > 0 ? "+" : ""}${fmtN(d.delta)} bytes${d.comment ? ` · “${esc(d.comment)}”` : ""}<br>
      undone after <b>${dur(d.lifetime_s)}</b> by ${esc(d.reverter)}<br><span class="k">${detail.has_text ? "click: what readers saw (FOR SYSTEM_TIME AS OF)" : "click: open on Wikipedia"}</span>`))
    .on("mouseleave", hideTip)
    .on("click", (ev, d) => detail.has_text ? openVersion(d.rev_id) : window.open(`https://fi.wikipedia.org/?oldid=${d.rev_id}`, "_blank", "noopener"));
  const kinds = d3.rollup(detail.bad, (v) => v.length, (d) => d.kind);
  const med = d3.median(detail.bad, (d) => d.lifetime_s);
  document.getElementById("d-sub").innerHTML = `Every undone version of this article: when it was saved (x) and how long it stayed live (y).
    ${fmtN(detail.bad.length)} versions, median lifetime <b>${dur(med)}</b>. ` +
    KINDS.filter((k) => kinds.get(k)).map((k) => `<span style="color:${KCOL[k]}">■</span> ${KLABEL[k]} ${fmtN(kinds.get(k))}`).join(" · ") +
    ` · <a href="https://fi.wikipedia.org/?curid=${detail.page_id}" target="_blank" rel="noopener">article ↗</a>`;
}
async function openVersion(rev) {
  const el = document.getElementById("d-version");
  el.innerHTML = `<p class="loading">Reading two versions with FOR SYSTEM_TIME AS OF…</p>`;
  const v = await fetch(`/api/immune/version/${rev}`).then((r) => r.json());
  if (!v.available) { el.innerHTML = `<p class="mute small">This version's text is not in the <code>article</code> table yet (bulk load still running). <a href="https://fi.wikipedia.org/?oldid=${rev}" target="_blank" rel="noopener">Open on Wikipedia ↗</a></p>`; return; }
  const ts = new Date(v.ts).toISOString().slice(0, 16).replace("T", " ");
  const hunks = v.hunks.length ? v.hunks.map((hk) => `<div class="hunk"><span class="ctx">…${esc(hk.ctx_before)}</span>
      ${hk.removed ? `<del>${esc(hk.removed)}</del>` : ""} ${hk.added ? `<ins>${esc(hk.added)}</ins>` : ""}
      <span class="ctx">${esc(hk.ctx_after)}…</span></div>`).join("")
    : `<div class="hunk ctx">The readable text did not change (the edit touched only markup, templates or references).</div>`;
  el.innerHTML = `<div class="vhead"><span>What readers saw from <b>${ts} UTC</b> for <b>${dur(v.lifetime_s)}</b></span>
      <span>${KLABEL[v.kind]} <span class="mono">${esc(v.user)}</span></span>
      <span>${fmtN(v.words_before)} → ${fmtN(v.words_bad)} words${v.blanked ? " · <b style='color:#ff8a98'>page blanked</b>" : ""}</span>
      <a href="https://fi.wikipedia.org/?oldid=${v.rev_id}" target="_blank" rel="noopener">this version ↗</a></div>
    ${hunks}
    <details><summary>The SQL: both versions straight from the system-versioned table</summary><pre class="sql">${esc(v.sql)}</pre></details>`;
}
document.getElementById("d-close").addEventListener("click", () => { document.getElementById("detail").hidden = true; for (const r of artsEl.children) r.classList.remove("on"); });

/* ---------- SQL + method ---------- */
document.getElementById("sql-build").textContent = D.sql;
document.getElementById("method").textContent =
  `A revert is a version whose text (sha1) equals an earlier version but not the previous one. ${fmtN(M.n_self_skipped)} self-reverted versions are left out, ` +
  `as are reverts undoing more than ${M.max_span} versions. Lifetime = revert time − bad version's save time. Versions never reverted are not counted, so the most recent years are biased towards fast reverts.`;

function drawAll() { drawViolin(); drawWho(); drawHours(); drawHist(); drawDetail(); }
drawAll();
let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(drawAll, 150); });
const params = new URLSearchParams(location.search);
const first = +params.get("page") || D.articles.find((a) => a.has_text)?.page_id;
if (first) openArticle(first, false);
