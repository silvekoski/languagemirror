// Heartbeat — the rhythm of editing. Data: /api/heartbeat/* (viz_heartbeat_* tables + live revision / article queries).
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const API = "/api/heartbeat";
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const getJSON = async u => { const r = await fetch(API + u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };

const KC = ["#8ab4ff", "#b48cff", "#5fd4b0"];
const KN = ["registered", "anonymous", "bot"];
const isBot = u => /(bot\d*(~fiwiki)?$|\(bot\)$)/i.test(u || "") || /^(Bot[A-Z-]|BOT)/.test(u || "");
// edit summaries are wikitext: show [[target|label]] as label, /* section */ as §section
const plainNote = n => String(n || "").replace(/\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]/g, "$1").replace(/\/\*\s*(.*?)\s*\*\/\s*/g, "§$1 ").replace(/\s+/g, " ").trim();
const noteOK = n => n && plainNote(n).replace(/^§\S*/, "").trim().length >= 4;
const FILTERS = { all: [0, 1, 2], human: [0, 1], reg: [0], anon: [1], bot: [2] };
const FCHIP = { all: "Everyone", human: "People", reg: "Registered", anon: "Anonymous", bot: "Bots" };
const FTEXT = { all: "everyone", human: "people (bots excluded)", reg: "registered editors", anon: "anonymous editors", bot: "bots" };
const METRIC = { n: "edits", reverts: "reverts", added: "bytes added", removed: "bytes removed" };
const ERA_C = ["#ffb46b", "#ff7d8a", "#7fb2ff"];
const RAMP = d3.interpolateRgbBasis(["#1a1c3d", "#33246b", "#5e2a88", "#982f86", "#d0406e", "#f36b4c", "#ffa65f", "#ffd99b", "#fff7e4"]);
const heat = t => RAMP(0.04 + 0.96 * Math.max(0, Math.min(1, t)));
const EMPTY = "rgba(255,255,255,0.04)";
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WDL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const fmt = d3.format(",");
const pct = v => (v * 100 >= 10 ? d3.format(".0f")(v * 100) : d3.format(".1f")(v * 100)) + "%";
const si = v => v < 1000 ? fmt(Math.round(v)) : d3.format(".3~s")(v).replace("G", "B");
const fmtBytes = v => v < 1000 ? `${Math.round(v)} B` : d3.format(".3~s")(v).replace(/([kMG])$/, " $1B");
const fmtV = (v, m = S.metric) => (m === "added" || m === "removed") ? fmtBytes(v) : fmt(Math.round(v));
const fmtVS = (v, m = S.metric) => (m === "added" || m === "removed") ? fmtBytes(v) : si(v);
const unit = (v, m = S.metric) => (m === "added" || m === "removed") ? "" : (m === "n" ? (v === 1 ? " edit" : " edits") : (v === 1 ? " revert" : " reverts"));

const DAY = 864e5, D0 = Date.UTC(2003, 0, 1);
const dOf = i => new Date(D0 + i * DAY);
const isoOf = i => dOf(i).toISOString().slice(0, 10);
const idxOf = s => Math.round((Date.parse(s + "T00:00:00Z") - D0) / DAY);
const fDay = d3.utcFormat("%a %-d %b %Y"), fDayL = d3.utcFormat("%A %-d %B %Y"), fShort = d3.utcFormat("%-d %b"), fMonth = d3.utcFormat("%b %Y");
const CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const ldoy = d => CUM[d.getUTCMonth()] + d.getUTCDate() - 1;        // day of a leap year: months line up across rows
const wdMon = d => (d.getUTCDay() + 6) % 7;
const wpLink = id => `https://fi.wikipedia.org/?curid=${id}`;
const oldLink = id => `https://fi.wikipedia.org/?oldid=${id}`;

// ---------------------------------------------------------------- state (mirrored in the URL)
const P = new URLSearchParams(location.search);
const pick = (k, ok, def) => ok.includes(P.get(k)) ? P.get(k) : def;
const DEF = { filter: "all", metric: "n", scale: "log", layout: "years", clock: "eras", cval: "share", rank: "edits", ridges: "20", order: "size", rscale: "own", smooth: "3", eras: "2004-2008,2012-2016,2021-2026" };
const S = {
  filter: pick("filter", Object.keys(FILTERS), DEF.filter), metric: pick("metric", Object.keys(METRIC), DEF.metric),
  scale: pick("scale", ["log", "linear"], DEF.scale), layout: pick("layout", ["years", "weeks"], DEF.layout),
  clock: pick("clock", ["eras", "years", "diff"], DEF.clock), cval: pick("cval", ["share", "count"], DEF.cval),
  rank: pick("rank", ["edits", "articles"], DEF.rank), ridges: pick("ridges", ["12", "20", "30"], DEF.ridges),
  order: pick("order", ["size", "peak"], DEF.order), rscale: pick("rscale", ["own", "shared"], DEF.rscale),
  smooth: pick("smooth", ["1", "3", "12"], DEF.smooth), eras: P.get("eras") || DEF.eras, day: P.get("day"),
};
function eras() {
  const e = S.eras.split(",").map(s => s.split("-").map(Number)).filter(a => a.length === 2 && a[0] >= 2003 && a[1] <= 2026 && a[0] <= a[1]);
  return e.length === 3 ? e : DEF.eras.split(",").map(s => s.split("-").map(Number));
}
function setEras(e) { S.eras = e.map(a => a.join("-")).join(","); }
function syncURL() {
  const q = new URLSearchParams();
  for (const k of Object.keys(DEF)) if (String(S[k]) !== DEF[k]) q.set(k, S[k]);
  if (S.day) q.set("day", S.day);
  history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : ""));
}

// ---------------------------------------------------------------- tooltip
const tip = $("#tip");
function showTip(html, ev) { tip.innerHTML = html; tip.hidden = false; moveTip(ev); }
function moveTip(ev) {
  const r = tip.getBoundingClientRect(), pad = 14;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
}
function hideTip() { tip.hidden = true; }

// ---------------------------------------------------------------- chips
function chips(el, opts, key, onChange) {
  el.innerHTML = opts.map(([v, l, dot]) => `<button class="chip${String(S[key]) === v ? " on" : ""}" data-v="${v}">${dot ? `<span class="dot" style="background:${dot}"></span>` : ""}${l}</button>`).join("");
  el.onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    S[key] = b.dataset.v; el.querySelectorAll(".chip").forEach(c => c.classList.toggle("on", c === b));
    syncURL(); onChange();
  };
}

// ---------------------------------------------------------------- load
const [CAL, CLK, PEAK_ALL] = await Promise.all([getJSON("/calendar"), getJSON("/clock"), getJSON("/peaks?filter=all")]);
const ND = CAL.ndays, LAST = CAL.end, Y_END = +LAST.slice(0, 4);
const YEARS = d3.range(2003, Y_END + 1);
const yStart = y => Math.max(0, idxOf(`${y}-01-01`)), yEnd = y => Math.min(ND, idxOf(`${y + 1}-01-01`));

const sCache = new Map();
function series(f = S.filter, m = S.metric) {
  const key = f + m;
  if (!sCache.has(key)) {
    const out = new Float64Array(ND);
    for (const k of FILTERS[f]) { const a = CAL.kinds[k][m]; for (let i = 0; i < ND; i++) out[i] += a[i]; }
    sCache.set(key, out);
  }
  return sCache.get(key);
}
const sumRange = (a, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i]; return s; };
const kindSum = (k, i0, i1, m = "n") => sumRange(CAL.kinds[k][m], i0, i1);

// day labels (top articles / driving editor), cached per filter+date
const topCache = new Map();
async function tops(dates, f = S.filter) {
  const need = dates.filter(d => !topCache.has(f + d));
  for (let i = 0; i < need.length; i += 60) {
    const r = await getJSON(`/tops?filter=${f}&dates=${need.slice(i, i + 60).join(",")}`);
    for (const d of need.slice(i, i + 60)) topCache.set(f + d, r.days[d] || null);
  }
  return Object.fromEntries(dates.map(d => [d, topCache.get(f + d)]));
}
const dayTop = async (d, f = S.filter) => (await tops([d], f))[d];

function labelHTML(lab, short = false) {
  if (!lab) return `<span class="mute">no edits</span>`;
  if (lab.driver) {
    const u = lab.driver;
    return `<b>${esc(u.user)}</b> ${pct(u.n / lab.total)}${noteOK(u.note) ? (short ? ` · ${esc(plainNote(u.note))}` : ` — “${esc(plainNote(u.note))}”`) : ""}`;
  }
  const p = lab.pages[0];
  if (!p) return "";
  if (p.n === 1) return `${fmt(lab.total)} articles, one edit each`;
  return `<b>${esc(p.title)}</b> ×${p.n}${lab.pages[1] && !short ? `, ${esc(lab.pages[1].title)} ×${lab.pages[1].n}` : ""}`;
}

