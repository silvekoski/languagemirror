// Three Wikipedias: coverage (UpSet), cross-language semantic distance (scatter), one topic side by side.
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = d3.format(","), pct = v => `${Math.round(v * 100)}%`, f3 = d3.format(".3f"), f2 = d3.format(".2f");
const LANGS = ["fi", "sv", "en"], NAME = { fi: "Finnish", sv: "Swedish", en: "English" };
const CSS = getComputedStyle(document.documentElement), C = k => CSS.getPropertyValue(k).trim();
const COL = { fi: C("--fi"), sv: C("--sv"), en: C("--en"), hl: C("--hl") || "#ffb46b", dot: "#6f7fa3",
              bot: C("--bot"), accent: C("--accent"), revert: C("--revert"), mute: C("--mute"), faint: C("--faint") };
const lg = l => `<i class="lg ${l}">${l}</i>`;
const STUB = 500;

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
let O, P;
try {
  [O, P] = await Promise.all([getJSON("/api/polyglot/overview"), getJSON("/api/polyglot/points")]);
} catch (e) {
  $("#lede").textContent = `Could not load the data (${e.message}). Is MariaDB running?`;
  throw e;
}
const N = P.n, IDX = d3.range(N);
const byPage = new Map(P.fi_page.map((p, i) => [p, i]));
const byLangPage = new Map();
for (const l of LANGS) P[`${l}_page`].forEach((p, i) => p != null && byLangPage.set(`${l}:${p}`, i));

// ---------- state (mirrored in the URL) ----------
const Q = new URLSearchParams(location.search);
const S = {
  pair: ["fi_en", "fi_sv", "sv_en"].includes(Q.get("pair")) ? Q.get("pair") : "fi_en",
  x: Q.get("x") || "len", y: Q.get("y") || "d", c: Q.get("c") || "theme",
  stubs: Q.get("stubs") !== "0", scope: Q.get("scope") || "all", combo: Q.get("combo") || null,
  cov: Q.get("cov") || "theme", theme: null, sel: null, hover: null,
};
const ab = () => S.pair.split("_");
const dcol = () => P[`d_${S.pair}`], rcol = () => P[`r_${S.pair}`];

// the theme whose fi↔en distances exceed what length mismatch explains the most (>= 50 topics): the default highlight
const themeStats = P.themes.map((t, k) => {
  const ids = IDX.filter(i => P.theme[i] === k && P.d_fi_en[i] != null);
  return { k, name: t, n: ids.length, d: d3.mean(ids, i => P.d_fi_en[i]), r: d3.mean(ids, i => P.r_fi_en[i]) };
});
const defaultTheme = themeStats.filter(t => t.n >= 50 && !/Other|Uncategorised/.test(t.name)).sort((a, b) => b.r - a.r)[0];
S.theme = Q.has("theme") ? P.themes.indexOf(Q.get("theme")) : defaultTheme.k;
if (S.theme < 0) S.theme = null;
const meanFiEn = d3.mean(IDX, i => P.d_fi_en[i]);

function syncUrl() {
  const q = new URLSearchParams();
  if (S.pair !== "fi_en") q.set("pair", S.pair);
  if (S.x !== "len") q.set("x", S.x);
  if (S.y !== "d") q.set("y", S.y);
  if (S.c !== "theme") q.set("c", S.c);
  if (!S.stubs) q.set("stubs", "0");
  if (S.scope !== "all") q.set("scope", S.scope);
  if (S.combo) q.set("combo", S.combo);
  if (S.cov !== "theme") q.set("cov", S.cov);
  if (S.theme == null) q.set("theme", "none");
  else if (S.theme !== defaultTheme.k) q.set("theme", P.themes[S.theme]);
  if (S.sel != null) q.set("topic", P.fi_page[S.sel]);
  history.replaceState(null, "", "?" + q.toString());
}

// ---------- hero ----------
const combos = Object.fromEntries(O.combos.map(c => [`${+c.sv}${+c.en}`, +c.topics]));
const total = d3.sum(O.combos, c => +c.topics);
const onlyFi = combos["00"], all3 = combos["11"];
const rk = O.pairs.fi_en.rank;
const ts = themeStats[defaultTheme.k];
$("#kpis").innerHTML = `
  <div class="kpi fi"><b>${pct(onlyFi / total)}</b><span>of ${fmt(total)} topics are told only in Finnish</span></div>
  <div class="kpi all"><b>${pct(all3 / total)}</b><span>exist in all three languages (${fmt(all3)})</span></div>
  <div class="kpi hit"><b>${pct(rk.top1 / rk.n)}</b><span>of Finnish articles are nearest in meaning to their own English article, #1 of ${fmt(rk.pool)}</span></div>
  <div class="kpi hl"><b>${f2(ts.d)} <small style="font-size:15px;color:var(--mute)">vs ${f2(meanFiEn)}</small></b><span>mean fi↔en distance: ${esc(ts.name.toLowerCase())} vs all</span></div>`;

function lede(i) {
  const [a, b] = ["fi", "en"];
  let ex = "";
  if (i != null && P.en_title[i]) ex = ` — <span class="q">${esc(P.fi_title[i])}</span> in Finnish is <span class="q">${esc(P.en_title[i])}</span> in English`;
  $("#lede").innerHTML = `Every one of these ${fmt(total)} topics comes from Finnish Wikipedia's history of Finland;
    only <b>${pct(1 - onlyFi / total)}</b> are also told in Swedish or English. Where they are, MariaDB measures how far apart
    the versions are in meaning. Most say the same thing, but <b>${esc(ts.name.toLowerCase())}</b> drift apart${ex}.`;
}

// ---------- coverage: UpSet ----------
function drawUpset() {
  const svg = d3.select("#upset"), W = $("#upset").clientWidth, H = 196;
  svg.attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();
  const cols = [
    { key: "00", sets: ["fi"] }, { key: "11", sets: ["fi", "sv", "en"] },
    { key: "01", sets: ["fi", "en"] }, { key: "10", sets: ["fi", "sv"] },
  ].map(c => ({ ...c, n: combos[c.key] || 0 })).sort((a, b) => b.n - a.n);
  const x0 = 92, cw = (W - x0) / cols.length, top = 22, barH = 96, rowY = { fi: 142, sv: 162, en: 182 };
  const y = d3.scaleLinear([0, d3.max(cols, c => c.n)], [0, barH]);
  for (const l of LANGS) {
    const g = svg.append("g");
    g.append("text").attr("x", 0).attr("y", rowY[l] + 4).attr("fill", COL[l]).attr("font-size", 11.5).attr("font-weight", 600).text(NAME[l]);
    g.append("text").attr("x", x0 - 10).attr("y", rowY[l] + 4).attr("text-anchor", "end").attr("fill", COL.mute)
      .attr("font-size", 10.5).attr("font-family", "JetBrains Mono, monospace").text(fmt(O.sets[l]));
    svg.append("rect").attr("x", x0 - 4).attr("y", rowY[l] - 9).attr("width", W - x0 + 4).attr("height", 18)
      .attr("fill", l === "sv" ? "rgba(255,255,255,.025)" : "none");
  }
  cols.forEach((c, k) => {
    const cx = x0 + cw * k + cw / 2, on = S.combo === c.key, clickable = c.key !== "00";
    const g = svg.append("g").style("cursor", clickable ? "pointer" : "default")
      .on("click", () => { if (!clickable) return; S.combo = on ? null : c.key; render(); })
      .on("pointermove", ev => showTip(ev, `<div class="tt">${c.sets.map(lg).join(" ")} ${c.sets.length === 1 ? "only" : ""}</div>
         <div class="ts">${fmt(c.n)} topics, ${pct(c.n / total)}${c.key === "00" ? `, incl. ${fmt(O.no_wikidata)} Finnish articles with no Wikidata id` : ""}</div>
         <div class="ts">${clickable ? (on ? "click to show all topics" : "click to show only these in the scatter") : "nothing to compare: one language"}</div>`))
      .on("pointerleave", hideTip);
    g.append("rect").attr("x", cx - cw / 2).attr("y", 0).attr("width", cw).attr("height", H).attr("fill", "transparent");
    const h = y(c.n);
    g.append("rect").attr("x", cx - cw * 0.3).attr("y", top + barH - h).attr("width", cw * 0.6).attr("height", h).attr("rx", 3)
      .attr("fill", on ? COL.hl : c.key === "00" ? "#3a4258" : "#9aa6c2").attr("opacity", S.combo && !on ? 0.4 : 0.9);
    g.append("text").attr("x", cx).attr("y", top + barH - h - 6).attr("text-anchor", "middle").attr("fill", C("--ink"))
      .attr("font-size", 12).attr("font-weight", 600).text(fmt(c.n));
    g.append("text").attr("x", cx).attr("y", top + barH + 14).attr("text-anchor", "middle").attr("fill", COL.mute)
      .attr("font-size", 10.5).text(pct(c.n / total));
    const ys = c.sets.map(l => rowY[l]);
    if (ys.length > 1) g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", d3.min(ys)).attr("y2", d3.max(ys)).attr("stroke", "#c3c9d6").attr("stroke-width", 2);
    for (const l of LANGS) {
      const m = c.sets.includes(l);
      g.append("circle").attr("cx", cx).attr("cy", rowY[l]).attr("r", m ? 5.5 : 4)
        .attr("fill", m ? COL[l] : "rgba(255,255,255,.07)").attr("stroke", m ? "#07080d" : "none").attr("stroke-width", 2);
    }
  });
  $("#covNote").textContent = `${fmt(total)} topics`;
}

// ---------- coverage by theme / edits / year ----------
function drawCovList() {
  document.querySelectorAll("#covBy button").forEach(b => b.classList.toggle("on", b.dataset.v === S.cov));
  let data;
  if (S.cov === "theme") data = O.themes.map(t => ({ ...t, label: t.theme, key: P.themes.indexOf(t.theme), sub: t.theme_fi }))
    .filter(t => t.label !== "Uncategorised").sort((a, b) => (b.en + b.sv) / b.n - (a.en + a.sv) / a.n);
  else if (S.cov === "activity") data = O.activity.map(t => ({ ...t, label: `${t.label} edits` }));
  else data = O.years.map(t => ({ ...t, label: `first written ${t.label}` }));
  const html = data.map(t => {
    const n = +t.n, sv = +t.sv / n, en = +t.en / n, on = S.cov === "theme" && t.key === S.theme;
    return `<div class="crow ${S.cov === "theme" ? "click" : ""} ${on ? "on" : ""}" data-k="${t.key ?? ""}"
        title="${esc(t.sub || t.label)}: ${fmt(n)} Finnish topics · ${fmt(+t.sv)} in Swedish (${pct(sv)}) · ${fmt(+t.en)} in English (${pct(en)}) · ${fmt(+t.both3)} in all three">
      <div class="nm">${esc(t.label)}<small>${fmt(n)}</small></div>
      <div class="bars">
        <div style="display:grid;grid-template-columns:1fr 30px;gap:4px;align-items:center"><div class="bar sv"><i style="width:${sv * 100}%"></i></div><span class="mono" style="font-size:11px;color:var(--mute)">${pct(sv)}</span></div>
        <div style="display:grid;grid-template-columns:1fr 30px;gap:4px;align-items:center"><div class="bar en"><i style="width:${en * 100}%"></i></div><span class="mono" style="font-size:11px;color:var(--mute)">${pct(en)}</span></div>
      </div></div>`;
  }).join("");
  $("#covList").innerHTML = html;
  // one computed sentence: where each language covers Finnish history best and worst (groups of >= 100 topics)
  const big = data.filter(t => +t.n >= 100 && t.label !== "Other");
  const ins = ["sv", "en"].map(l => {
    const r = big.map(t => [t, +t[l] / +t.n]).sort((p, q) => q[1] - p[1]);
    if (r.length < 2) return "";
    const [hi, lo] = [r[0], r[r.length - 1]], nm = t => esc(S.cov === "theme" ? t.label : t.label.replace("first written ", "written in "));
    return `<div>${lg(l)} covers <b>${pct(hi[1])}</b> of ${nm(hi[0])} but <b>${pct(lo[1])}</b> of ${nm(lo[0])}</div>`;
  }).join("");
  $("#covInsight").innerHTML = ins;
  if (S.cov === "theme") $("#covList").querySelectorAll(".crow").forEach(el => el.onclick = () => {
    const k = +el.dataset.k;
    S.theme = S.theme === k && S.c === "theme" ? null : k; S.c = "theme"; render();
  });
}
document.querySelectorAll("#covBy button").forEach(b => b.onclick = () => { S.cov = b.dataset.v; drawCovList(); syncUrl(); });