// ---------------------------------------------------------------- hero: pulse + findings
function drawPulse() {
  const svg = d3.select("#pulse"), W = svg.node().clientWidth, H = 64;
  svg.attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();
  const all = series("all", "n"), wk = [];
  for (let i = 0; i < ND; i += 7) wk.push(sumRange(all, i, Math.min(ND, i + 7)));
  const x = d3.scaleLinear([0, wk.length - 1], [0, W]), y = d3.scaleLinear([0, d3.max(wk)], [H - 12, 2]);
  const g = svg.append("g");
  const grad = svg.append("defs").append("linearGradient").attr("id", "pg").attr("x1", 0).attr("x2", 1);
  grad.append("stop").attr("offset", 0).attr("stop-color", "#ff6b6b").attr("stop-opacity", .5);
  grad.append("stop").attr("offset", 1).attr("stop-color", "#ffb46b");
  for (const yy of [2005, 2010, 2015, 2020, 2025]) {
    const xx = x((idxOf(`${yy}-01-01`)) / 7);
    g.append("line").attr("x1", xx).attr("x2", xx).attr("y1", H - 12).attr("y2", H - 9.5).attr("stroke", "#4a5168");
    g.append("text").attr("x", xx).attr("y", H).attr("text-anchor", "middle").text(yy);
  }
  g.append("path").attr("d", d3.line((d, i) => x(i), d => y(d))(wk)).attr("fill", "none")
    .attr("stroke", "url(#pg)").attr("stroke-width", 1.1).attr("stroke-linejoin", "round");
  const im = d3.maxIndex(wk);
  g.append("circle").attr("cx", x(im)).attr("cy", y(wk[im])).attr("r", 2.5).attr("fill", "#fff");
  svg.append("text").attr("x", 0).attr("y", 8).text(`${W < 520 ? "" : "edits per week · "}busiest: ${fmt(wk[im])} in the week from ${fShort(dOf(im * 7))} ${dOf(im * 7).getUTCFullYear()} ●`);
}

function findings() {
  const [eA, , eC] = [[2004, 2008], [2012, 2016], [2021, Y_END]];
  const share = (k, [a, b]) => { const i0 = yStart(a), i1 = yEnd(b); return kindSum(k, i0, i1) / (kindSum(0, i0, i1) + kindSum(1, i0, i1) + kindSum(2, i0, i1)); };
  const top = PEAK_ALL.top[0];
  const drv = top.driver;
  const wdShare = ([a, b]) => { const m = clockMat("human", a, b), w = d3.range(7).map(d => d3.sum(m.slice(d * 24, d * 24 + 24))); const t = d3.sum(w); return w.map(v => v / t); };
  const wA = wdShare(eA), wC = wdShare(eC), bA = d3.maxIndex(wA), bC = d3.maxIndex(wC);
  const era = ([a, b]) => `${a}–${String(b).slice(2)}`;
  $("#findings").innerHTML = `
    <div class="find click" data-day="${top.date}">
      <div class="lab">Busiest day ever</div>
      <div class="big">${fDay(new Date(top.date + "T00:00:00Z"))}</div>
      <p><b>${fmt(top.n)}</b> edits in one Helsinki day${drv ? ` — <b>${fmt(drv.n)}</b> of them by <b class="${isBot(drv.user) ? "k2" : ""}">${esc(drv.user)}</b>${noteOK(drv.note) ? `: “${esc(plainNote(drv.note))}”` : ""}` : ""}</p>
    </div>
    <div class="find">
      <div class="lab">Bots' share of edits</div>
      <div class="big"><span class="k2">${pct(share(2, eA))}</span><span class="arrow">→</span><span class="k2">${pct(share(2, eC))}</span></div>
      <p>${era(eA)} vs ${era(eC)}. The biggest days on the calendar below are almost all bot sweeps.</p>
    </div>
    <div class="find">
      <div class="lab">Anonymous edits</div>
      <div class="big"><span class="k1">${pct(share(1, eA))}</span><span class="arrow">→</span><span class="k1">${pct(share(1, eC))}</span></div>
      <p>share of all edits made without an account, ${era(eA)} vs ${era(eC)}.</p>
    </div>
    <div class="find">
      <div class="lab">People's busiest weekday</div>
      <div class="big">${WD[bA]} <span class="arrow">→</span> ${WD[bC]}</div>
      <p>${bA === bC ? "unchanged" : "moved"}: ${WDL[bA]} had ${pct(wA[bA])} of people's edits in ${era(eA)}; in ${era(eC)} ${WDL[bC]} has ${pct(wC[bC])}${bA !== bC ? ` (${WDL[bA]} ${pct(wC[bA])})` : ""}.</p>
    </div>`;
  $("#findings").querySelector("[data-day]").onclick = e => openDay(e.currentTarget.dataset.day);
}

// ---------------------------------------------------------------- calendar
const yearCells = {};       // year -> Int32Array(366): day of year -> day index (-1 = no data)
const yearWeeks = {};       // year -> Int32Array(53*7)
for (const y of YEARS) {
  const a = new Int32Array(366).fill(-1), w = new Int32Array(54 * 7).fill(-1);
  const off = wdMon(new Date(Date.UTC(y, 0, 1)));
  for (let i = yStart(y); i < yEnd(y); i++) {
    const d = dOf(i), doy = Math.round((d - Date.UTC(y, 0, 1)) / DAY);
    a[doy] = i;
    w[Math.floor((doy + off) / 7) * 7 + wdMon(d)] = i;
  }
  yearCells[y] = a; yearWeeks[y] = w;
}

let colorOf = () => EMPTY, calMax = 1, calLo = 1, calPos = () => 0, peakIdx = {};
function prepColor() {
  const v = series();
  calMax = d3.max(v) || 1;
  // log scale from the 3rd percentile of non-empty days (so the busy middle isn't one flat colour)
  const nz = Float64Array.from(v.filter(x => x > 0)).sort();
  calLo = Math.max(1, Math.min(calMax / 10, d3.quantileSorted(nz, 0.03) || 1));
  calPos = S.scale === "log"
    ? x => Math.max(0, Math.log(x / calLo) / Math.log(calMax / calLo))
    : x => x / calMax;
  colorOf = x => x > 0 ? heat(S.scale === "log" ? calPos(x) : 0.06 + 0.94 * calPos(x)) : EMPTY;
  peakIdx = {};
  for (const y of YEARS) { let b = -1, bv = 0; for (let i = yStart(y); i < yEnd(y); i++) if (v[i] > bv) { bv = v[i]; b = i; } peakIdx[y] = b; }
}

function drawLegend() {
  const el = $("#calLegend");
  let ticks = S.scale === "log" ? [1, 10, 100, 1000, 1e4, 1e5, 1e6, 1e7, 1e8].filter(t => t > calLo * 2.2 && t < calMax / 3) : [calMax / 4, calMax / 2, calMax * 3 / 4];
  const tl = S.scale === "log" ? [[0, (calLo > 1 ? "≤" : "") + fmtVS(calLo)]] : [[0, "0"]];
  el.innerHTML = `<span><span class="empty"></span>none</span><div class="gbar"><canvas width="220" height="10"></canvas><div class="ticks">${[...tl, ...ticks.map(t => [calPos(t), fmtVS(t)]), [1, fmtVS(calMax)]].map(([p, t], i, a) => `<span style="left:${p * 100}%;${i === 0 ? "transform:none" : i === a.length - 1 ? "transform:translateX(-100%);color:#c3c9d6" : ""}">${t}</span>`).join("")}</div></div><span class="ltxt">${METRIC[S.metric]} per day by ${FTEXT[S.filter]} · ${S.scale} scale</span>`;
  const c = el.querySelector("canvas").getContext("2d");
  for (let x = 0; x < 220; x++) { c.fillStyle = S.scale === "log" ? heat(x / 219) : heat(0.06 + 0.94 * x / 219); c.fillRect(x, 0, 1, 10); }
  const fk = FILTERS[S.filter];
  $("#mixLegend").innerHTML = `<span class="mute">Year mix:</span>` + KN.map((n, k) => `<span style="opacity:${fk.includes(k) ? 1 : .4}"><i style="background:${KC[k]}"></i>${n}</span>`).join("");
}