// ---------- scatter ----------
const cv = $("#cv"), ctx = cv.getContext("2d"), ov = d3.select("#ov"), plotEl = $("#plot");
const M = { l: 46, r: 58, t: 12, b: 34 };
let W = 0, H = 0, xs, ys, refBoxes = [], vis = [], px = new Float32Array(N), py = new Float32Array(N), delaunay = null;
const jitter = i => ((Math.imul(P.fi_page[i], 2654435761) >>> 0) / 4294967296 - 0.5) * 0.8;

function xVal(i) {
  const [a, b] = ab();
  if (S.x === "len") return Math.log2(P[`${b}_len`][i] / P[`${a}_len`][i]);
  if (S.x === "edits") return P.versions[i] || 1;
  if (S.x === "year") return P.first_year[i] == null ? null : P.first_year[i] + 0.5 + jitter(i);
  if (S.x === "rank") return P[`rank_${b}`][i];
}
const yVal = i => (S.y === "d" ? dcol() : rcol())[i];

function filterVis() {
  const [a, b] = ab(), d = dcol();
  vis = IDX.filter(i => {
    if (d[i] == null) return false;
    if (S.stubs && Math.min(P[`${a}_len`][i], P[`${b}_len`][i]) < STUB) return false;
    if (S.combo) {
      const k = `${+(P.sv_page[i] != null)}${+(P.en_page[i] != null)}`;
      if (k !== S.combo) return false;
    }
    return xVal(i) != null && yVal(i) != null;
  });
}

function colorOf(i) {
  const [a, b] = ab();
  if (S.c === "theme") return P.theme[i] === S.theme ? COL.hl : COL.dot;
  if (S.c === "third") { const t = LANGS.find(l => l !== a && l !== b); return P[`${t}_page`][i] != null ? COL[t] : COL.dot; }
  if (S.c === "rank") { const r = P[`rank_${b}`][i]; return r === 1 ? COL.bot : r <= 10 ? COL.accent : COL.revert; }
  if (S.c === "edits") return edScale(Math.log10(P.versions[i] || 1));
}
const edScale = d3.scaleSequential([0, 3.3], d3.interpolateRgb("#27304a", "#bfe3ff"));
const isFront = i => S.c === "theme" ? P.theme[i] === S.theme : S.c === "rank" ? P[`rank_${ab()[1]}`][i] > 1 :
  S.c === "third" ? P[`${LANGS.find(l => !ab().includes(l))}_page`][i] != null : false;

function layout() {
  const r = plotEl.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ov.attr("viewBox", `0 0 ${W} ${H}`);
}

function scales() {
  const iw = W - M.l - M.r, ih = H - M.t - M.b, X = vis.map(xVal), Y = vis.map(yVal);
  if (S.x === "len") { const m = Math.min(7, Math.max(3, Math.ceil(d3.quantile(X.map(Math.abs), 0.99) ?? 3))); xs = d3.scaleLinear([-m, m], [M.l, M.l + iw]).clamp(true); }
  else if (S.x === "edits") xs = d3.scaleLog([1, (d3.max(X) || 10) * 1.1], [M.l, M.l + iw]);
  else if (S.x === "year") xs = d3.scaleLinear([2003, 2027], [M.l, M.l + iw]);
  else xs = d3.scaleLog([0.8, (d3.max(X) || 10) * 1.3], [M.l, M.l + iw]);   // rank 1 sits off the axis line
  if (S.y === "d") ys = d3.scaleLinear([0, Math.max(0.7, (d3.max(Y) ?? 0.6) + 0.02)], [M.t + ih, M.t]);
  else { const e = Y.length ? d3.extent(Y) : [0, 0]; ys = d3.scaleLinear([Math.min(-0.2, e[0] - 0.02), Math.max(0.2, e[1] + 0.02)], [M.t + ih, M.t]); }
}

function drawPoints() {
  ctx.clearRect(0, 0, W, H);
  const front = [], back = [];
  for (const i of vis) { px[i] = xs(xVal(i)); py[i] = ys(yVal(i)); (isFront(i) ? front : back).push(i); }
  const dim = S.c === "theme" && S.theme != null;
  const dot = (list, r, a) => { for (const i of list) { ctx.globalAlpha = a; ctx.fillStyle = colorOf(i); ctx.beginPath(); ctx.arc(px[i], py[i], r, 0, 7); ctx.fill(); } };
  dot(back, 2.3, dim ? 0.38 : S.c === "edits" ? 0.75 : 0.5);
  dot(front, 2.8, 0.92);
  ctx.globalAlpha = 1;
  delaunay = d3.Delaunay.from(vis, i => px[i], i => py[i]);
}

function axisLabelX() {
  const [a, b] = ab();
  return { len: `${NAME[b]} article length ÷ ${NAME[a]} (log scale) →`, edits: "edits to the Finnish article, 2003–2026 (log) →",
    year: "year the Finnish article was first written →", rank: `rank of the ${NAME[b]} counterpart among all ${NAME[b]} articles, nearest to the ${NAME[a]} vector (log) →` }[S.x];
}

function drawAxes() {
  ov.selectAll("*").remove();
  refBoxes = [];
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  // grid
  ov.append("g").attr("class", "grid-l").attr("transform", `translate(${M.l},0)`)
    .call(d3.axisLeft(ys).ticks(6).tickSize(-iw).tickFormat("")).call(g => g.select(".domain").remove());
  const xa = d3.axisBottom(xs);
  if (S.x === "len") xa.tickValues(d3.range(xs.domain()[0], xs.domain()[1] + 1).filter(v => v % (iw < 420 ? 2 : 1) === 0))
    .tickFormat(v => v === 0 ? "same" : v > 0 ? `${2 ** v}×` : `1/${2 ** -v}`);
  else if (S.x === "year") xa.ticks(iw < 420 ? 5 : 10, "d");
  else xa.ticks(iw < 420 ? 3 : 6, "~s");
  ov.append("g").attr("class", "axis").attr("transform", `translate(0,${M.t + ih})`).call(xa);
  ov.append("g").attr("class", "axis").attr("transform", `translate(${M.l},0)`).call(d3.axisLeft(ys).ticks(6).tickFormat(S.y === "d" ? d3.format(".1f") : d3.format("+.1f")));
  ov.append("text").attr("class", "axlab").attr("x", M.l + iw).attr("y", H - 4).attr("text-anchor", "end").text(axisLabelX());
  ov.append("text").attr("class", "axlab").attr("transform", `translate(12,${M.t}) rotate(-90)`).attr("text-anchor", "end")
    .text(S.y === "d" ? "← closer in meaning · cosine distance · further apart →" : "← more alike than length predicts · residual · less alike →");
  const [a, b] = ab(), pr = O.pairs[S.pair];
  const ref = (v, label, col, anchorRight) => {
    if (v < ys.domain()[0] || v > ys.domain()[1]) return;
    ov.append("line").attr("class", "ref").attr("x1", M.l).attr("x2", M.l + iw).attr("y1", ys(v)).attr("y2", ys(v)).attr("stroke", col);
    const lx = anchorRight ? M.l + iw - 4 : M.l + 6, lw = label.length * 5.7;
    ov.append("text").attr("class", "reflab").attr("x", lx).attr("y", ys(v) - 5)
      .attr("text-anchor", anchorRight ? "end" : "start").attr("fill", col).text(label);
    refBoxes.push([anchorRight ? lx - lw : lx, ys(v) - 16, lw, 13]);     // annotations keep clear of it
  };
  if (S.y === "d") {
    ref(pr.median, `median of matched ${a}↔${b} topics ${f2(pr.median)}`, "#9aa6c2", false);
    if (pr.baseline) ref(pr.baseline, `two unrelated ${a}↔${b} articles, on average ${f2(pr.baseline)}`, COL.revert, false);
  } else ref(0, "as far apart as the length gap predicts", "#9aa6c2", false);
  if (S.c === "theme" && S.theme != null) {
    const tv = vis.filter(i => P.theme[i] === S.theme).map(yVal);
    if (tv.length >= 5) ref(d3.median(tv), `median of ${P.themes[S.theme].toLowerCase()} ${S.y === "d" ? f2(d3.median(tv)) : d3.format("+.2f")(d3.median(tv))}`, COL.hl, true);
  }
  if (S.x === "len") ov.append("line").attr("class", "ref").attr("x1", xs(0)).attr("x2", xs(0)).attr("y1", M.t).attr("y2", M.t + ih).attr("stroke", "rgba(255,255,255,.18)");

  // marginal histogram of y, all vs highlighted
  const hx = M.l + iw + 10, hw = M.r - 14, bins = d3.bin().domain(ys.domain()).thresholds(ys.ticks(32));
  const all = bins(vis.map(yVal)), hi = bins(vis.filter(isFront).map(yVal)), mx = d3.max(all, d => d.length) || 1;
  const hs = d3.scaleLinear([0, mx], [0, hw]), g = ov.append("g");
  for (const d of all) g.append("rect").attr("x", hx).attr("y", ys(d.x1)).attr("height", Math.max(0, ys(d.x0) - ys(d.x1) - 1)).attr("width", hs(d.length)).attr("fill", "rgba(154,166,194,.35)");
  if (S.c !== "edits") {
    const hm = d3.max(hi, d => d.length) || 1, hs2 = d3.scaleLinear([0, hm], [0, hw]);
    for (const d of hi) if (d.length) g.append("rect").attr("x", hx).attr("y", ys(d.x1) + 0.5).attr("height", Math.max(0, ys(d.x0) - ys(d.x1) - 2)).attr("width", hs2(d.length)).attr("fill", frontColor()).attr("opacity", .55);
  }
}
const frontColor = () => S.c === "theme" ? COL.hl : S.c === "third" ? COL[LANGS.find(l => !ab().includes(l))] : S.c === "rank" ? COL.revert : COL.accent;