function buildStrips() {
  const el = $("#calStrips");
  const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  el.innerHTML = `<div class="mrow"><span></span><div class="months">${MN.map((m, i) => `<span style="left:${CUM[i] / 366 * 100}%">${m}</span>`).join("")}</div><div class="meta-h"><span id="totH">total</span><span>mix</span><span>busiest day — who or what</span></div></div>` +
    YEARS.slice().reverse().map(y => `<div class="yrow" data-y="${y}"><div class="ylab">${y}</div><canvas></canvas><div class="ymeta"><span class="ytot"></span><span class="mix"></span><span class="ypeak"></span></div></div>`).join("");
  el.querySelectorAll(".yrow").forEach(row => {
    const y = +row.dataset.y, cv = row.querySelector("canvas");
    const at = ev => { const r = cv.getBoundingClientRect(); return yearCells[y][Math.floor((ev.clientX - r.left) / r.width * 366)] ?? -1; };
    cv.onmousemove = ev => { const i = at(ev); i >= 0 ? dayTip(i, ev) : hideTip(); };
    cv.onmouseleave = hideTip;
    cv.onclick = ev => { const i = at(ev); if (i >= 0) openDay(isoOf(i)); };
    row.querySelector(".ypeak").onclick = () => peakIdx[y] >= 0 && openDay(isoOf(peakIdx[y]));
  });
}

function drawStrips() {
  const v = series(), dpr = devicePixelRatio || 1, fk = FILTERS[S.filter];
  $("#totH").textContent = S.metric === "n" ? "edits" : METRIC[S.metric].replace("bytes ", "");
  document.querySelectorAll("#calStrips .yrow").forEach(row => {
    const y = +row.dataset.y, cv = row.querySelector("canvas");
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const c = cv.getContext("2d"); c.scale(dpr, dpr);
    const cw = W / 366, gap = cw > 2.4 ? 0.6 : 0, cells = yearCells[y];
    for (let j = 0; j < 366; j++) {
      const i = cells[j]; if (i < 0) continue;
      c.fillStyle = colorOf(v[i]); c.fillRect(j * cw, 3, Math.max(cw - gap, 0.6), H - 6);
    }
    const p = peakIdx[y];
    if (p >= 0) { const j = Math.round((dOf(p) - Date.UTC(y, 0, 1)) / DAY); c.strokeStyle = "#fff"; c.lineWidth = 1.2; c.strokeRect(j * cw - 1, 1, Math.max(cw, 1) + 2, H - 2); }
    const sd = S.day ? idxOf(S.day) : -1;
    if (sd >= yStart(y) && sd < yEnd(y)) { const j = Math.round((dOf(sd) - Date.UTC(y, 0, 1)) / DAY); c.fillStyle = "#5fd4b0"; c.fillRect(j * cw - 1.5, 0, Math.max(cw, 1) + 3, 2.5); c.fillRect(j * cw - 1.5, H - 2.5, Math.max(cw, 1) + 3, 2.5); }
    const i0 = yStart(y), i1 = yEnd(y);
    row.querySelector(".ytot").textContent = fmtVS(sumRange(v, i0, i1));
    const ks = [0, 1, 2].map(k => kindSum(k, i0, i1)), t = d3.sum(ks) || 1;
    row.querySelector(".mix").innerHTML = ks.map((n, k) => `<i class="${fk.includes(k) ? "" : "off"}" style="width:${n / t * 100}%;background:${KC[k]}" title="${KN[k]} ${pct(n / t)}"></i>`).join("");
    row.querySelector(".mix").title = `${y}: ` + ks.map((n, k) => `${KN[k]} ${pct(n / t)}`).join(", ");
  });
}

function buildWeeks() {
  const el = $("#calWeeks");
  el.innerHTML = YEARS.slice().reverse().map(y => `<div class="wblock" data-y="${y}"><div class="wh"><b>${y}</b><span class="ytot"></span><span class="ypeak"></span></div><canvas></canvas></div>`).join("");
  el.querySelectorAll(".wblock").forEach(b => {
    const y = +b.dataset.y, cv = b.querySelector("canvas");
    const at = ev => { const r = cv.getBoundingClientRect(), cs = r.width / 53; const col = Math.floor((ev.clientX - r.left) / cs), row = Math.floor((ev.clientY - r.top) / cs); return row < 7 && col < 54 ? yearWeeks[y][col * 7 + row] : -1; };
    cv.onmousemove = ev => { const i = at(ev); i >= 0 ? dayTip(i, ev) : hideTip(); };
    cv.onmouseleave = hideTip;
    cv.onclick = ev => { const i = at(ev); if (i >= 0) openDay(isoOf(i)); };
    b.querySelector(".ypeak").onclick = () => peakIdx[y] >= 0 && openDay(isoOf(peakIdx[y]));
  });
}
function drawWeeks() {
  const v = series(), dpr = devicePixelRatio || 1;
  document.querySelectorAll("#calWeeks .wblock").forEach(b => {
    const y = +b.dataset.y, cv = b.querySelector("canvas");
    const W = cv.clientWidth, cs = W / 53, H = Math.ceil(cs * 7);
    cv.style.height = H + "px"; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const c = cv.getContext("2d"); c.scale(dpr, dpr);
    const w = yearWeeks[y];
    for (let k = 0; k < w.length; k++) {
      const i = w[k]; if (i < 0) continue;
      const col = Math.floor(k / 7), row = k % 7; if (col > 52) continue;
      c.fillStyle = colorOf(v[i]); c.beginPath(); c.roundRect(col * cs + .6, row * cs + .6, cs - 1.2, cs - 1.2, 1.5); c.fill();
      if (i === peakIdx[y]) { c.strokeStyle = "#fff"; c.lineWidth = 1.3; c.strokeRect(col * cs, row * cs, cs, cs); }
      if (S.day && i === idxOf(S.day)) { c.strokeStyle = "#5fd4b0"; c.lineWidth = 2; c.strokeRect(col * cs + .5, row * cs + .5, cs - 1, cs - 1); }
    }
    b.querySelector(".ytot").textContent = fmtVS(sumRange(v, yStart(y), yEnd(y))) + " " + (S.metric === "n" ? "edits" : METRIC[S.metric]);
  });
}

let peakToken = 0;
async function labelPeaks() {
  const tok = ++peakToken, v = series();
  const dates = YEARS.map(y => peakIdx[y] >= 0 ? isoOf(peakIdx[y]) : null).filter(Boolean);
  const labs = await tops(dates);
  if (tok !== peakToken) return;
  for (const y of YEARS) {
    const p = peakIdx[y];
    const html = p < 0 ? "" : `<span class="d">${fShort(dOf(p))} · ${fmtVS(v[p])}</span>${labelHTML(labs[isoOf(p)], true)}`;
    document.querySelectorAll(`[data-y="${y}"] .ypeak`).forEach(e => { e.innerHTML = html; e.title = e.textContent; });
  }
}

function drawCalendar() {
  prepColor(); drawLegend();
  $("#calStrips").hidden = S.layout !== "years"; $("#calWeeks").hidden = S.layout !== "weeks";
  if (S.layout === "years") drawStrips(); else drawWeeks();
  labelPeaks();
}

let tipDay = -1;
async function dayTip(i, ev) {
  if (i === tipDay) { moveTip(ev); return; }
  tipDay = i;
  const d = dOf(i), iso = isoOf(i), v = series()[i];
  const ks = [0, 1, 2].map(k => CAL.kinds[k].n[i]), tot = d3.sum(ks);
  const head = `<div class="t-d">${fDay(d)}</div><div class="t-n">${fmtV(v)}<small>${unit(v)} by ${FTEXT[S.filter]}</small></div>` +
    (tot ? `<div class="t-mix">${ks.map((n, k) => `<i style="width:${n / tot * 100}%;background:${KC[k]}"></i>`).join("")}</div>
     <div class="t-row">${ks.map((n, k) => n ? `<span style="color:${KC[k]}">${fmt(n)} ${KN[k]}</span>` : "").filter(Boolean).join(" · ")}${S.metric === "n" ? "" : ""}</div>
     <div class="t-row">${fmt(d3.sum(FILTERS[S.filter], k => CAL.kinds[k].reverts[i]))} reverts · +${fmtBytes(d3.sum(FILTERS[S.filter], k => CAL.kinds[k].added[i]))} / −${fmtBytes(d3.sum(FILTERS[S.filter], k => CAL.kinds[k].removed[i]))}</div>` : `<div class="t-row">no edits this day</div>`);
  showTip(head + (tot ? `<div class="t-row" style="margin-top:6px">loading…</div>` : ""), ev);
  if (!tot) return;
  const lab = await dayTop(iso);
  if (tipDay !== i) return;
  let body = "";
  if (lab) {
    body += `<div class="t-row" style="margin-top:6px">Most edited${lab.pages[0]?.n === 1 ? " (one edit each)" : ""}:</div><ol>${lab.pages.map(p => `<li>${esc(p.title)} <span>×${p.n}</span></li>`).join("")}</ol>`;
    if (lab.user) body += `<div class="t-u">Top editor: <b>${esc(lab.user.user)}</b> <span class="mute">${fmt(lab.user.n)} of ${fmt(lab.total)}</span>${noteOK(lab.user.note) ? `<br><q>${esc(plainNote(lab.user.note).slice(0, 110))}</q>` : ""}</div>`;
  } else body = `<div class="t-row">no edits by ${FTEXT[S.filter]}</div>`;
  showTip(head + body + `<div class="t-hint">click to open the day</div>`, ev);
}