function label(i) {
  const [a, b] = ab(), ta = P[`${a}_title`][i], tb = P[`${b}_title`][i];
  const cut = s => s.length > 30 ? s.slice(0, 29) + "…" : s;
  return ta.toLowerCase() === tb.toLowerCase() ? [cut(ta)] : [cut(ta), cut(tb)];
}

function drawAnnotations() {
  const g = ov.append("g").attr("class", "ann"), boxes = refBoxes.slice();
  const iw = W - M.l - M.r, small = W < 520;
  const sorted = vis.slice().sort((p, q) => yVal(q) - yVal(p));
  const picks = new Set(sorted.slice(0, small ? 3 : 4));
  if (S.c === "theme" && S.theme != null)            // the highlighted theme's own extremes
    sorted.filter(i => P.theme[i] === S.theme).slice(0, small ? 1 : 2).forEach(i => picks.add(i));
  sorted.slice(-2).forEach(i => picks.add(i));
  if (S.sel != null && vis.includes(S.sel)) picks.add(S.sel);
  const pts = [...picks].map(i => [px[i], py[i]]);
  const hits = (bx, by, w, h) => boxes.some(r => bx < r[0] + r[2] + 4 && bx + w + 4 > r[0] && by < r[1] + r[3] + 2 && by + h + 2 > r[1])
    || pts.some(([x, y]) => x > bx - 6 && x < bx + w + 6 && y > by - 6 && y < by + h + 6);
  // place the selected topic's label first so it always gets a spot
  const order = [...picks].sort((p, q) => (q === S.sel) - (p === S.sel) || yVal(q) - yVal(p));
  for (const i of order) {
    const [l1, l2] = label(i), x = px[i], y = py[i];
    const txt = l2 ? `${l1} → ${l2}` : l1, w = txt.length * 6.0 + 4, h = 15;
    const prefLeft = x > M.l + iw * 0.55;
    let placed = null;
    search: for (const side of prefLeft ? [-1, 1] : [1, -1])
      for (const dx of [12, 34, 64])
        for (const dy of [-8, -24, 10, -40, 26, -56, 42, -72, 58]) {
          const bx = side < 0 ? x - dx - w : x + dx, by = y + dy - h / 2;
          if (bx < M.l + 2 || bx + w > M.l + iw || by < M.t || by + h > H - M.b - 4) continue;
          if (hits(bx, by, w, h)) continue;
          placed = [bx, by, w, h, side]; break search;
        }
    if (!placed) continue;
    boxes.push(placed);
    const [bx, by, , , side] = placed, sel = i === S.sel;
    const a = g.append("g").on("click", ev => { ev.stopPropagation(); select(i, true); }).on("pointerenter", () => { S.hover = i; drawHover(); }).on("pointerleave", () => { S.hover = null; drawHover(); });
    a.append("circle").attr("cx", x).attr("cy", y).attr("r", 4.5);
    const ax = side < 0 ? bx + w : bx, ay = by + h / 2;
    a.append("line").attr("x1", x + (side < 0 ? -4 : 4)).attr("y1", y).attr("x2", ax + (side < 0 ? 2 : -2)).attr("y2", ay);
    const t = a.append("text").attr("x", ax).attr("y", ay + 4).attr("text-anchor", side < 0 ? "end" : "start")
      .attr("font-weight", sel ? 600 : null);
    t.append("tspan").text(l1);
    if (l2) { t.append("tspan").attr("class", "arrow").text(" → "); t.append("tspan").attr("fill", "#c3c9d6").text(l2); }
  }
  ov.append("g").attr("id", "hov");
}

function drawHover() {
  const g = ov.select("#hov"); g.selectAll("*").remove();
  if (S.sel != null && vis.includes(S.sel)) g.append("circle").attr("class", "selring").attr("cx", px[S.sel]).attr("cy", py[S.sel]).attr("r", 7);
  if (S.hover != null && vis.includes(S.hover)) g.append("circle").attr("class", "hovring").attr("cx", px[S.hover]).attr("cy", py[S.hover]).attr("r", 6);
  document.querySelectorAll(".tl li").forEach(li => li.classList.toggle("on", +li.dataset.i === S.sel));
}

function tipHtml(i) {
  const [a, b] = ab(), t = LANGS.find(l => l !== a && l !== b);
  const rows = [
    ["distance", `${f3(dcol()[i])}  (${pctRank(i)})`],
    ["beyond length gap", d3.format("+.3f")(rcol()[i])],
    ["length", `${fmt(P[`${a}_len`][i])} ${a} · ${fmt(P[`${b}_len`][i])} ${b} chars`],
    ["theme", P.themes[P.theme[i]]],
    ["Finnish edits", `${fmt(P.versions[i] || 0)} since ${P.first_year[i] ?? "?"}`],
  ];
  if (a === "fi") rows.push(["vector search", `${NAME[b]} twin is #${P[`rank_${b}`][i]} nearest`]);
  rows.push([`in ${NAME[t]}`, P[`${t}_title`][i] ? esc(P[`${t}_title`][i]) : "—"]);
  return `<div class="tt">${lg(a)} ${esc(P[`${a}_title`][i])}</div><div class="tt">${lg(b)} ${esc(P[`${b}_title`][i])}</div>
    <div class="tg">${rows.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join("")}</div>`;
}
let sortedD = {};
function pctRank(i) {
  const d = dcol(), arr = sortedD[S.pair] ??= IDX.map(j => d[j]).filter(v => v != null).sort(d3.ascending);
  const r = d3.bisectLeft(arr, d[i]) / arr.length;
  const k = Math.floor((r >= 0.5 ? r : 1 - r) * 100);
  return r >= 0.5 ? `further apart than ${k}% of ${S.pair.replace("_", "↔")} topics` : `closer than ${k}% of topics`;
}

const tip = $("#tip");
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 16, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 16;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 12;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function hideTip() { tip.hidden = true; }

plotEl.addEventListener("pointermove", ev => {
  if (!delaunay) return;
  const r = plotEl.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const k = delaunay.find(mx, my), i = vis[k];
  if (i == null || Math.hypot(px[i] - mx, py[i] - my) > 14) { if (S.hover != null) { S.hover = null; drawHover(); } hideTip(); plotEl.style.cursor = ""; return; }
  plotEl.style.cursor = "pointer";
  if (S.hover !== i) { S.hover = i; drawHover(); }
  showTip(ev, tipHtml(i));
});
plotEl.addEventListener("pointerleave", () => { S.hover = null; drawHover(); hideTip(); });
plotEl.addEventListener("click", () => { if (S.hover != null) select(S.hover, true); });

function drawLegend() {
  const [a, b] = ab(), t = LANGS.find(l => l !== a && l !== b);
  let h = "";
  if (S.c === "theme") {
    const opts = P.themes.map((n, k) => [n, k]).filter(([n]) => n !== "Uncategorised").sort((p, q) => p[0].localeCompare(q[0]))
      .map(([n, k]) => `<option value="${k}" ${k === S.theme ? "selected" : ""}>${esc(n)}</option>`).join("");
    const n = vis.filter(i => P.theme[i] === S.theme).length;
    h = `<span><i class="sw" style="background:${COL.hl}"></i><select id="themeSel" style="font-size:12px;padding:2px 6px"><option value="">no highlight</option>${opts}</select> ${S.theme != null ? `${fmt(n)} shown` : ""}</span>
      <span><i class="sw" style="background:${COL.dot}"></i>other themes</span><span class="mute">· or click a theme on the left</span>`;
  } else if (S.c === "third") h = `<span><i class="sw" style="background:${COL[t]}"></i>also has a ${NAME[t]} article</span><span><i class="sw" style="background:${COL.dot}"></i>no ${NAME[t]} article</span>`;
  else if (S.c === "rank") h = `<span><i class="sw" style="background:${COL.bot}"></i>${NAME[b]} twin is the #1 nearest ${NAME[b]} article</span><span><i class="sw" style="background:${COL.accent}"></i>#2–10</span><span><i class="sw" style="background:${COL.revert}"></i>below #10</span>`;
  else h = `<span>Finnish edits 1<i class="ramp" style="background:linear-gradient(90deg,#27304a,#bfe3ff)"></i>2,000+</span>`;
  h += `<span class="mute" style="margin-left:auto">${fmt(vis.length)} topics${S.combo ? ` · only ${S.combo === "11" ? "fi+sv+en" : S.combo === "01" ? "fi+en (no sv)" : "fi+sv (no en)"} <a href="#" id="clrCombo">×</a>` : ""}</span>`;
  $("#legend").innerHTML = h;
  $("#themeSel")?.addEventListener("change", e => { S.theme = e.target.value === "" ? null : +e.target.value; render(); });
  $("#clrCombo")?.addEventListener("click", e => { e.preventDefault(); S.combo = null; render(); });
}

function drawLists() {
  const pool = S.scope === "theme" && S.theme != null ? vis.filter(i => P.theme[i] === S.theme) : vis;
  const s = pool.slice().sort((p, q) => yVal(q) - yVal(p));
  const rowsFit = Math.max(3, Math.min(8, Math.floor(($(".lists").clientHeight - 140) / 2 / 46)));
  const [a, b] = ab();
  const li = i => {
    const ta = P[`${a}_title`][i], tb = P[`${b}_title`][i];
    return `<li data-i="${i}"><div class="t1">${esc(ta)}</div><div class="t2"><span class="arr">${b} →</span> ${esc(tb)}</div>
      <span class="dv">${S.y === "d" ? f3(yVal(i)) : d3.format("+.3f")(yVal(i))}</span></li>`;
  };
  $("#divList").innerHTML = s.slice(0, rowsFit).map(li).join("");
  $("#aliList").innerHTML = s.slice(-rowsFit).reverse().map(li).join("");
  document.querySelectorAll(".tl li").forEach(el => {
    const i = +el.dataset.i;
    el.onclick = () => select(i, true);
    el.onpointerenter = () => { S.hover = i; drawHover(); };
    el.onpointerleave = () => { S.hover = null; drawHover(); };
  });
  $("#scopeTheme").textContent = S.theme != null ? P.themes[S.theme].split(" ")[0].toLowerCase() : "theme";
  $("#scopeTheme").disabled = S.theme == null;
  document.querySelectorAll("#scopeSeg button").forEach(btn => btn.classList.toggle("on", btn.dataset.v === (S.theme == null ? "all" : S.scope)));
}

function syncControls() {
  const [a] = ab();
  document.querySelectorAll("#pairSeg button").forEach(btn => btn.classList.toggle("on", btn.dataset.v === S.pair));
  // search rank and the "third language" colour only exist for some pairs
  $('#xSel option[value="rank"]').disabled = a !== "fi";
  $('#cSel option[value="rank"]').disabled = a !== "fi";
  $('#cSel option[value="third"]').disabled = S.pair === "sv_en";
  if (a !== "fi" && S.x === "rank") S.x = "len";
  if (a !== "fi" && S.c === "rank") S.c = "theme";
  if (S.pair === "sv_en" && S.c === "third") S.c = "theme";
  $("#xSel").value = S.x; $("#ySel").value = S.y; $("#cSel").value = S.c; $("#stubs").checked = S.stubs;
}