// ---------------------------------------------------------------- clock
function clockMat(f, y0, y1) {
  const out = new Float64Array(168);
  for (const k of FILTERS[f]) for (let y = y0; y <= y1; y++) { const a = CLK.kinds[k][y]; if (a) for (let j = 0; j < 168; j++) out[j] += a[j]; }
  return out;
}
const hourProf = m => d3.range(24).map(h => d3.sum(d3.range(7), d => m[d * 24 + h]));
const dayProf = m => d3.range(7).map(d => d3.sum(m.slice(d * 24, d * 24 + 24)));
const hh = h => String(h).padStart(2, "0") + ":00";
function eraStats(m) {
  const t = d3.sum(m) || 1, hp = hourProf(m), dp = dayProf(m), pk = d3.maxIndex(m);
  return { t, pk, peakHour: d3.maxIndex(hp), peakDay: d3.maxIndex(dp), evening: d3.sum(hp.slice(20)) / t, night: d3.sum(hp.slice(0, 6)) / t, weekend: (dp[5] + dp[6]) / t, work: d3.sum(d3.range(5), d => d3.sum(hp.slice(9, 17).map((_, i) => m[d * 24 + 9 + i]))) / t };
}

function heatmap(svgEl, m, { max, color, eraColor, label = true, small = false, diff = false, onCell }) {
  const W = svgEl.clientWidth || svgEl.parentNode.clientWidth;
  const ml = small ? 0 : 30, mr = small ? 0 : 36, mt = small ? 0 : 28, mb = small ? 0 : 16;
  const cw = (W - ml - mr) / 24, ch = small ? cw : Math.min(cw * 1.05, 24), H = mt + ch * 7 + mb;
  const svg = d3.select(svgEl).attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("transform", `translate(${ml},${mt})`);
  const t = d3.sum(m) || 1;
  g.selectAll("rect.c").data(Array.from(m)).join("rect").attr("class", "c")
    .attr("x", (d, j) => (j % 24) * cw + .5).attr("y", (d, j) => Math.floor(j / 24) * ch + .5)
    .attr("width", Math.max(cw - 1, .5)).attr("height", Math.max(ch - 1, .5)).attr("rx", small ? 1 : 2)
    .attr("fill", d => diff ? color(d) : (d > 0 ? color(d / max) : EMPTY))
    .each(function (d, j) {
      this.onmousemove = ev => onCell && onCell(j, ev);
      this.onmouseleave = hideTip;
    });
  if (small) return;
  // marginals: hour profile on top, weekday profile on the right
  const hp = hourProf(m), dp = dayProf(m);
  if (!diff) {
    const hy = d3.scaleLinear([0, d3.max(hp) || 1], [0, mt - 8]);
    svg.append("g").attr("transform", `translate(${ml},0)`).selectAll("rect").data(hp).join("rect")
      .attr("x", (d, h) => h * cw + 1).attr("width", Math.max(cw - 2, .5)).attr("y", d => mt - 4 - hy(d)).attr("height", d => hy(d))
      .attr("fill", eraColor).attr("opacity", .75).attr("rx", 1);
    const dx = d3.scaleLinear([0, d3.max(dp) || 1], [0, mr - 8]);
    svg.append("g").attr("transform", `translate(${ml + cw * 24 + 4},${mt})`).selectAll("rect").data(dp).join("rect")
      .attr("y", (d, i) => i * ch + 2).attr("height", Math.max(ch - 4, 1)).attr("x", 0).attr("width", d => dx(d))
      .attr("fill", eraColor).attr("opacity", .75).attr("rx", 1);
  }
  const ax = svg.append("g").attr("class", "axis");
  WD.forEach((w, i) => ax.append("text").attr("x", ml - 6).attr("y", mt + i * ch + ch / 2 + 3.5).attr("text-anchor", "end").text(w));
  [0, 6, 12, 18, 23].forEach(h => ax.append("text").attr("x", ml + h * cw + cw / 2).attr("y", H - 3).attr("text-anchor", "middle").text(String(h).padStart(2, "0")));
  if (label && !diff) {
    const pk = d3.maxIndex(m);
    g.append("rect").attr("x", (pk % 24) * cw - .5).attr("y", Math.floor(pk / 24) * ch - .5).attr("width", cw + 1).attr("height", ch + 1)
      .attr("fill", "none").attr("stroke", "#fff").attr("stroke-width", 1.3).attr("rx", 2.5).attr("pointer-events", "none");
  }
}

function cellTip(m, j, ev, title) {
  const t = d3.sum(m) || 1, d = Math.floor(j / 24), h = j % 24;
  showTip(`<div class="t-d">${title}</div><div class="t-n">${fmt(m[j])}<small> edits · ${WDL[d]} ${hh(h)}–${hh((h + 1) % 24)}</small></div><div class="t-row">${pct(m[j] / t)} of the era's edits by ${FTEXT[S.filter]} (an even spread would be ${pct(1 / 168)})</div>`, ev);
}

function drawClock() {
  const body = $("#clockBody"), E = eras();
  hideTip();
  if (S.clock === "eras") {
    const mats = E.map(([a, b]) => clockMat(S.filter, a, b));
    const shares = mats.map(m => { const t = d3.sum(m) || 1; return Array.from(m, v => v / t); });
    const max = S.cval === "share" ? d3.max(shares.flat()) : d3.max(mats.map(m => d3.max(m)));
    const yearOpts = sel => YEARS.map(y => `<option${y === sel ? " selected" : ""}>${y}</option>`).join("");
    body.innerHTML = `<div class="clock-grid">${E.map(([a, b], e) => `<div class="era" data-e="${e}">
        <div class="era-h"><span class="sw" style="background:${ERA_C[e]}"></span><select data-p="0">${yearOpts(a)}</select>–<select data-p="1">${yearOpts(b)}</select><span class="tot">${fmt(d3.sum(mats[e]))} edits</span></div>
        <svg></svg><div class="stat"></div></div>`).join("")}
      <div class="radial"><svg></svg><div class="rl">Share of edits by hour of day — the three eras overlaid</div></div><p class="note" id="clockNoteIn"></p></div>`;
    body.querySelectorAll(".era").forEach(el => {
      const e = +el.dataset.e, m = mats[e], st = eraStats(m);
      heatmap(el.querySelector("svg"), S.cval === "share" ? shares[e] : m, {
        max, color: heat, eraColor: ERA_C[e],
        onCell: (j, ev) => cellTip(m, j, ev, `${E[e][0]}–${E[e][1]}`),
      });
      el.querySelector(".stat").innerHTML = `<span>peak <b>${WD[Math.floor(st.pk / 24)]} ${hh(st.pk % 24)}</b></span><span>after 20:00 <b>${pct(st.evening)}</b></span><span>weekends <b>${pct(st.weekend)}</b></span><span>00–06 <b>${pct(st.night)}</b></span>`;
      el.querySelectorAll("select").forEach(s => s.onchange = () => {
        const E2 = eras(); E2[e][+s.dataset.p] = +s.value; if (E2[e][0] > E2[e][1]) E2[e].reverse(); setEras(E2); syncURL(); drawClock();
      });
    });
    radial(body.querySelector(".radial svg"), mats, E);
    const s0 = eraStats(mats[0]), s2 = eraStats(mats[2]);
    const p1 = v => (v * 100).toFixed(1) + "%";
    const dir = (a, b) => Math.abs(b - a) < 0.0005 ? "stayed at" : b > a ? "rose from" : "fell from";
    const ch = (a, b) => Math.abs(b - a) < 0.0005 ? `<b>${p1(a)}</b>` : `<b>${p1(a)}</b> to <b>${p1(b)}</b>`;
    const slot = j => `${WDL[Math.floor(j / 24)]} ${hh(j % 24)}`;
    let extra = "";
    if (S.filter === "all") {
      const h0 = eraStats(clockMat("human", ...E[0])), h2 = eraStats(clockMat("human", ...E[2])), b2 = eraStats(clockMat("bot", ...E[2]));
      extra = ` Bots are included here: on their own, bots' busiest slot in ${E[2][0]}–${E[2][1]} was <b>${slot(b2.pk)}</b>. For people alone the busiest slot moved from <b>${slot(h0.pk)}</b> to <b>${slot(h2.pk)}</b>, and their after-20:00 share ${dir(h0.evening, h2.evening)} ${ch(h0.evening, h2.evening)}.`;
    }
    $("#clockNote").innerHTML = "";
    $("#clockNoteIn").innerHTML = `For ${FTEXT[S.filter]}, from <b>${E[0][0]}–${E[0][1]}</b> to <b>${E[2][0]}–${E[2][1]}</b>: the share of edits made after 20:00 ${dir(s0.evening, s2.evening)} ${ch(s0.evening, s2.evening)}, office hours (Mon–Fri 9–17) ${dir(s0.work, s2.work)} ${ch(s0.work, s2.work)}, weekends ${dir(s0.weekend, s2.weekend)} ${ch(s0.weekend, s2.weekend)}. The busiest hour of the week moved from <b>${slot(s0.pk)}</b> to <b>${slot(s2.pk)}</b>.${extra}`;
  } else if (S.clock === "years") {
    const mats = YEARS.map(y => clockMat(S.filter, y, y));
    const shares = mats.map(m => { const t = d3.sum(m) || 1; return Array.from(m, v => v / t); });
    const big = mats.map(m => d3.sum(m) >= 300);
    // colour top = 99.5th percentile, so one bot-run hour (e.g. Fri 00:00 in 2024) doesn't darken every other year
    const pool = (S.cval === "share" ? shares : mats).filter((_, i) => big[i]).flatMap(m => Array.from(m)).sort(d3.ascending);
    const max = d3.quantileSorted(pool, 0.995) || 1;
    body.innerHTML = `<div class="yearsgrid">${YEARS.map((y, i) => `<div class="yc" data-i="${i}"><div class="h"><b>${y}</b><span>${fmt(d3.sum(mats[i]))} edits · peak ${d3.sum(mats[i]) ? `${WD[Math.floor(d3.maxIndex(mats[i]) / 24)]} ${hh(d3.maxIndex(mats[i]) % 24)}` : "–"}</span></div><svg></svg></div>`).join("")}</div>`;
    body.querySelectorAll(".yc").forEach(el => {
      const i = +el.dataset.i;
      if (!big[i]) { el.style.opacity = .4; el.title = "fewer than 300 edits: too few for a stable pattern"; }
      heatmap(el.querySelector("svg"), S.cval === "share" ? shares[i] : mats[i], { max, color: heat, small: true, onCell: (j, ev) => cellTip(mats[i], j, ev, String(YEARS[i])) });
    });
    const peaks = YEARS.map((y, i) => ({ y, h: d3.maxIndex(hourProf(mats[i])), ok: big[i] })).filter(p => p.ok);
    const ev = YEARS.map((y, i) => ({ y, e: eraStats(mats[i]).evening, ok: big[i] })).filter(p => p.ok);
    const lo = d3.least(ev, p => p.e), hi = d3.greatest(ev, p => p.e);
    $("#clockNote").innerHTML = `Each square is one year, Monday at the top, midnight at the left. For ${FTEXT[S.filter]}, the evening (after 20:00) share was highest in <b>${hi.y}</b> (${pct(hi.e)}) and lowest in <b>${lo.y}</b> (${pct(lo.e)}). Busiest hour of the day by year: ${peaks.map(p => `${p.y} <b>${String(p.h).padStart(2, "0")}h</b>`).join(" · ")}.`;
  } else {
    const [A, , C] = E, mA = clockMat(S.filter, ...A), mC = clockMat(S.filter, ...C);
    const tA = d3.sum(mA) || 1, tC = d3.sum(mC) || 1;
    const dm = Array.from(mC, (v, j) => (v / tC - mA[j] / tA) * 100);
    const lim = d3.max(dm, Math.abs) || 1;
    const div = d3.interpolateRgbBasis(["#3d7bff", "#203060", "#11131f", "#6a2440", "#ff6b5a"]);
    const col = v => div(0.5 + 0.5 * v / lim);
    const yearOpts = sel => YEARS.map(y => `<option${y === sel ? " selected" : ""}>${y}</option>`).join("");
    body.innerHTML = `<div class="diff"><div><div class="pick">From <select data-e="0" data-p="0">${yearOpts(A[0])}</select>–<select data-e="0" data-p="1">${yearOpts(A[1])}</select> to <select data-e="2" data-p="0">${yearOpts(C[0])}</select>–<select data-e="2" data-p="1">${yearOpts(C[1])}</select> <span class="mute">· change in share of edits, percentage points</span></div><svg></svg></div><div class="side"></div></div>`;
    heatmap(body.querySelector(".diff svg"), dm, { diff: true, color: col, onCell: (j, ev) => {
      const d = Math.floor(j / 24), h = j % 24;
      showTip(`<div class="t-d">${WDL[d]} ${hh(h)}</div><div class="t-n">${dm[j] > 0 ? "+" : ""}${dm[j].toFixed(2)}<small> percentage points</small></div><div class="t-row">${A[0]}–${A[1]}: ${pct(mA[j] / tA)} · ${C[0]}–${C[1]}: ${pct(mC[j] / tC)}</div>`, ev);
    } });
    body.querySelectorAll(".pick select").forEach(s => s.onchange = () => {
      const E2 = eras(); E2[+s.dataset.e][+s.dataset.p] = +s.value; const e = E2[+s.dataset.e]; if (e[0] > e[1]) e.reverse(); setEras(E2); syncURL(); drawClock();
    });
    const order = d3.range(168).sort((a, b) => dm[b] - dm[a]);
    const cell = j => `${WD[Math.floor(j / 24)]} ${hh(j % 24)}`;
    const hpA = hourProf(mA).map(v => v / tA), hpC = hourProf(mC).map(v => v / tC);
    const hd = hpC.map((v, h) => v - hpA[h]);
    body.querySelector(".side").innerHTML = `<p><span style="color:#ff6b5a">■</span> busier now, <span style="color:#3d7bff">■</span> quieter now (for ${FTEXT[S.filter]}).</p>
      <p><b>Gained most:</b> ${order.slice(0, 3).map(j => `${cell(j)} (+${dm[j].toFixed(2)})`).join(", ")}</p>
      <p><b>Lost most:</b> ${order.slice(-3).reverse().map(j => `${cell(j)} (${dm[j].toFixed(2)})`).join(", ")}</p>
      <p><b>By hour of day:</b> the biggest gain is ${hh(d3.maxIndex(hd))} (+${(d3.max(hd) * 100).toFixed(1)} pp), the biggest loss ${hh(d3.minIndex(hd))} (${(d3.min(hd) * 100).toFixed(1)} pp).</p>`;
    $("#clockNote").innerHTML = `Difference of two eras' weekday × hour shares: red cells took a larger part of the week's editing in ${C[0]}–${C[1]} than in ${A[0]}–${A[1]}, blue cells a smaller part. Values sum to zero.`;
  }
}

function radial(svgEl, mats, E) {
  const W = svgEl.parentNode.clientWidth, S2 = Math.min(W, 300), R = S2 / 2 - 22, r0 = R * 0.16;
  const svg = d3.select(svgEl).attr("viewBox", `${-S2 / 2} ${-S2 / 2} ${S2} ${S2 + 16}`).attr("height", S2 + 16);
  svg.selectAll("*").remove();
  const profs = mats.map(m => { const t = d3.sum(m) || 1; return hourProf(m).map(v => v / t); });
  const max = d3.max(profs.flat());
  const r = d3.scaleLinear([0, max], [r0, R]);
  const ang = h => (h / 24) * 2 * Math.PI;
  const grid = svg.append("g");
  for (const v of d3.ticks(0, max, 3).filter(v => v > 0)) {
    grid.append("circle").attr("r", r(v)).attr("fill", "none").attr("stroke", "rgba(255,255,255,.07)");
    const la = (7.5 / 24) * 2 * Math.PI - Math.PI / 2;
    grid.append("text").attr("class", "ax").attr("x", Math.cos(la) * r(v) + 3).attr("y", Math.sin(la) * r(v) - 2).text(pct(v));
  }
  grid.append("circle").attr("r", r0).attr("fill", "none").attr("stroke", "rgba(255,255,255,.1)");
  for (let h = 0; h < 24; h++) {
    const a = ang(h) - Math.PI / 2;
    grid.append("line").attr("x1", Math.cos(a) * r0).attr("y1", Math.sin(a) * r0).attr("x2", Math.cos(a) * R).attr("y2", Math.sin(a) * R).attr("stroke", h % 6 ? "rgba(255,255,255,.03)" : "rgba(255,255,255,.09)");
    if (h % 3 === 0) grid.append("text").attr("class", "ax").attr("x", Math.cos(a) * (R + 12)).attr("y", Math.sin(a) * (R + 12) + 3.5).attr("text-anchor", "middle").text(String(h).padStart(2, "0"));
  }
  const line = d3.lineRadial().angle((d, h) => ang(h + 0.5)).radius(d => r(d)).curve(d3.curveCatmullRomClosed);
  profs.forEach((p, e) => {
    svg.append("path").attr("d", line(p)).attr("fill", ERA_C[e]).attr("fill-opacity", .06).attr("stroke", ERA_C[e]).attr("stroke-width", 1.8);
  });
  svg.append("text").attr("text-anchor", "middle").attr("y", -4).attr("fill", "#8a93a8").style("font-size", "11px").text("Helsinki");
  svg.append("text").attr("text-anchor", "middle").attr("y", 10).attr("fill", "#8a93a8").style("font-size", "11px").text("time");
  const lg = svg.append("g").attr("transform", `translate(${-114},${S2 / 2 + 10})`);
  E.forEach(([a, b], e) => {
    lg.append("rect").attr("x", e * 76).attr("y", -8).attr("width", 9).attr("height", 3).attr("fill", ERA_C[e]);
    lg.append("text").attr("class", "ax").attr("x", e * 76 + 13).attr("y", -4).text(`${a}–${String(b).slice(2)}`);
  });
  svg.on("mousemove", ev => {
    const [x, y] = d3.pointer(ev); let a = Math.atan2(y, x) + Math.PI / 2; if (a < 0) a += 2 * Math.PI;
    const h = Math.floor(a / (2 * Math.PI) * 24) % 24;
    showTip(`<div class="t-d">${hh(h)}–${hh((h + 1) % 24)}</div>${E.map(([a1, b1], e) => `<div class="t-row"><span style="color:${ERA_C[e]}">■</span> ${a1}–${b1}: <b style="color:#e8ecf4">${pct(profs[e][h])}</b> of edits</div>`).join("")}`, ev);
  }).on("mouseleave", hideTip);
}