function render() {
  syncControls();
  filterVis(); layout(); scales();
  drawPoints(); drawAxes(); drawAnnotations(); drawHover();
  drawLegend(); drawLists(); drawUpset(); drawCovList(); syncUrl();
}

document.querySelectorAll("#pairSeg button").forEach(btn => btn.onclick = () => { S.pair = btn.dataset.v; render(); });
document.querySelectorAll("#scopeSeg button").forEach(btn => btn.onclick = () => { if (!btn.disabled) { S.scope = btn.dataset.v; render(); } });
$("#xSel").onchange = e => { S.x = e.target.value; render(); };
$("#ySel").onchange = e => { S.y = e.target.value; render(); };
$("#cSel").onchange = e => { S.c = e.target.value; render(); };
$("#stubs").onchange = e => { S.stubs = e.target.checked; render(); };
new ResizeObserver(() => render()).observe(plotEl);
$("#pairsSql").textContent = `${O.pairs_sql};\n\n-- coverage: which languages tell each topic\n${O.coverage_sql};`;

// ---------- find ----------
const lowT = LANGS.map(l => P[`${l}_title`].map(t => (t || "").toLowerCase()));
const findEl = $("#find"), findRes = $("#findRes");
findEl.oninput = () => {
  const q = findEl.value.trim().toLowerCase();
  if (q.length < 2) { findRes.style.display = "none"; return; }
  const hits = [];
  for (let i = 0; i < N && hits.length < 200; i++) if (lowT.some(a => a[i].includes(q))) hits.push(i);
  hits.sort((p, r) => (lowT.some(a => a[r].startsWith(q)) - lowT.some(a => a[p].startsWith(q))) || (P.versions[r] || 0) - (P.versions[p] || 0));
  findRes.innerHTML = hits.slice(0, 10).map(i => `<div data-i="${i}">${esc(P.fi_title[i])}
    <small>${LANGS.slice(1).filter(l => P[`${l}_title`][i]).map(l => `${l}: ${esc(P[`${l}_title`][i])}`).join(" · ")}</small></div>`).join("")
    || `<div class="mute">No topic with a Swedish or English article matches</div>`;
  findRes.style.display = "block";
  findRes.querySelectorAll("[data-i]").forEach(el => el.onclick = () => { findRes.style.display = "none"; findEl.value = ""; select(+el.dataset.i, true); });
};
findEl.onkeydown = e => { if (e.key === "Enter") findRes.querySelector("[data-i]")?.click(); if (e.key === "Escape") findRes.style.display = "none"; };

// ---------- one topic ----------
let reqId = 0;
async function select(i, scroll) {
  S.sel = i; drawHover(); syncUrl();
  // make sure the chosen topic is visible in the scatter
  const [a, b] = ab();
  if (P[`d_${S.pair}`][i] == null) S.pair = P.en_page[i] != null ? "fi_en" : "fi_sv";
  if (S.stubs && Math.min(P[`${ab()[0]}_len`][i], P[`${ab()[1]}_len`][i]) < STUB) S.stubs = false;
  if (S.combo && S.combo !== `${+(P.sv_page[i] != null)}${+(P.en_page[i] != null)}`) S.combo = null;
  render();
  const my = ++reqId;
  $("#cmpHead").innerHTML = `<h2>${esc(P.fi_title[i])}</h2><span class="meta">reading three Wikipedias…</span>`;
  if (scroll) $("#compare").scrollIntoView({ behavior: "smooth", block: "start" });
  let T;
  try { T = await getJSON(`/api/polyglot/topic/${P.fi_page[i]}`); }
  catch (e) { if (my === reqId) $("#cmpHead").innerHTML = `<h2>${esc(P.fi_title[i])}</h2><span class="meta">could not read this topic (${esc(e.message)})</span>`; return; }
  if (my !== reqId) return;
  drawTopic(i, T);
}