// ---------------------------------------------------------------- ridges
const ridCache = new Map();
const ridData = f => { if (!ridCache.has(f)) ridCache.set(f, getJSON(`/ridges?filter=${f}`)); return ridCache.get(f); };
const measure = (() => { const c = document.createElement("canvas").getContext("2d"); return (t, font) => { c.font = font; return c.measureText(t).width; }; })();
const fitText = (t, w, font) => { if (measure(t, font) <= w) return t; while (t.length > 3 && measure(t + "…", font) > w) t = t.slice(0, -1); return t + "…"; };

let ridTok = 0;
async function drawRidges() {
  const tok = ++ridTok, f = S.filter;
  const R = await ridData(f);
  if (tok !== ridTok) return;
  const NM = R.months, mDate = j => new Date(Date.UTC(2003, j, 1));
  const win = +S.smooth;
  const smooth = a => win === 1 ? a.slice() : a.map((_, j) => { let s = 0, n = 0; for (let k = j - Math.floor((win - 1) / 2); k <= j + Math.floor(win / 2); k++) if (k >= 0 && k < NM) { s += a[k]; n++; } return s / n; });
  let cats = R.cats.map(c => ({ ...c, tot: d3.sum(c.series.n) })).filter(c => c.tot > 0);
  cats.sort(S.rank === "edits" ? (a, b) => b.tot - a.tot : (a, b) => b.articles - a.articles || b.tot - a.tot);
  cats = cats.slice(0, +S.ridges);
  for (const c of cats) { c.sm = smooth(c.series.n); c.pk = d3.maxIndex(c.series.n); c.smax = d3.max(c.sm) || 1; }
  if (S.order === "peak") cats.sort((a, b) => a.pk - b.pk);
  const gmax = d3.max(cats, c => c.smax);
  const svgEl = $("#ridgeSvg"), W = svgEl.parentNode.clientWidth, narrow = W < 640;
  const LW = narrow ? 112 : 260, step = narrow ? 24 : 31, amp = step * (narrow ? 1.7 : 1.9), top = amp + 14, PR = 14;
  const H = top + step * (cats.length - 1) + 34;
  const x = d3.scaleLinear([0, NM - 1], [LW, W - PR]);
  const svg = d3.select(svgEl).attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);
  svg.selectAll("*").remove();
  const grid = svg.append("g").attr("class", "grid");
  for (let y = 2004; y <= Y_END; y++) {
    const xx = x((y - 2003) * 12);
    grid.append("line").attr("x1", xx).attr("x2", xx).attr("y1", 4).attr("y2", H - 22);
    if (y % (narrow ? 4 : 2) === 0) grid.append("text").attr("class", "ax").attr("x", xx).attr("y", H - 8).attr("text-anchor", "middle").text(y);
  }
  const area = d3.area().curve(d3.curveMonotoneX);
  const labFont = "12.5px 'Instrument Sans'", placed = [], marks = [];
  cats.forEach((c, i) => {
    const base = top + i * step, sc = S.rscale === "own" ? c.smax : gmax;
    c.base = base; c.sc = sc;
    const col = d3.color(heat(0.3 + 0.68 * c.pk / (NM - 1)));
    const fill = d3.interpolateRgb("#07080d", col.formatHex())(0.2);
    const g = svg.append("g").attr("class", "ridge");
    const pts = c.sm.map((v, j) => [x(j), base - amp * v / sc]);
    g.append("path").attr("d", area.x(d => d[0]).y0(base).y1(d => d[1])(pts)).attr("fill", fill).attr("fill-opacity", .97);
    g.append("path").attr("d", d3.line().curve(d3.curveMonotoneX)(pts)).attr("fill", "none").attr("stroke", col.formatHex()).attr("stroke-width", 1.4);
    g.append("line").attr("x1", LW).attr("x2", W - PR).attr("y1", base).attr("y2", base).attr("stroke", col.formatHex()).attr("stroke-opacity", .35);
    g.append("text").attr("class", "clab").attr("x", LW - 10).attr("y", base - (narrow ? 3 : 7)).attr("text-anchor", "end")
      .text(fitText(c.category, LW - 14, narrow ? "11px 'Instrument Sans'" : labFont)).style("font-size", narrow ? "11px" : null)
      .append("title").text(c.category);
    if (!narrow) g.append("text").attr("class", "cstat").attr("x", LW - 10).attr("y", base + 5).attr("text-anchor", "end")
      .text(`${fmt(c.articles)} articles · ${si(c.tot)} edits`);
    // label the biggest month with the article that drove it
    const px = x(c.pk), py = base - amp * c.sm[c.pk] / sc;
    const mk = { px, py, lab: null }; marks.push(mk);
    const tp = c.series.tp[c.pk], tn = c.series.tn[c.pk];
    const name = tn === 1 ? `${fmt(c.series.n[c.pk])} articles, one edit each` : fitText(R.titles[tp] ?? String(tp), narrow ? 120 : 230, "11px 'Instrument Sans'");
    const meta = `${tn === 1 ? "" : ` ×${tn}`} · ${fMonth(mDate(c.pk))}`;
    const lw = measure(name, "11px 'Instrument Sans'") + measure(meta, "10px 'JetBrains Mono'") + 4;
    // place the label right or left of the peak, whichever doesn't collide with labels already drawn
    let box = null;
    for (const side of (px > W - lw - 20 ? [-1] : [1, -1])) {
      const x0 = side > 0 ? px + 7 : px - 7 - lw, b = { x0, x1: x0 + lw, y0: py - 14, y1: py };
      if (x0 >= LW - 4 && !placed.some(q => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0)) { box = { ...b, side }; break; }
    }
    if (box) { placed.push(box); mk.lab = { box, name, meta }; }
  });
  // peak dots and labels go on top of every ridge, so lower ridges can't paint over them
  const top_ = svg.append("g").attr("pointer-events", "none");
  for (const { px, py, lab } of marks) {
    top_.append("circle").attr("cx", px).attr("cy", py).attr("r", 2.6).attr("fill", "#fff");
    if (!lab) continue;
    const t = top_.append("text").attr("class", "plab").attr("x", lab.box.side > 0 ? px + 7 : px - 7).attr("y", py - 3).attr("text-anchor", lab.box.side > 0 ? "start" : "end");
    t.append("tspan").text(lab.name);
    t.append("tspan").attr("class", "m").text(lab.meta);
  }
  // hover: crosshair + tooltip
  const cross = svg.append("g").attr("pointer-events", "none").style("display", "none");
  cross.append("line").attr("y1", 4).attr("y2", H - 22).attr("stroke", "rgba(255,255,255,.35)").attr("stroke-dasharray", "2 3");
  const dot = cross.append("circle").attr("r", 3.5).attr("fill", "none").attr("stroke", "#fff").attr("stroke-width", 1.5);
  const at = ev => {
    const [mx, my] = d3.pointer(ev);
    if (mx < LW) return null;
    const j = Math.max(0, Math.min(NM - 1, Math.round(x.invert(mx))));
    const i = Math.max(0, Math.min(cats.length - 1, Math.ceil((my - top) / step - 0.15)));
    return { j, c: cats[i] };
  };
  svg.append("rect").attr("x", LW).attr("y", 0).attr("width", W - LW).attr("height", H).attr("fill", "transparent")
    .on("mousemove", ev => {
      const h = at(ev); if (!h) return hideTip();
      const { j, c } = h, v = c.series.n[j];
      cross.style("display", null).select("line").attr("x1", x(j)).attr("x2", x(j));
      dot.attr("cx", x(j)).attr("cy", c.base - amp * c.sm[j] / c.sc);
      svg.selectAll(".ridge").classed("dim", (d, k) => cats[k] !== c);
      const tp = c.series.tp[j];
      showTip(`<div class="t-d">${esc(c.category)}</div><div class="t-n">${fmt(v)}<small> edits in ${fMonth(mDate(j))} by ${FTEXT[f]}</small></div>${win > 1 ? `<div class="t-row">${win}-month average: ${fmt(Math.round(c.sm[j]))}</div>` : ""}${tp ? `<div class="t-u">Most edited: <b>${esc(R.titles[tp])}</b> <span class="mute">×${c.series.tn[j]}</span></div>` : ""}<div class="t-hint">${fmt(c.articles)} articles · peak ${fMonth(mDate(c.pk))} · click to open the article</div>`, ev);
    })
    .on("mouseleave", () => { hideTip(); cross.style("display", "none"); svg.selectAll(".ridge").classed("dim", false); })
    .on("click", ev => { const h = at(ev); const tp = h && h.c.series.tp[h.j]; if (tp) window.open(wpLink(tp), "_blank", "noopener"); })
    .style("cursor", "pointer");
  const sel = S.rank === "edits" ? `the ${cats.length} categories with the most edits by ${FTEXT[f]}` : `the ${cats.length} categories with the most articles`;
  $("#ridgeLegend").innerHTML = `<span>${sel} · height: ${S.rscale === "own" ? "each ridge scaled to its own peak" : "one shared scale"} · colour = when the ridge peaked</span><div class="gbar"><canvas width="220" height="10"></canvas><div class="ticks"><span style="left:0%;transform:none">2003</span><span style="left:50%">2015</span><span style="left:100%;transform:translateX(-100%)">2026</span></div></div>`;
  const cx = $("#ridgeLegend canvas").getContext("2d");
  for (let i = 0; i < 220; i++) { cx.fillStyle = heat(0.3 + 0.68 * i / 219); cx.fillRect(i, 0, 1, 10); }
  if (!$("#sqlBody").dataset.rid) { $("#sqlBody").dataset.rid = 1; renderSQL(); }
  lastRidSQL = R.sql;
}
let lastRidSQL = "";

// ---------------------------------------------------------------- day drawer
const drawer = $("#drawer");
let dayTok = 0, lastDay = null;
async function openDay(iso) {
  if (!iso) return;
  hideTip();
  const i = idxOf(iso); if (i < 0 || i >= ND) return;
  S.day = iso; syncURL(); redrawCal();
  const tok = ++dayTok;
  drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
  const d = new Date(iso + "T00:00:00Z");
  drawer.innerHTML = dayHead(d) + `<p class="mute">Reading the day from <span class="mono">revision</span>…</p>`;
  wireHead();
  const [D, lab] = await Promise.all([getJSON(`/day/${iso}?filter=${S.filter}`), dayTop(iso)]);
  if (tok !== dayTok) return;
  lastDay = D;
  renderDay(D, lab, d);
  renderSQL();
}
function closeDay() { drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true"); S.day = null; syncURL(); redrawCal(); }
function redrawCal() { if (S.layout === "years") drawStrips(); else drawWeeks(); }
function stepDay(k) { if (!S.day) return; const i = idxOf(S.day) + k; if (i >= 0 && i < ND) openDay(isoOf(i)); }
const dayHead = d => `<div class="dh"><button class="iconbtn" data-a="prev" title="Previous day (←)">‹</button><div class="t"><h2>${fDayL(d)}</h2><div class="dsub">Helsinki day · ${FTEXT[S.filter]}</div></div><button class="iconbtn" data-a="next" title="Next day (→)">›</button><button class="iconbtn" data-a="close" title="Close (Esc)">×</button></div>`;
function wireHead() {
  drawer.querySelector('[data-a="prev"]').onclick = () => stepDay(-1);
  drawer.querySelector('[data-a="next"]').onclick = () => stepDay(1);
  drawer.querySelector('[data-a="close"]').onclick = closeDay;
}
function renderDay(D, lab, d) {
  const kindOf = e => e.kind;
  const maxP = D.pages[0]?.n || 1, maxU = D.users[0]?.n || 1;
  const drv = lab && lab.driver;
  let h = dayHead(d);
  h += `<div class="stats4"><div><b>${fmt(D.total)}</b><span>edits</span></div><div><b>${fmt(D.npages)}</b><span>articles</span></div><div><b>${fmt(D.nusers)}</b><span>editors</span></div><div><b>${fmt(D.reverts)}</b><span>reverts</span></div></div>`;
  if (!D.total) {
    h += `<p class="mute">No edits by ${FTEXT[S.filter]} on this day.</p>`;
  } else {
    if (drv) h += `<div class="drive${isBot(drv.user) ? "" : " h"}"><b>${esc(drv.user)}</b> made ${fmt(drv.n)} of the ${fmt(lab.total)} edits (${pct(drv.n / lab.total)})${noteOK(drv.note) ? ` — their most frequent edit summary: “${esc(plainNote(drv.note))}”` : ""}.</div>`;
    h += `<h3>Through the day</h3><svg class="hours"></svg>`;
    h += `<h3>Who</h3><div class="lst">${D.users.map(u => `<div class="li"><span class="bar" style="width:${u.n / maxU * 100}%"></span><span class="nm"><span style="color:${KC[u.kind]}">●</span> ${esc(u.user || "(hidden)")}</span><span class="v">${fmt(u.n)}</span></div>`).join("")}${D.nusers > D.users.length ? `<div class="more">+ ${fmt(D.nusers - D.users.length)} more editors</div>` : ""}</div>`;
    h += `<h3>What</h3><div class="lst">${D.pages.slice(0, 14).map(p => `<div class="li"><span class="bar" style="width:${p.n / maxP * 100}%"></span><span class="nm"><a href="${wpLink(p.page_id)}" target="_blank" rel="noopener">${esc(p.title)}</a></span><span class="v">×${p.n} · <span class="${p.delta >= 0 ? "pos" : "neg"}">${p.delta >= 0 ? "+" : "−"}${fmt(Math.abs(p.delta))}</span>${p.reverts ? `<span class="rv">${p.reverts} rv</span>` : ""}</span></div>`).join("")}${D.npages > 14 ? `<div class="more">+ ${fmt(D.npages - 14)} more articles</div>` : ""}</div>`;
    h += `<h3>${esc(D.pages[0].title)}, before and after · <span class="mono">FOR SYSTEM_TIME AS OF</span></h3>` + asofHTML(D);
    h += `<h3>Edit log${D.total > D.edits.length ? ` <span class="mono" style="color:var(--faint)">first ${D.edits.length} of ${fmt(D.total)}</span>` : ""}</h3><div class="log">${D.edits.map(e => `<div class="e"><span class="tm">${e.local}</span><div class="w"><a href="${oldLink(e.rev_id)}" target="_blank" rel="noopener">${esc(e.title)}</a>${e.is_revert ? `<span class="rv">revert</span>` : ""} <span style="color:${KC[kindOf(e)]}">${esc(e.user || "")}</span><div class="c" title="${esc(e.comment || "")}">${esc(plainNote(e.comment))}</div></div><span class="dl" style="color:${(e.delta || 0) >= 0 ? "var(--k2)" : "var(--revert)"}">${(e.delta || 0) >= 0 ? "+" : "−"}${fmt(Math.abs(e.delta || 0))}</span></div>`).join("")}</div>`;
  }
  h += `<details><summary>The SQL for this day (${D.ms} ms${D.asof?.ms != null ? ` + ${D.asof.ms} ms` : ""})</summary><pre class="sql">${hl(D.sql)}</pre>${D.asof?.sql ? `<pre class="sql" style="margin-top:6px">${hl(D.asof.sql)}</pre>` : ""}</details><div class="dkeys">← → previous / next day · Esc closes</div>`;
  drawer.innerHTML = h;
  wireHead();
  const hs = drawer.querySelector("svg.hours");
  if (hs) {
    const W = hs.clientWidth || 420, H = 70;
    const s = d3.select(hs).attr("viewBox", `0 0 ${W} ${H}`).attr("height", H).style("width", "100%").style("display", "block");
    const mx = d3.max(D.hours, r => d3.sum(r)) || 1, bw = W / 24;
    const y = d3.scaleLinear([0, mx], [0, H - 16]);
    D.hours.forEach((r, hr) => {
      let acc = 0;
      r.forEach((n, k) => { if (!n) return; s.append("rect").attr("x", hr * bw + 1).attr("width", bw - 2).attr("y", H - 14 - y(acc + n)).attr("height", y(n)).attr("fill", KC[k]).attr("rx", 1); acc += n; });
      s.append("rect").attr("x", hr * bw).attr("width", bw).attr("y", 0).attr("height", H - 12).attr("fill", "transparent")
        .on("mousemove", ev => showTip(`<div class="t-d">${hh(hr)}–${hh((hr + 1) % 24)}</div>${r.map((n, k) => n ? `<div class="t-row"><span style="color:${KC[k]}">●</span> ${fmt(n)} ${KN[k]}</div>` : "").join("") || `<div class="t-row">no edits</div>`}`, ev))
        .on("mouseleave", hideTip);
    });
    [0, 6, 12, 18].forEach(hr => s.append("text").attr("class", "ax").attr("x", hr * bw + 1).attr("y", H - 2).text(hh(hr)));
  }
}
function asofHTML(D) {
  const a = D.asof;
  if (!a || !a.has_text) return `<div class="asof mute">The full text of this article isn't in the database (only its edit metadata), so there is nothing to compare.</div>`;
  const dl = a.after.len - (a.before?.len ?? 0);
  let h = `<div class="asof"><div class="lenrow">${a.before ? `<a href="${oldLink(a.before.rev_id)}" target="_blank" rel="noopener">start of day</a> <b>${fmt(a.before.len)}</b> chars` : `<span>did not exist at the start of the day</span>`} → <a href="${oldLink(a.after.rev_id)}" target="_blank" rel="noopener">end of day</a> <b>${fmt(a.after.len)}</b> chars <span style="color:${dl >= 0 ? "var(--k2)" : "var(--revert)"}">(${dl >= 0 ? "+" : "−"}${fmt(Math.abs(dl))})</span></div>`;
  const c = a.counts;
  if (a.changes.length) {
    const parts = [c.edited && `${fmt(c.edited)} paragraph${c.edited === 1 ? "" : "s"} rewritten`, c.added && `${fmt(c.added)} new`, c.removed && `${fmt(c.removed)} removed`].filter(Boolean);
    h += `<div class="lenrow" style="margin-top:6px">${parts.join(" · ")}${a.changes.length < c.edited + c.added + c.removed ? ` — first ${a.changes.length} shown` : ""}</div>`;
    h += a.changes.map(ch => ch.type === "edit"
      ? `<blockquote class="ed">${ch.diff.map(([op, t]) => op === "=" ? esc(t) : op === "…" ? `<span class="el">…</span>` : `<span class="${op === "+" ? "ins" : "del"}">${esc(t)}</span>`).join(" ")}</blockquote>`
      : ch.type === "add" ? `<blockquote>${esc(ch.text)}${ch.text.length >= 420 ? "…" : ""}</blockquote>`
      : `<blockquote class="rm">${esc(ch.text)}${ch.text.length >= 300 ? "…" : ""}</blockquote>`).join("");
  } else {
    h += `<div class="lenrow" style="margin-top:6px">No paragraph of readable text changed (markup, templates, links or categories only, or the edits cancelled out).</div>`;
    if (a.lead) h += `<blockquote style="border-left-color:var(--faint);background:none">${esc(a.lead)}${a.lead.length >= 420 ? "…" : ""}</blockquote>`;
  }
  return h + `</div>`;
}
document.addEventListener("keydown", e => {
  if (!drawer.classList.contains("open") || e.target.closest("input,select,textarea")) return;
  if (e.key === "Escape") closeDay();
  if (e.key === "ArrowLeft") { e.preventDefault(); stepDay(-1); }
  if (e.key === "ArrowRight") { e.preventDefault(); stepDay(1); }
});

// ---------------------------------------------------------------- SQL box
function hl(sql) {
  return esc(sql).replace(/(--[^\n]*)/g, '<span class="cm">$1</span>')
    .replace(/\b(SELECT|FROM|WHERE|AND|OR|ORDER BY|GROUP BY|JOIN|IN|AS OF|FOR SYSTEM_TIME|TIMESTAMP|LIMIT|SUM|COUNT)\b(?![^<]*<\/span>)/g, '<span class="kw">$1</span>');
}
function renderSQL() {
  const ex = lastDay;
  $("#sqlBody").innerHTML = `
    <h3>1 · Precompute (scripts/build_heartbeat.py) and what the page reads</h3><pre class="sql">${hl(CAL.sql)}</pre>
    <h3>2 · Around the clock</h3><pre class="sql">${hl(CLK.sql)}</pre>
    <h3>3 · Ridges</h3><pre class="sql">${hl(lastRidSQL || "")}</pre>
    <h3>4 · One day, live from revision${ex ? ` (${ex.date}, ${ex.ms} ms)` : ""}</h3><pre class="sql">${ex ? hl(ex.sql) : "Open a day on the calendar to see its live query."}</pre>
    <h3>5 · The day's most-edited article as it stood at midnight, from the system-versioned table${ex?.asof?.ms != null ? ` (${ex.asof.ms} ms for before + after)` : ex?.asof && !ex.asof.has_text ? " (this article's text isn't loaded, so the query returns no row)" : ""}</h3><pre class="sql">${ex?.asof?.sql ? hl(ex.asof.sql) : hl(`SELECT rev_id, user, len, text\nFROM article FOR SYSTEM_TIME AS OF TIMESTAMP '<end of the Helsinki day, in UTC>'\nWHERE page_id = <the day's most-edited article>`)}</pre>`;
}
$("#sqlBox").addEventListener("toggle", async () => {
  if ($("#sqlBox").open && !lastDay) { lastDay = await getJSON(`/day/${PEAK_ALL.top[0].date}?filter=all`); renderSQL(); }
});

// ---------------------------------------------------------------- wire up
const FILTER_OPTS = Object.entries(FCHIP).map(([v, l]) => [v, l, { all: "#e8ecf4", human: "#c3c9d6", reg: KC[0], anon: KC[1], bot: KC[2] }[v]]);
function onFilter(reopen = true) { syncURL(); drawCalendar(); drawClock(); drawRidges(); if (reopen && S.day) openDay(S.day); }
chips($("#filters"), FILTER_OPTS, "filter", onFilter);
chips($("#metricChips"), Object.entries({ n: "Edits", reverts: "Reverts", added: "Bytes added", removed: "Bytes removed" }), "metric", drawCalendar);
chips($("#scaleChips"), [["log", "Log"], ["linear", "Linear"]], "scale", drawCalendar);
chips($("#layoutChips"), [["years", "Year rows"], ["weeks", "Week grid"]], "layout", drawCalendar);
chips($("#cviewChips"), [["eras", "Three eras"], ["years", "Every year"], ["diff", "Difference"]], "clock", drawClock);
chips($("#cvalChips"), [["share", "Share"], ["count", "Edits"]], "cval", drawClock);
chips($("#rankChips"), [["edits", "Most edits"], ["articles", "Most articles"]], "rank", drawRidges);
chips($("#nrChips"), [["12", "12"], ["20", "20"], ["30", "30"]], "ridges", drawRidges);
chips($("#orderChips"), [["size", "Size"], ["peak", "Peak date"]], "order", drawRidges);
chips($("#rscaleChips"), [["own", "Own peak"], ["shared", "Shared"]], "rscale", drawRidges);
chips($("#smoothChips"), [["1", "None"], ["3", "3 mo"], ["12", "12 mo"]], "smooth", drawRidges);

$("#ledeN").textContent = fmt(d3.sum(series("all", "n")));
$("#ledeSpan").textContent = `February 2003 to ${d3.utcFormat("%B %Y")(new Date(LAST + "T00:00:00Z"))}`;
buildStrips(); buildWeeks();
drawPulse(); findings(); drawCalendar(); drawClock(); drawRidges();
$("#loading").classList.add("gone");
if (S.day) openDay(S.day);

// busiest days for people (bots excluded): one-click entry points into the day view
getJSON("/peaks?filter=human").then(P => {
  $("#tryRow").innerHTML = `<span class="lab">Busiest days for people</span>` + P.top.slice(0, 7).map(t => {
    const d = new Date(t.date + "T00:00:00Z");
    const what = t.driver ? `${esc(t.driver.user)} ${pct(t.driver.n / t.total)}` : t.pages[0] ? esc(t.pages[0].title) : "";
    return `<button class="chip" data-day="${t.date}" title="${fmt(t.n)} edits by people"><span class="mono">${fShort(d)} ${d.getUTCFullYear()}</span> · ${fmt(t.n)} · ${what}</button>`;
  }).join("");
  $("#tryRow").onclick = e => { const b = e.target.closest("[data-day]"); if (b) { S.filter = "human"; chips($("#filters"), FILTER_OPTS, "filter", onFilter); onFilter(false); openDay(b.dataset.day); } };
});

let rz, lastW = $("main").clientWidth;
new ResizeObserver(() => {
  const w = $("main").clientWidth; if (w === lastW) return; lastW = w;
  clearTimeout(rz); rz = setTimeout(() => { drawPulse(); drawCalendar(); drawClock(); drawRidges(); }, 120);
}).observe($("main"));