function drawTopic(i, T) {
  const m = T.meta, A = T.articles;
  $("#cmpHead").innerHTML = `<h2>${esc(A.fi.title)}</h2>
    <span class="tag" title="${esc(m.theme_fi || "")}">${esc(m.theme)}</span>
    <span class="meta">${m.wikidata_id ? `Wikidata <a href="https://www.wikidata.org/wiki/${esc(m.wikidata_id)}" target="_blank" rel="noopener">${esc(m.wikidata_id)}</a> · ` : ""}
      Finnish article: ${fmt(m.versions || 0)} edits by ${fmt(m.editors || 0)} editors since ${m.first_year ?? "?"}</span>`;
  drawTriangle(T);
  const pool = T.pool, cards = LANGS.map(l => {
    const a = A[l];
    if (!a) return `<div class="card ${l} missing"><div>${lg(l)}<br><br>No ${NAME[l]} article<br><span class="small">this topic is not told in ${NAME[l]}</span></div></div>`;
    const ratio = l !== "fi" ? ` · ${f2(a.len / A.fi.len)}× the Finnish` : "";
    const lists = (l === "fi" ? ["en", "sv"] : ["fi"]).filter(to => T.nearest[`${l}_${to}`]).map(to => {
      const own = A[to]?.page_id, nn = T.nearest[`${l}_${to}`].slice(0, l === "fi" ? 4 : 5);
      const r = T.ranks[`${l}_${to}`];
      const rline = r ? `<div class="rk">Its own ${NAME[to]} article ranks <b class="${r.rank === 1 ? "ok" : ""}">#${fmt(r.rank)}</b> of ${fmt(pool[to])} <span class="mute small">(exact count, ${r.ms} ms)</span></div>` : "";
      return `<h4>Nearest in meaning ${lg(to)}</h4>` + nn.map(n => {
        const j = byLangPage.get(`${to}:${n.page_id}`), self = n.page_id === own;
        const href = `https://${to}.wikipedia.org/?curid=${n.page_id}`;
        return `<div class="nn ${self ? "self" : ""}"><a class="nt" href="${href}" ${j != null && !self ? `data-i="${j}"` : `target="_blank" rel="noopener"`} title="${esc(n.title)}">${esc(n.title)}</a><span class="nd">${f3(n.distance)}</span></div>`;
      }).join("") + rline;
    }).join("");
    return `<div class="card ${l}">${lg(l)} <span class="cm">${NAME[l]} Wikipedia</span>
      <h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)} ↗</a></h3>
      <div class="cm">${fmt(a.len)} characters${ratio}${a.modified ? ` · text as of ${String(a.modified).slice(0, 10)}` : ""}</div>
      <p class="intro" lang="${l}">${esc(a.intro) || "<span class='mute'>(no introduction paragraph)</span>"}</p>
      <button class="more" hidden>Read more</button>${lists}</div>`;
  });
  $("#cards").innerHTML = cards.join("");
  $("#cards").querySelectorAll(".intro").forEach(p => {
    const btn = p.nextElementSibling;
    if (p.scrollHeight > p.clientHeight + 4) { btn.hidden = false; btn.onclick = () => { p.classList.toggle("open"); btn.textContent = p.classList.contains("open") ? "Less" : "Read more"; }; }
  });
  $("#cards").querySelectorAll("a[data-i]").forEach(el => el.onclick = e => { e.preventDefault(); select(+el.dataset.i, true); });
  $("#topicSql").textContent = T.sql;
}

function drawTriangle(T) {
  const svg = d3.select("#tri"); svg.selectAll("*").remove();
  const V = { fi: [130, 30], sv: [32, 196], en: [228, 196] }, A = T.articles;
  for (const [a, b] of [["fi", "sv"], ["fi", "en"], ["sv", "en"]]) {
    const k = `${a}_${b}`, d = T.distances[k], [x1, y1] = V[a], [x2, y2] = V[b], mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (d == null) { svg.append("line").attr("x1", x1).attr("y1", y1).attr("x2", x2).attr("y2", y2).attr("stroke", "rgba(255,255,255,.1)").attr("stroke-dasharray", "2 5"); continue; }
    const pr = O.pairs[k], hot = d >= pr.p90, cool = d <= pr.median;
    const col = hot ? COL.hl : cool ? COL.bot : "#c3c9d6";
    svg.append("line").attr("x1", x1).attr("y1", y1).attr("x2", x2).attr("y2", y2).attr("stroke", col).attr("stroke-width", hot ? 3 : 2).attr("opacity", .85);
    const off = k === "sv_en" ? [0, -22] : k === "fi_sv" ? [-40, -6] : [40, -6];
    svg.append("text").attr("x", mx + off[0]).attr("y", my + off[1]).attr("text-anchor", "middle").attr("fill", col)
      .attr("font-size", 15).attr("font-weight", 600).attr("font-family", "JetBrains Mono, monospace").text(f3(d));
    svg.append("text").attr("x", mx + off[0]).attr("y", my + off[1] + 13).attr("text-anchor", "middle").attr("fill", COL.mute)
      .attr("font-size", 10.5).text(hot ? "top 10% apart" : cool ? "below median" : "above median");
  }
  for (const l of LANGS) {
    const [x, y] = V[l], has = !!A[l];
    svg.append("circle").attr("cx", x).attr("cy", y).attr("r", 17).attr("fill", has ? "#0d1018" : "none")
      .attr("stroke", COL[l]).attr("stroke-width", 2).attr("stroke-dasharray", has ? null : "3 3").attr("opacity", has ? 1 : .5);
    svg.append("text").attr("x", x).attr("y", y + 4).attr("text-anchor", "middle").attr("fill", COL[l]).attr("font-size", 11.5)
      .attr("font-weight", 600).attr("font-family", "JetBrains Mono, monospace").attr("opacity", has ? 1 : .5).text(l.toUpperCase());
  }
  const ms = T.ms, vs = ms.vector_searches;
  $("#triNote").innerHTML = `Cosine distance between the articles' bge-m3 vectors, computed live by <span class="mono">VEC_DISTANCE_COSINE</span>
    (${ms.distances} ms). Medians: fi↔en ${f2(O.pairs.fi_en.median)}, fi↔sv ${f2(O.pairs.fi_sv.median)}, sv↔en ${f2(O.pairs.sv_en.median)}.
    ${vs.length} vector-index searches: ${d3.min(vs)}–${d3.max(vs)} ms.`;
}

// ---------- go ----------
filterVis();
const qTopic = byPage.get(+Q.get("topic"));
// default topic: the most divergent topic of the highlighted theme (in the default view)
const example = IDX.filter(i => P.theme[i] === defaultTheme.k && P.d_fi_en[i] != null && Math.min(P.fi_len[i], P.en_len[i]) >= STUB)
  .sort((p, q) => P.d_fi_en[q] - P.d_fi_en[p])[0];
const initial = qTopic ?? (S.theme === defaultTheme.k && S.pair === "fi_en" && vis.includes(example) ? example
  : vis.filter(i => P.theme[i] === S.theme).sort((p, q) => yVal(q) - yVal(p))[0] ?? vis[0]);
lede(example);
render();
select(initial, false);
