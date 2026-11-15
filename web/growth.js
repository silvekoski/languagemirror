// Growing Tree: the category tree under "Suomen historia" as a zoomable sunburst over time.
// Sizes per category and quarter come from /api/growth/tree (precomputed from all 862k versions);
// the side panel asks MariaDB for the biggest articles as of a year end, and the system-versioned
// `article` table for what an article said back then.
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const stage = $("stage");
stage.insertAdjacentHTML("beforeend", `<div class="loading" id="loading">Growing the tree…</div>`);

const T = await (await fetch("/api/growth/tree")).json();
$("loading").remove();
const F = T.frames, NQ = F.length, LASTQ = NQ - 1, CATS = T.cats, C = CATS.length;
const Y0 = F[0].y, Y1 = F[LASTQ].y;

// English glosses for the root and its 43 main branches (our translation of the Finnish category names)
const GLOSS = {
  "Suomen historia": "History of Finland", "Entiset ravintolat Suomessa": "Former restaurants in Finland",
  "Entiset suomalaiset järjestöt": "Former Finnish organisations", "Historialliset alueet Suomessa": "Historical regions of Finland",
  "Inkeri": "Ingria", "Itsenäisen Suomen historia": "History of independent Finland", "Karjalaiset (kansa)": "Karelians (people)",
  "Karjalan historia": "History of Karelia", "Kirjat Suomen historiasta": "Books on Finnish history",
  "Kristinuskon historia Suomessa": "History of Christianity in Finland", "Kustavilainen aika": "Gustavian era",
  "Luettelot Suomen historiasta": "Lists on Finnish history", "Luovutetut alueet": "Ceded territories",
  "Monarkia Suomessa": "Monarchy in Finland", "Onnettomuudet Suomessa": "Accidents in Finland",
  "Ruotsin vallan aika Suomessa": "Swedish rule in Finland", "Skandaalit Suomessa": "Scandals in Finland",
  "Suomalaiset katoamistapaukset": "Finnish disappearances", "Suomalaiset lakkautetut lehdet": "Defunct Finnish periodicals",
  "Suomen aarrekätköt": "Treasure hoards of Finland", "Suomen arkistot": "Archives of Finland",
  "Suomen asutus- ja yhteiskuntahistoria": "Settlement and social history", "Suomen entiset elokuvateatterit": "Former cinemas of Finland",
  "Suomen entiset rakennukset ja rakennelmat": "Former buildings and structures", "Suomen entiset saaret": "Former islands of Finland",
  "Suomen esihistoria": "Prehistory of Finland", "Suomen hallintohistoria": "Administrative history",
  "Suomen historia maakunnittain": "History by region", "Suomen historian verkkosivustot": "Websites on Finnish history",
  "Suomen kaupunkien historia": "History of Finnish towns", "Suomen keskiaika": "Finnish Middle Ages",
  "Suomen kulttuurihistoria": "Cultural history", "Suomen liikenteen historia": "Transport history",
  "Suomen muinaisjäännökset": "Ancient monuments", "Suomen oikeushistoria": "Legal history",
  "Suomen paikallishistoria": "Local history", "Suomen poliittinen historia": "Political history",
  "Suomen rikoshistoria": "Crime history", "Suomen sotahistoria": "Military history",
  "Suomen suuriruhtinaskunta": "Grand Duchy of Finland", "Suomen taloushistoria": "Economic history",
  "Suomen ulkopolitiikka": "Foreign policy of Finland", "Suomen urheilun historia": "History of Finnish sport",
  "Toteutumattomat suunnitelmat ja hankkeet Suomessa": "Unrealised plans and projects",
};

// ---------- tree structure and per-quarter totals ----------
const parent = new Int32Array(C), depth = new Uint8Array(C), kids = Array.from({ length: C }, () => []);
for (const c of CATS) { parent[c.cat_id] = c.parent_id ?? -1; depth[c.cat_id] = c.depth; }
for (let c = 1; c < C; c++) kids[parent[c]].push(c);           // ids are in BFS order: parent < child
const branchOf = c => { while (c > 0 && depth[c] > 1) c = parent[c]; return c; };
const MEAS = ["b", "a", "e"], own = {}, tot = {}, maxOf = {};
for (const m of MEAS) {
  const o = new Float64Array(C * NQ);
  T.own[m].forEach((arr, c) => o.set(arr, c * NQ));
  const t = Float64Array.from(o);
  for (let c = C - 1; c > 0; c--) { const p = parent[c] * NQ, q = c * NQ; for (let k = 0; k < NQ; k++) t[p + k] += t[q + k]; }
  own[m] = o; tot[m] = t;
  const mx = new Float64Array(C);
  for (let c = 0; c < C; c++) { let v = 0; for (let k = 0; k < NQ; k++) v = Math.max(v, t[c * NQ + k]); mx[c] = v; }
  maxOf[m] = mx;
}
const at = (m, c, t) => {                     // value at fractional frame t (linear between quarter ends)
  if (t <= 0) return tot[m][c * NQ];
  const k0 = Math.min(Math.floor(t), LASTQ), k1 = Math.min(k0 + 1, LASTQ), f = t - k0, a = tot[m][c * NQ + k0];
  return f > 0 ? a + (tot[m][c * NQ + k1] - a) * f : a;
};

// ---------- formatting ----------
const fmtInt = n => Math.round(n).toLocaleString("en-US");
const fmtBytes = b => b >= 1e7 ? `${(b / 1e6).toFixed(0)} MB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB`
  : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${Math.round(b)} B`;
const MD = {
  b: { name: "Text", fmt: fmtBytes, long: "of wikitext" },
  a: { name: "Articles", fmt: n => fmtInt(n), long: "articles" },
  e: { name: "Edits", fmt: n => fmtInt(n), long: "edits so far" },
};
const pct = x => x >= 0.1 ? `${Math.round(x * 100)}%` : x >= 0.001 ? `${(x * 100).toFixed(1)}%` : "<0.1%";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateLabel(t, long = true) {
  const k = Math.round(t);
  if (Math.abs(t - k) < 1e-6) {
    const [y, mo, d] = F[k].end.slice(0, 10).split("-").map(Number);
    return long ? `${d} ${MONTHS[mo - 1]} ${y}` : `${MONTHS[mo - 1]} ${y}`;
  }
  const k0 = Math.floor(t), f = t - k0, y = F[k0].y, m = (F[k0].quarter * 3 - 1) + Math.floor(f * 3) + 1;
  return `${MONTHS[m % 12]} ${y + Math.floor(m / 12)}`;
}
const yearEndFrame = y => y >= Y1 ? LASTQ : (y - Y0) * 4 + 3;
const yearOf = t => {                         // the last year end at or before t
  const k = Math.min(LASTQ, Math.floor(t + 1e-6));
  return k === LASTQ ? Y1 : Math.max(Y0, F[k].quarter === 4 ? F[k].y : F[k].y - 1);
};

// ---------- state ----------
const qs = new URLSearchParams(location.search);
const S = {
  m: MEAS.includes(qs.get("size")) ? qs.get("size") : "b",
  color: ["branch", "growth", "density"].includes(qs.get("color")) ? qs.get("color") : "branch",
  scale: qs.get("scale") === "share" ? "share" : "grow",
  rings: qs.get("rings") !== "0", labels: qs.get("labels") !== "0",
  t: LASTQ, focus: 0, sel: 0, hover: -1, article: +qs.get("article") || null,
};
{ const y = +qs.get("year"); if (y >= Y0 && y <= Y1) S.t = yearEndFrame(y); }
{ const c = +qs.get("cat"); if (c > 0 && c < C) { S.sel = c; S.focus = kids[c].length ? c : parent[c]; } }

// ---------- colours ----------
const branches = kids[0].slice().sort((a, b) => maxOf.b[b] - maxOf.b[a]);
const HUE = new Float64Array(C);
branches.forEach((b, i) => { HUE[b] = (28 + i * 137.508) % 360; });
const branchCol = new Array(C);
for (let c = 0; c < C; c++) {
  if (c === 0) { branchCol[c] = "#3a4158"; continue; }
  const h = HUE[branchOf(c)], d = depth[c] - 1;
  branchCol[c] = d3.hcl(h, 46 - d * 7, 66 - d * 6).formatHex();
}
const growthCol = d3.scaleSequentialSqrt([0, 0.5], d3.interpolateRgbBasis(["#1f2840", "#2c5694", "#6fa8ff", "#ffd36e", "#ff6b4a"])).clamp(true);
const densityVals = [];
for (let c = 1; c < C; c++) { const b = tot.b[c * NQ + LASTQ]; if (b > 20000) densityVals.push(tot.e[c * NQ + LASTQ] / (b / 10240)); }
densityVals.sort((a, b) => a - b);
const DENS = [d3.quantile(densityVals, 0.05), d3.quantile(densityVals, 0.95)];
const densityCol = d3.scaleSequentialLog(DENS, d3.interpolateRgbBasis(["#172a2b", "#1f6b62", "#5fd4b0", "#e6fff4"])).clamp(true);
// When zoomed into a category, its children get distinct hues spread around the branch's hue
let focusColKey = -1, focusCol = null;
function catCol(c) {
  if (S.focus === 0 || c <= 0) return branchCol[c];
  if (focusColKey !== S.focus) {
    focusColKey = S.focus; focusCol = new Map();
    const base = HUE[branchOf(S.focus)] || 0, ks = ORDER[S.focus], n = ks.length;
    ks.forEach((k, i) => focusCol.set(k, n > 1 ? base - 70 + 140 * ((i * 0.618034) % 1) : base));
  }
  let a = c; while (a > 0 && parent[a] !== S.focus) a = parent[a];
  const h = focusCol.get(a);
  if (h === undefined) return branchCol[c];
  const d = depth[c] - depth[S.focus] - 1;
  return d3.hcl(h, 48 - d * 7, 68 - d * 7).formatHex();
}
function arcColor(c, t) {
  if (S.color === "branch") return catCol(c);
  if (S.color === "growth") {
    const v = at(S.m, c, t), p = at(S.m, c, Math.max(0, t - 4));
    return v > 0 ? growthCol(Math.max(0, (v - p) / v)) : "#1f2840";
  }
  const b = at("b", c, t);
  return b > 0 ? densityCol(at("e", c, t) / (b / 10240)) : "#172a2b";
}

// ---------- layout: a partition recomputed for any moment ----------
const X0 = new Float64Array(C), X1 = new Float64Array(C), VAL = new Float64Array(C);
let ORDER = [];
function sortKids() { ORDER = kids.map(ks => ks.slice().sort((a, b) => maxOf[S.m][b] - maxOf[S.m][a])); focusColKey = -1; }
sortKids();
function layout(t) {
  for (let c = 0; c < C; c++) VAL[c] = at(S.m, c, t);
  X0[0] = 0; X1[0] = 1;
  for (let c = 0; c < C; c++) {               // BFS order: parents are placed before their children
    const v = VAL[c], span = X1[c] - X0[c];
    let x = X0[c];
    for (const k of ORDER[c]) { const w = v > 0 ? VAL[k] / v * span : 0; X0[k] = x; X1[k] = x + w; x += w; }
  }
}

// ---------- sunburst on canvas ----------
const cv = $("sun"), ctx = cv.getContext("2d"), centerEl = $("center"), tip = $("tip");
let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, RMAX = 100;
const FR = [0, 0.25, 0.47, 0.665, 0.835, 1];       // ring boundaries: centre disc, then 4 rings
// The centre hole has a fixed radius; the coloured annulus around it has an area proportional to the
// size (in "Grows" mode), so the outer radius is sqrt(hole^2 + (RMAX^2 - hole^2) * share of the maximum).
const hole = () => RMAX * FR[1];
const outerR = s => Math.sqrt(hole() ** 2 + (RMAX ** 2 - hole() ** 2) * Math.max(0, s));
// how many rings the subtree under c needs (1..4): a shallow subtree is stretched so that its outer
// edge lands on the disc edge (= the focused category's annual ring), not inside it
const subDepth = new Float64Array(C).fill(0);
for (let c = C - 1; c > 0; c--) subDepth[parent[c]] = Math.max(subDepth[parent[c]], subDepth[c] + 1);
const ringsFor = c => Math.max(1, Math.min(4, subDepth[c]));
let viewDm = 4;
function rad(rd, R) {
  const h = hole();
  if (rd <= 0) return 0;
  if (rd < 1) return h * rd;
  rd = 1 + (rd - 1) * 4 / viewDm;
  if (rd >= 5) return R;
  const i = Math.floor(rd), f = rd - i, fr = FR[i] + (FR[i + 1] - FR[i]) * f;
  return h + (R - h) * (fr - FR[1]) / (1 - FR[1]);
}
function resize() {
  const r = stage.getBoundingClientRect();
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  CX = W / 2; CY = H / 2 - (W < 600 ? 0 : 8);
  RMAX = Math.max(60, Math.min(W, H) / 2 - (W < 600 ? 6 : 22));
  dirty = true;
}
const scaleFor = (c, t) => S.scale === "share" ? 1 : Math.max(0, at(S.m, c, t)) / (maxOf[S.m][c] || 1);
function targetView(t) {
  const f = S.focus;
  return { x0: X0[f], x1: X1[f], d: depth[f], s: scaleFor(f, t), dm: ringsFor(f) };
}
let view = null, zoom = null, dirty = true, drawn = [];
const lerp = (a, b, p) => a + (b - a) * p;
function zoomTo(c, select = true) {
  if (c < 0) return;
  if (select) S.sel = c;
  const f = kids[c].length ? c : Math.max(0, parent[c]);
  if (f !== S.focus) {
    zoom = { from: { ...view }, start: performance.now(), dur: 760 };
    S.focus = f;
  }
  dirty = true; panelSoon(); syncURL();
}

const labelCache = new Map();
function fitLabel(name, maxW, font) {
  const key = name + "|" + Math.round(maxW / 6) + "|" + font;
  let s = labelCache.get(key);
  if (s !== undefined) return s;
  ctx.font = font;
  s = name;
  if (ctx.measureText(s).width > maxW) {
    let lo = 0, hi = name.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(name.slice(0, mid) + "…").width <= maxW) lo = mid; else hi = mid - 1; }
    s = lo >= 7 ? name.slice(0, lo).trimEnd() + "…" : "";
  }
  labelCache.set(key, s);
  return s;
}

function ancestorsOf(c) { const a = new Set(); while (c >= 0) { a.add(c); c = parent[c]; } return a; }

function draw(now) {
  layout(S.t);
  const tv = targetView(S.t);
  if (!view) view = tv;
  if (zoom) {
    const p = Math.min(1, (now - zoom.start) / zoom.dur), e = d3.easeCubicInOut(p);
    view = { x0: lerp(zoom.from.x0, tv.x0, e), x1: lerp(zoom.from.x1, tv.x1, e), d: lerp(zoom.from.d, tv.d, e), s: lerp(zoom.from.s, tv.s, e),
             dm: lerp(zoom.from.dm ?? tv.dm, tv.dm, e) };
    if (p >= 1) zoom = null;
  } else view = tv;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const R = outerR(view.s), span = view.x1 - view.x0;
  viewDm = view.dm || 4;

  // annual rings: the size of the focused category at the end of every year (area-true radius)
  const rings = [];
  if (S.rings && S.scale === "grow" && !zoom) {
    const mx = maxOf[S.m][S.focus] || 1;
    for (let y = Y0; y <= Y1; y++) {
      const k = yearEndFrame(y), v = tot[S.m][S.focus * NQ + k], r = outerR(v / mx);
      if (v > 0) rings.push({ y, k, r });
    }
    ctx.lineWidth = 1;
    for (const g of rings) {
      const past = g.k <= S.t + 1e-6;
      ctx.beginPath(); ctx.arc(CX, CY, g.r, 0, 2 * Math.PI);
      ctx.setLineDash(past ? [] : [2, 4]);
      ctx.strokeStyle = past ? "rgba(217,176,122,.20)" : "rgba(217,176,122,.30)";
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // arcs
  drawn = [];
  const hl = S.hover >= 0 ? ancestorsOf(S.hover) : null;
  if (span > 1e-12 && view.s > 0) {
    for (let c = 1; c < C; c++) {
      const rd = depth[c] - view.d;
      if (rd <= 0.02 || rd >= 5) continue;
      if (X1[c] <= view.x0 || X0[c] >= view.x1 || X1[c] - X0[c] <= 0) continue;
      let a0 = (Math.max(X0[c], view.x0) - view.x0) / span * 2 * Math.PI;
      let a1 = (Math.min(X1[c], view.x1) - view.x0) / span * 2 * Math.PI;
      if (a1 - a0 < 0.0012) continue;
      const r0 = rad(rd, R), r1 = Math.max(r0, rad(rd + 1, R) - 1.2);
      if (r1 - r0 < 0.3) continue;
      const pad = Math.min((a1 - a0) * 0.25, 0.7 / Math.max(r1, 1));
      const alpha = rd < 1 ? rd : 1;
      ctx.globalAlpha = alpha * (hl && !hl.has(c) ? 0.38 : 1);
      ctx.fillStyle = arcColor(c, S.t);
      ctx.beginPath();
      ctx.arc(CX, CY, r1, a0 + pad - Math.PI / 2, a1 - pad - Math.PI / 2);
      ctx.arc(CX, CY, r0, a1 - pad - Math.PI / 2, a0 + pad - Math.PI / 2, true);
      ctx.closePath(); ctx.fill();
      if (c === S.sel || c === S.hover) {
        ctx.globalAlpha = 1; ctx.lineWidth = c === S.sel ? 2 : 1.4;
        ctx.strokeStyle = c === S.sel ? "#fff" : "rgba(255,255,255,.75)"; ctx.stroke();
      }
      if (rd >= 1) drawn.push({ c, a0, a1, r0, r1, rd });
    }
    ctx.globalAlpha = 1;
    // the focused category's own articles (filed directly in it) fill the rest of the first ring
    if (!zoom) {
      const f = S.focus, ks = kids[f];
      const end = ks.length ? Math.max(...ks.map(k => X1[k])) : X0[f];
      const a0 = (end - view.x0) / span * 2 * Math.PI, a1 = 2 * Math.PI;
      if (a1 - a0 > 0.02) {
        const r0 = rad(1, R), r1 = rad(2, R) - 1.2;
        ctx.beginPath();
        ctx.arc(CX, CY, r1, a0 + 0.004 - Math.PI / 2, a1 - 0.004 - Math.PI / 2);
        ctx.arc(CX, CY, r0, a1 - 0.004 - Math.PI / 2, a0 + 0.004 - Math.PI / 2, true);
        ctx.closePath();
        ctx.fillStyle = f ? arcColor(f, S.t) : "#3a4158"; ctx.globalAlpha = 0.32; ctx.fill(); ctx.globalAlpha = 1;
        ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(255,255,255,.30)"; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
        drawn.push({ c: -2, a0, a1, r0, r1, rd: 1 });
        if (S.labels && (a1 - a0) * (r0 + r1) / 2 > 90) {
          const th = (a0 + a1) / 2, rm = (r0 + r1) / 2;
          ctx.save(); ctx.translate(CX + rm * Math.sin(th), CY - rm * Math.cos(th));
          ctx.rotate(th > Math.PI / 2 && th < 1.5 * Math.PI ? th + Math.PI : th);
          ctx.font = "italic 10.5px 'Instrument Sans', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(232,235,242,.85)";
          ctx.fillText(fitLabel("articles filed directly here", (a1 - a0) * rm - 10, ctx.font), 0, 0.5);
          ctx.restore();
        }
      }
    }
  }

  // engraved year lines over the arcs, with labels on a "core sample" line straight up
  if (rings.length) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(7,8,13,.5)";
    for (const g of rings) if (g.k <= S.t + 1e-6 && g.r < R - 1) { ctx.beginPath(); ctx.arc(CX, CY, g.r, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.font = "500 10px 'JetBrains Mono', monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let lastY = -1e9;
    for (let i = rings.length - 1; i >= 0; i--) {
      const g = rings[i];
      const show = g.y === Y1 || g.y % 5 === 0 || g.y === Y0 + 1;
      if (!show) continue;
      const yy = CY - g.r;
      if (yy - lastY < 13 || g.r < hole() + 10) continue;
      lastY = yy;
      const past = g.k <= S.t + 1e-6;
      const lab = g.y === Y1 ? "Oct 2026" : String(g.y);
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(7,8,13,.85)"; ctx.strokeText(lab, CX + 5, yy + 7);
      ctx.fillStyle = past ? "rgba(240,214,170,.95)" : "rgba(217,176,122,.55)";
      ctx.fillText(lab, CX + 5, yy + 7);
      ctx.beginPath(); ctx.arc(CX, yy, 2, 0, 2 * Math.PI); ctx.fill();
    }
  }

  // labels
  if (S.labels && !zoom) {
    ctx.textBaseline = "middle";
    for (const d of drawn) {
      const { c, a0, a1, r0, r1, rd } = d;
      if (c < 0) continue;
      const rm = (r0 + r1) / 2, arcLen = (a1 - a0) * rm, ringW = r1 - r0;
      const font = rd < 1.5 ? "500 11.5px 'Instrument Sans', sans-serif" : "10.5px 'Instrument Sans', sans-serif";
      const name = depth[c] === 1 && GLOSS[CATS[c].name] ? GLOSS[CATS[c].name] : CATS[c].name;   // main branches in English
      const th = (a0 + a1) / 2;
      let text = "", rot = 0;
      if (arcLen > 56 && ringW >= 14 && (arcLen > ringW * 1.3 || rd < 1.5)) {
        text = fitLabel(name, arcLen - 10, font);
        rot = th > Math.PI / 2 && th < 1.5 * Math.PI ? th + Math.PI : th;
      } else if (arcLen >= 11 && ringW > 34) {
        text = fitLabel(name, ringW - 8, font);
        rot = th < Math.PI ? th - Math.PI / 2 : th + Math.PI / 2;
      }
      if (!text) continue;
      ctx.save();
      ctx.translate(CX + rm * Math.sin(th), CY - rm * Math.cos(th));
      ctx.rotate(rot);
      ctx.font = font; ctx.textAlign = "center";
      ctx.fillStyle = S.color === "branch" ? "rgba(8,10,16,.88)" : "rgba(240,244,250,.92)";
      if (S.color !== "branch") { ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(7,8,13,.55)"; ctx.strokeText(text, 0, 0.5); }
      ctx.fillText(text, 0, 0.5);
      ctx.restore();
    }
  }
  placeCenter(R);
}

function placeCenter(R) {
  const f = S.focus, r = Math.max(hole(), 58);
  centerEl.style.left = CX + "px"; centerEl.style.top = CY + "px";
  centerEl.style.width = centerEl.style.height = (2 * r - 8) + "px";
  centerEl.classList.toggle("out", f !== 0);
  const v = at(S.m, f, S.t), name = CATS[f].name;
  const key = [f, S.m, Math.round(S.t * 4)].join("|");
  if (centerEl.dataset.key === key) return;
  centerEl.dataset.key = key;
  centerEl.innerHTML = `<div class="cn">${esc(name)}</div>
    <div class="cv">${v > 0 ? MD[S.m].fmt(v) + (S.m === "b" ? "" : " " + MD[S.m].long.split(" ")[0]) : "not written yet"}</div>
    <div class="cu">${f !== 0 ? "↑ zoom out" : esc(GLOSS[name] || "")}</div>`;
}
centerEl.onclick = () => { if (S.focus !== 0) zoomTo(parent[S.focus]); };

// ---------- hover + click on arcs ----------
function hitTest(ev) {
  const r = cv.getBoundingClientRect(), x = ev.clientX - r.left - CX, y = ev.clientY - r.top - CY;
  const rr = Math.hypot(x, y);
  let th = Math.atan2(x, -y); if (th < 0) th += 2 * Math.PI;
  for (const d of drawn) if (rr >= d.r0 && rr <= d.r1 + 1.2 && th >= d.a0 && th <= d.a1) return d.c;
  return -1;
}
function pathOf(c) { const p = []; c = parent[c]; while (c > 0) { p.unshift(CATS[c].name); c = parent[c]; } return p; }
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 16, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 12;
  tip.style.left = Math.max(6, x) + "px"; tip.style.top = Math.max(6, y) + "px";
}
cv.addEventListener("pointermove", ev => {
  const c = hitTest(ev);
  if (c !== S.hover) { S.hover = c; dirty = true; }
  cv.style.cursor = c >= 0 || c === -2 ? "pointer" : "";
  if (c === -2) {
    const f = S.focus, o = k => own[S.m][f * NQ + k], k0 = Math.min(LASTQ, Math.floor(S.t));
    showTip(ev, `<div class="tn">Articles filed directly in <i>${esc(CATS[f].name)}</i></div>
      <div class="tv"><b>${MD[S.m].fmt(o(k0))}</b> ${S.m === "b" ? "of wikitext" : MD[S.m].long}, not in any subcategory</div>
      <div class="tp" style="margin:4px 0 0">click to open this category in the panel</div>`);
    return;
  }
  if (c < 0) { tip.hidden = true; return; }
  const v = at(S.m, c, S.t), pv = at(S.m, parent[c], S.t), all = at(S.m, 0, S.t), prev = at(S.m, c, Math.max(0, S.t - 4));
  const g = GLOSS[CATS[c].name], p = pathOf(c);
  showTip(ev, `${p.length ? `<div class="tp">${p.map(esc).join(" › ")}</div>` : ""}
    <div class="tn">${esc(CATS[c].name)}</div>${g ? `<div class="tg">${esc(g)}</div>` : ""}
    <div class="tv"><b>${MD[S.m].fmt(v)}</b> ${S.m === "b" ? "of wikitext" : MD[S.m].long} · ${pct(v / (pv || 1))} of parent · ${pct(v / (all || 1))} of all</div>
    <div class="tv">${S.t >= 4 && v > 0 ? `<span class="plus">+${pct(Math.max(0, v - prev) / (prev || v))}</span> in the 12 months to ${dateLabel(S.t, false)}` : ""}</div>
    <div class="tv">${fmtInt(at("a", c, S.t))} articles · ${fmtBytes(at("b", c, S.t))} · ${fmtInt(at("e", c, S.t))} edits</div>
    <div class="tp" style="margin:4px 0 0">${kids[c].length ? `${kids[c].length} subcategories · click to zoom in` : "click for its articles"}</div>`);
});
cv.addEventListener("pointerleave", () => { S.hover = -1; tip.hidden = true; dirty = true; });
cv.addEventListener("click", ev => {
  const c = hitTest(ev);
  if (c === -2) { tip.hidden = true; S.sel = S.focus; dirty = true; panelSoon(); syncURL(); }
  else if (c >= 0) { tip.hidden = true; zoomTo(c); }
  else {
    const r = cv.getBoundingClientRect(), d = Math.hypot(ev.clientX - r.left - CX, ev.clientY - r.top - CY);
    if (d < hole() && S.focus !== 0) zoomTo(parent[S.focus]);
  }
});

// ---------- timeline: stacked area of the main branches ----------
const tl = $("tl"), tctx = tl.getContext("2d");
let TW = 0, TH = 0, TPAD = { l: 8, r: 8, t: 6, b: 18 };
const tX = k => TPAD.l + k / LASTQ * (TW - TPAD.l - TPAD.r);
const tK = x => Math.max(0, Math.min(LASTQ, (x - TPAD.l) / (TW - TPAD.l - TPAD.r) * LASTQ));
let tlStatic = null;
function resizeTL() {
  const r = $("twrap").getBoundingClientRect();
  TW = r.width; TH = r.height;
  tl.width = Math.round(TW * DPR); tl.height = Math.round(TH * DPR);
  tlStatic = null; dirty = true;
}
function renderTLStatic() {
  const off = document.createElement("canvas"); off.width = tl.width; off.height = tl.height;
  const g = off.getContext("2d"); g.setTransform(DPR, 0, 0, DPR, 0, 0);
  const m = S.m, mx = maxOf[m][0] || 1, y = v => TH - TPAD.b - v / mx * (TH - TPAD.t - TPAD.b);
  const order = kids[0].slice().sort((a, b) => maxOf[m][b] - maxOf[m][a]);
  const base = new Float64Array(NQ);
  const layers = [...order, 0];                 // the root's own articles on top
  for (const c of layers) {
    const v = k => c === 0 ? own[m][k] : tot[m][c * NQ + k];
    g.beginPath();
    for (let k = 0; k < NQ; k++) g.lineTo(tX(k), y(base[k] + v(k)));
    for (let k = LASTQ; k >= 0; k--) g.lineTo(tX(k), y(base[k]));
    g.closePath();
    g.fillStyle = c === 0 ? "#4a5168" : branchCol[c]; g.globalAlpha = 0.9; g.fill();
    for (let k = 0; k < NQ; k++) base[k] += v(k);
  }
  g.globalAlpha = 1;
  // year ticks
  g.font = "10px 'JetBrains Mono', monospace"; g.textAlign = "center"; g.textBaseline = "alphabetic";
  const every = TW > 900 ? 1 : TW > 520 ? 2 : 4;
  for (let yr = Y0; yr <= Y1; yr++) {
    const x = tX(Math.min(LASTQ, (yr - Y0) * 4));
    g.fillStyle = "rgba(255,255,255,.07)"; g.fillRect(x, TPAD.t, 1, TH - TPAD.t - TPAD.b);
    if ((yr - Y0) % every === 0) {
      g.fillStyle = "#6b7389";
      const lx = tX(Math.min(LASTQ, (yr - Y0) * 4) + Math.min(4, LASTQ - (yr - Y0) * 4) / 2);
      g.fillText(String(yr), lx, TH - 4);
    }
  }
  // the half-way point: the first quarter end at which the tree had half of its final size
  let kh = 0; while (kh < LASTQ && tot[m][kh] < tot[m][LASTQ] / 2) kh++;
  const hx = tX(kh), hy = y(tot[m][kh]);
  g.setLineDash([2, 3]); g.strokeStyle = "rgba(240,214,170,.75)"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(hx, hy - 4); g.lineTo(hx, TPAD.t + 18); g.stroke(); g.setLineDash([]);
  g.font = "10.5px 'Instrument Sans', sans-serif"; g.textAlign = "center"; g.fillStyle = "#f0d6aa";
  g.fillText(`half of today's size reached · ${dateLabel(kh, false)}`, hx, TPAD.t + 13);
  tlStatic = off;
}
function drawTL() {
  if (!tlStatic) renderTLStatic();
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tl.width, tl.height);
  tctx.drawImage(tlStatic, 0, 0);
  tctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const x = tX(S.t);
  tctx.fillStyle = "rgba(7,8,13,.62)";             // the future is still unwritten
  tctx.fillRect(x, 0, TW - TPAD.r - x + 1, TH - TPAD.b);
  if (S.focus !== 0) {                           // the focused category as a bright line
    const m = S.m, mx = maxOf[m][0] || 1, y = v => TH - TPAD.b - v / mx * (TH - TPAD.t - TPAD.b);
    const sc = Math.max(1, Math.min(40, (maxOf[m][0] / (maxOf[m][S.focus] || 1)) * 0.45));
    tctx.beginPath();
    for (let k = 0; k < NQ; k++) tctx.lineTo(tX(k), y(tot[m][S.focus * NQ + k] * sc));
    tctx.strokeStyle = "#fff"; tctx.lineWidth = 1.5; tctx.stroke();
    const flab = `${CATS[S.focus].name}${sc > 1.05 ? ` (×${sc.toFixed(sc < 10 ? 1 : 0)})` : ""}`;
    tctx.font = "11px 'JetBrains Mono', monospace";
    const lw = tctx.measureText(`${MD[m].fmt(maxOf[m][0])} of wikitext · main branches stacked`).width;
    tctx.font = "11px 'Instrument Sans', sans-serif"; tctx.fillStyle = "#fff"; tctx.textAlign = "right";
    const clash = TPAD.l + 4 + lw + 16 + tctx.measureText(flab).width > TW - TPAD.r - 4;
    tctx.lineWidth = 3; tctx.strokeStyle = "rgba(7,8,13,.9)";
    tctx.strokeText(flab, TW - TPAD.r - 4, TPAD.t + (clash ? 26 : 11)); tctx.fillText(flab, TW - TPAD.r - 4, TPAD.t + (clash ? 26 : 11));
  }
  {
    const m = S.m, lab = `${MD[m].fmt(maxOf[m][0])}${m === "b" ? " of wikitext" : " " + MD[m].long} · main branches stacked`;
    tctx.font = "11px 'JetBrains Mono', monospace"; tctx.textAlign = "left";
    tctx.lineWidth = 3; tctx.strokeStyle = "rgba(7,8,13,.9)"; tctx.strokeText(lab, TPAD.l + 4, TPAD.t + 11);
    tctx.fillStyle = "#c3c9d6"; tctx.fillText(lab, TPAD.l + 4, TPAD.t + 11);
  }
  tctx.fillStyle = "#f0d6aa"; tctx.fillRect(x - 1, 0, 2, TH - TPAD.b + 2);
  tctx.beginPath(); tctx.arc(x, TH - TPAD.b + 2, 4.5, 0, 2 * Math.PI); tctx.fill();
}
let dragging = false;
const snapYear = k => { let best = LASTQ, bd = 1e9; for (let y = Y0; y <= Y1; y++) { const f = yearEndFrame(y), d = Math.abs(f - k); if (d < bd) { bd = d; best = f; } } return best; };
function tlPointer(ev, snap) {
  const r = tl.getBoundingClientRect(), k = tK(ev.clientX - r.left);
  setT(snap ? snapYear(k) : Math.round(k));
}
tl.addEventListener("pointerdown", ev => { dragging = true; stopPlay(); tl.setPointerCapture(ev.pointerId); tlPointer(ev, false); });
tl.addEventListener("pointermove", ev => {
  if (dragging) { tlPointer(ev, false); return; }
  const r = tl.getBoundingClientRect(), k = Math.round(tK(ev.clientX - r.left)), m = S.m;
  const top = kids[0].map(c => [c, tot[m][c * NQ + k]]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const all = tot[m][k];
  showTip(ev, `<div class="tn">${dateLabel(k)}</div><div class="tv"><b>${MD[m].fmt(all)}</b> ${m === "b" ? "of wikitext" : MD[m].long}</div>
    <ol>${top.map(([c, v]) => `<li><span class="sw" style="background:${branchCol[c]}"></span> ${esc(GLOSS[CATS[c].name] || CATS[c].name)} <span class="mute">${pct(v / (all || 1))}</span></li>`).join("")}</ol>
    <div class="tp" style="margin:4px 0 0">click or drag to travel in time</div>`);
});
tl.addEventListener("pointerup", ev => { if (dragging) { dragging = false; tlPointer(ev, true); } });
tl.addEventListener("pointerleave", () => { if (!dragging) tip.hidden = true; });

// ---------- time ----------
let playing = false, lastYear = yearOf(S.t);
const playBtn = $("play");
function setT(t) {
  S.t = Math.max(0, Math.min(LASTQ, t));
  dirty = true;
  const y = yearOf(S.t);
  if (y !== lastYear) { lastYear = y; panelSoon(); }
  syncURL();
}
function stopPlay() { playing = false; playBtn.textContent = "▶"; playBtn.setAttribute("aria-label", "Play"); }
function togglePlay() {
  if (playing) { stopPlay(); return; }
  playing = true; playBtn.textContent = "❚❚"; playBtn.setAttribute("aria-label", "Pause");
  if (S.t >= LASTQ - 1e-6) setT(0);
}
playBtn.onclick = togglePlay;
addEventListener("keydown", e => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    stopPlay();
    const ends = d3.range(Y0, Y1 + 1).map(yearEndFrame);
    const k = e.key === "ArrowRight" ? ends.find(f => f > S.t + 1e-6) : ends.findLast(f => f < S.t - 1e-6);
    if (k !== undefined) setT(k);
  }
  else if (e.key === "Escape" && S.focus !== 0) zoomTo(parent[S.focus]);
});

// ---------- left column: date, KPIs, finding, legend ----------
function updateNow() {
  $("date").textContent = dateLabel(S.t);
  const t = S.t, p = Math.max(0, t - 4);
  $("kpis").innerHTML = MEAS.map(m => {
    const v = at(m, 0, t), d = v - at(m, 0, p);
    return `<div class="kpi"><b>${MD[m].fmt(v)}</b><span>${m === "b" ? "wikitext" : m === "a" ? "articles" : "edits"}</span>
      <div class="d">${t >= 4 && d > 0 ? "+" + MD[m].fmt(d) + " /12 mo" : "&nbsp;"}</div></div>`;
  }).join("");
  const y = yearOf(t), Y = T.years.find(r => r.y === y), prev = T.years.find(r => r.y === y - 1);
  const top = Y?.top?.[0];
  $("tcap").innerHTML = Y ? `<span class="y">${y === Y1 ? "2026 to 1 Oct" : y}</span>
    <span class="g">+${fmtBytes(Y.bytes - (prev?.bytes || 0))}</span> · ${fmtInt(Y.born)} new articles · ${fmtInt(Y.edits)} edits${top ? ` · grew most: <b>${esc(top.title)}</b> <span class="g">+${fmtBytes(top.grew)}</span>` : ""}` : "";
}
function finding() {
  const ys = T.years, grow = ys.map((r, i) => [r.y, r.bytes - (i ? ys[i - 1].bytes : 0), r]).filter(r => r[0] < Y1);
  const best = grow.reduce((a, b) => b[1] > a[1] ? b : a);
  const half = tot.b[LASTQ] / 2;
  let kh = 0; while (kh < LASTQ && tot.b[kh] < half) kh++;
  const top = best[2].top[0];
  // the main branch whose share of all text grew most since 2010
  const k10 = yearEndFrame(2010);
  const riser = kids[0].map(c => [c, tot.b[c * NQ + LASTQ] / tot.b[LASTQ] - tot.b[c * NQ + k10] / tot.b[k10]]).sort((a, b) => b[1] - a[1])[0];
  const added = 1 - tot.b[kh] / tot.b[LASTQ];
  $("finding").innerHTML = `The tree is young: <b>${pct(added)}</b> of today's ${fmtBytes(tot.b[LASTQ])} was added after <b>${dateLabel(kh)}</b>.
    The busiest year was <b>${best[0]}</b> (+${fmtBytes(best[1])}); its biggest single gain was <i>${esc(top.title)}</i> (+${fmtBytes(top.grew)}).
    Since 2010, <i>${esc(GLOSS[CATS[riser[0]].name] || CATS[riser[0]].name)}</i> gained the most ground: ${pct(tot.b[riser[0] * NQ + k10] / tot.b[k10])} → ${pct(tot.b[riser[0] * NQ + LASTQ] / tot.b[LASTQ])} of all text.`;
}
function legend() {
  const L = $("legend");
  if (S.color === "branch") {
    L.innerHTML = branches.slice(0, 8).map(b => `<span style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 0 0;white-space:nowrap">
      <span class="sw" style="background:${branchCol[b]}"></span>${esc(GLOSS[CATS[b].name] || CATS[b].name)}</span>`).join("") + `<span class="mute">… ${branches.length} branches</span>`;
  } else if (S.color === "growth") {
    const st = d3.range(0, 1.01, 0.1).map(x => growthCol(x * x * 0.5)).join(",");
    L.innerHTML = `Share of each arc's ${S.m === "b" ? "text" : MD[S.m].long.split(" ")[0]} added in the 12 months before
      <div class="bar" style="background:linear-gradient(90deg,${st})"></div><div class="ends"><span>0%</span><span>10%</span><span>50%+</span></div>`;
  } else {
    const st = d3.range(0, 1.01, 0.1).map(x => densityCol(DENS[0] * (DENS[1] / DENS[0]) ** x)).join(",");
    L.innerHTML = `Edits per 10 KB of text: bulk-written (dark) vs worked over again and again (bright)
      <div class="bar" style="background:linear-gradient(90deg,${st})"></div><div class="ends"><span>${DENS[0].toFixed(1)}</span><span>${DENS[1].toFixed(0)}</span></div>`;
  }
}

// ---------- side panel ----------
let panelTimer = null, panelReq = 0;
function panelSoon() { clearTimeout(panelTimer); panelTimer = setTimeout(renderPanel, playing ? 260 : 60); }
const fiCat = name => `https://fi.wikipedia.org/wiki/Luokka:${encodeURIComponent(name.replace(/ /g, "_"))}`;

function curveSVG(c) {
  const m = S.m, w = 352, h = 92, pb = 14, pt = 14;
  const vals = Array.from({ length: NQ }, (_, k) => tot[m][c * NQ + k]), mx = Math.max(...vals) || 1;
  const x = k => k / LASTQ * w, y = v => h - pb - v / mx * (h - pb - pt);
  const area = d3.area().x((_, k) => x(k)).y0(h - pb).y1(v => y(v)).curve(d3.curveMonotoneX)(vals);
  const line = d3.line().x((_, k) => x(k)).y(v => y(v)).curve(d3.curveMonotoneX)(vals);
  // fastest year: the biggest gain between consecutive year ends
  let by = null, bg = 0;
  for (let yr = Y0 + 1; yr <= Y1 - 1; yr++) { const g = vals[yearEndFrame(yr)] - vals[yearEndFrame(yr - 1)]; if (g > bg) { bg = g; by = yr; } }
  const first = vals.findIndex(v => v > 0), cx = x(S.t), cy = y(at(m, c, S.t));
  const col = c === 0 ? "#d9b07a" : branchCol[branchOf(c)];
  const bx = by ? x(yearEndFrame(by)) : 0, byy = by ? y(vals[yearEndFrame(by)]) : 0;
  return `<svg id="curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="overflow:visible">
    <defs><linearGradient id="cg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".45"/><stop offset="1" stop-color="${col}" stop-opacity=".03"/></linearGradient></defs>
    ${d3.range(Y0, Y1 + 1, 5).map(yr => `<line x1="${x((yr - Y0) * 4)}" x2="${x((yr - Y0) * 4)}" y1="${pt}" y2="${h - pb}" stroke="rgba(255,255,255,.06)"/>
      <text x="${x((yr - Y0) * 4)}" y="${h - 2}" fill="#6b7389" font-size="9.5" font-family="JetBrains Mono" text-anchor="middle">${yr}</text>`).join("")}
    <path d="${area}" fill="url(#cg)"/><path d="${line}" fill="none" stroke="${col}" stroke-width="1.6"/>
    <rect x="${cx}" y="0" width="${Math.max(0, w - cx)}" height="${h - pb}" fill="rgba(7,8,13,.55)"/>
    <line x1="${cx}" x2="${cx}" y1="${pt - 4}" y2="${h - pb}" stroke="#f0d6aa" stroke-width="1.2"/>
    <circle cx="${cx}" cy="${cy}" r="3.5" fill="#f0d6aa"/>
    ${by ? `<circle cx="${bx}" cy="${byy}" r="2.6" fill="none" stroke="#fff" stroke-width="1.2"/>
      <text x="${Math.min(Math.max(bx, 60), w - 60)}" y="${Math.max(10, byy - 7)}" fill="#e8ecf4" font-size="10.5" font-family="Instrument Sans" text-anchor="middle">fastest year ${by}: +${MD[m].fmt(bg)}</text>` : ""}
    ${first >= 0 ? `<text x="${Math.min(x(first) + 3, w - 90)}" y="${h - pb - 4}" fill="#8a93a8" font-size="9.5" font-family="Instrument Sans">first: ${dateLabel(first, false)}</text>` : ""}
  </svg>`;
}

async function renderPanel() {
  const c = S.sel, y = yearOf(S.t), req = ++panelReq, cat = CATS[c], side = $("side");
  const crumbs = [];
  for (let a = c; a >= 0; a = parent[a]) crumbs.unshift(a);
  const v = at(S.m, c, S.t), prev = at(S.m, c, Math.max(0, S.t - 4)), all = at(S.m, 0, S.t);
  const others = cat.parents.filter(p => p !== CATS[parent[c]]?.name);
  const ks = kids[c].slice().sort((a, b) => at(S.m, b, S.t) - at(S.m, a, S.t));
  const kmax = ks.length ? at(S.m, ks[0], S.t) || 1 : 1;
  let html = `<div class="crumbs">${crumbs.map((a, i) => i < crumbs.length - 1
      ? `<a data-c="${a}">${esc(a === 0 ? "Suomen historia" : CATS[a].name)}</a><span class="s">›</span>` : "").join("")}</div>
    <h2>${esc(cat.name)}</h2>
    ${GLOSS[cat.name] ? `<div class="gloss">${esc(GLOSS[cat.name])}</div>` : ""}
    <div class="sub">${c === 0 ? "The root category" : `Depth ${depth[c]}${others.length ? ` · also filed under ${others.map(o => `<i>${esc(o)}</i>`).join(", ")} (drawn under its shortest path)` : ""}`}
      · <a href="${fiCat(cat.name)}" target="_blank" rel="noopener">fi.wikipedia ↗</a></div>
    <div class="sstats">
      <div><b>${MD[S.m].fmt(v)}</b><span>${S.m === "b" ? "wikitext" : MD[S.m].long}</span><div class="d">${S.t >= 4 && v > prev ? "+" + pct((v - prev) / (prev || v)) + " /12 mo" : "&nbsp;"}</div></div>
      <div><b>${pct(v / (all || 1))}</b><span>of the whole tree</span><div class="d">&nbsp;</div></div>
      <div><b id="pArt">…</b><span>articles, ${y === Y1 ? "1 Oct 2026" : "end of " + y}</span><div class="d" id="pArtD">&nbsp;</div></div>
    </div>
    <h3>Growth, ${Y0}–${Y1}<span class="r">${MD[S.m].name.toLowerCase()} · now: ${dateLabel(S.t, false)}</span></h3>
    ${curveSVG(c)}`;
  if (ks.length) {
    html += `<h3>Subcategories<span class="r">${ks.length} · ${dateLabel(S.t, false)}</span></h3>` + ks.slice(0, 9).map(k => {
      const kv = at(S.m, k, S.t), kp = at(S.m, k, Math.max(0, S.t - 4));
      return `<div class="rowl" data-c="${k}"><div class="t"><span class="sw" style="background:${catCol(k)}"></span><span>${esc(CATS[k].name)}</span></div>
        <div class="v">${kv > 0 ? MD[S.m].fmt(kv) : "—"}${S.t >= 4 && kv > kp && kp > 0 ? ` <span class="plus">+${pct((kv - kp) / kp)}</span>` : ""}</div>
        <div class="bar"><i style="width:${(kv / kmax * 100).toFixed(1)}%;background:${catCol(k)}"></i></div></div>`;
    }).join("") + (ks.length > 9 ? `<div class="empty">+ ${ks.length - 9} more — click the rings to explore</div>` : "");
  }
  html += `<div id="art"></div><h3>Biggest articles<span class="r">as of ${y === Y1 ? "1 Oct 2026" : "31 Dec " + y}</span></h3><div id="big"><div class="empty">Asking MariaDB…</div></div>
    <h3>Grew most in ${y}<span class="r">bytes added that year</span></h3><div id="grew"></div>
    <details id="psql"><summary>The SQL for this list</summary><pre class="sql" id="psqlPre"></pre></details>`;
  side.innerHTML = html;
  side.querySelectorAll("[data-c]").forEach(el => el.onclick = () => zoomTo(+el.dataset.c));
  if (S.article) renderArticle(S.article, y, $("art"));

  const r = await fetch(`/api/growth/category/${c}?year=${y}`).then(r => r.json());
  if (req !== panelReq) return;
  $("pArt").textContent = fmtInt(r.articles);
  $("pArtD").textContent = r.articles < r.articles_today ? `${fmtInt(r.articles_today)} today` : " ";
  const bmax = r.biggest[0]?.bytes || 1;
  const row = (a, i, mode) => `<div class="rowl" data-p="${a.page_id}">
      <div class="t"><span class="rk">${i + 1}</span><span>${esc(a.title)}</span></div>
      <div class="v">${mode === "grew" ? `<span class="plus">+${fmtBytes(a.grew)}</span>` : fmtBytes(a.bytes)}</div>
      <div class="meta" style="padding-left:23px">${a.is_new ? `<span class="new">New in ${y}</span> · ` : mode !== "grew" && a.grew > 0 ? `<span class="plus">+${fmtBytes(a.grew)}</span> that year · ` : ""}${mode === "grew" ? `${fmtBytes(a.bytes)} · ` : ""}since ${a.born} · ${fmtInt(a.edits)} edits${a.share < 0.999 ? ` · ${a.share >= 0.5 ? "½" : a.share >= 0.33 ? "⅓" : "¼"} counted here` : ""}
        · <a href="https://fi.wikipedia.org/?oldid=${a.rev_id}" target="_blank" rel="noopener" title="This exact version on Wikipedia">version ↗</a></div>
      ${mode !== "grew" ? `<div class="bar" style="margin-left:23px"><i style="width:${(a.bytes / bmax * 100).toFixed(1)}%;background:${branchCol[branchOf(c)] || "#d9b07a"}"></i></div>` : ""}
    </div>`;
  $("big").innerHTML = r.biggest.length ? r.biggest.map((a, i) => row(a, i, "big")).join("") : `<div class="empty">No articles yet at the end of ${y}.</div>`;
  $("grew").innerHTML = r.grew.length ? r.grew.map((a, i) => row(a, i, "grew")).join("") : `<div class="empty">Nothing grew in ${y}.</div>`;
  $("psqlPre").textContent = r.sql;
  updateSQL(r.sql);
  side.querySelectorAll("[data-p]").forEach(el => el.onclick = ev => {
    if (ev.target.closest("a")) return;
    const p = +el.dataset.p, open = el.nextElementSibling?.classList.contains("snap");
    side.querySelectorAll(".snap").forEach(s => s.remove());
    if (!open) { const d = document.createElement("div"); d.className = "snap"; d.textContent = "Reading the article as it stood…"; el.after(d); snapshot(p, y, d); }
  });
}

async function snapshot(p, y, el) {
  const a = await fetch(`/api/growth/article/${p}?year=${y}`).then(r => r.json());
  const when = y === Y1 ? "1 Oct 2026" : `31 Dec ${y}`;
  if (!a.has_text) {
    el.innerHTML = `<div class="src">The full text history of this article is not in the local database (only articles whose history is under 0.5 MB, plus 50 famous ones, were loaded). Its size history above comes from <code>revision</code>.</div>`;
    return;
  }
  el.innerHTML = `<div class="h">As it stood on ${when}${a.then ? ` · ${fmtBytes(a.then.len)}` : ""}</div>
    ${a.then ? `<p>${esc(a.then.intro || "(no prose paragraph yet)")}</p><div class="src">version <a href="https://fi.wikipedia.org/?oldid=${a.then.rev_id}" target="_blank" rel="noopener">${a.then.rev_id}</a> by ${esc(a.then.user)}, saved ${esc(a.then.since)} UTC</div>` : `<p class="mute">Not written yet.</p>`}
    ${a.now && a.then && a.now.rev_id !== a.then.rev_id ? `<div class="h now">Today · ${fmtBytes(a.now.len)}</div><p>${esc(a.now.intro)}</p>` : ""}
    <details><summary>FOR SYSTEM_TIME AS OF</summary><pre class="sql">${esc(a.sql)}</pre></details>`;
}

async function renderArticle(p, y, el) {
  const a = await fetch(`/api/growth/article/${p}?year=${y}`).then(r => r.json());
  if (!el.isConnected || a.error) return;
  const s = a.series, mx = Math.max(...s.map(r => r.bytes)) || 1;
  const pts = s.map(r => `${((r.y - Y0) / (Y1 - Y0) * 352).toFixed(1)},${(40 - r.bytes / mx * 34).toFixed(1)}`).join(" ");
  const cur = s.find(r => r.y === y);
  el.innerHTML = `<h3>Article<span class="r"><a data-x>clear ×</a></span></h3>
    <div class="rowl" style="cursor:default"><div class="t"><span>${esc(a.title)}</span></div><div class="v">${cur ? fmtBytes(cur.bytes) : "not yet"}</div>
      <div class="meta">in ${a.cats.map(k => `<a data-c="${k.cat_id}">${esc(k.name)}</a>`).join(", ")}</div></div>
    <svg viewBox="0 0 352 44" style="width:100%;height:44px;display:block"><polyline points="${pts}" fill="none" stroke="#d9b07a" stroke-width="1.5"/>
      <line x1="${(y - Y0) / (Y1 - Y0) * 352}" x2="${(y - Y0) / (Y1 - Y0) * 352}" y1="0" y2="44" stroke="#f0d6aa" stroke-opacity=".6"/></svg>
    <div class="snap" id="artSnap">Reading…</div>`;
  el.querySelector("[data-x]").onclick = () => { S.article = null; el.innerHTML = ""; syncURL(); };
  el.querySelectorAll("[data-c]").forEach(e => e.onclick = () => zoomTo(+e.dataset.c));
  snapshot(p, y, $("artSnap"));
}

function updateSQL(catSQL) {
  $("sqlgrid").innerHTML = `<div><h4>1 · Precompute (once): every version's size, per quarter</h4><pre class="sql">${esc(T.sql)}</pre></div>
    <div><h4>2 · Side panel: the biggest articles of a category at a year end</h4><pre class="sql">${esc(catSQL || "")}</pre>
    <h4 style="margin-top:12px">3 · What an article said then (system-versioned table)</h4><pre class="sql">SELECT rev_id, user, len, text
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP '2010-12-31 23:59:59'
WHERE page_id = 1256;   -- Talvisota, as it stood on New Year's Eve 2010</pre></div>`;
}

// ---------- search ----------
const pick = $("pick"), pickList = $("pickList"), picker = $("picker");
let sTimer = null;
pick.oninput = () => {
  clearTimeout(sTimer);
  const q = pick.value.trim().toLowerCase();
  if (q.length < 2) { picker.classList.remove("open"); return; }
  const cats = [];
  for (let c = 0; c < C && cats.length < 40; c++) {
    const n = CATS[c].name.toLowerCase(), g = (GLOSS[CATS[c].name] || "").toLowerCase();
    if (n.includes(q) || g.includes(q)) cats.push(c);
  }
  cats.sort((a, b) => maxOf.b[b] - maxOf.b[a]);
  const catHTML = cats.slice(0, 6).map(c => `<div class="item" data-c="${c}"><span class="sw" style="background:${branchCol[c]}"></span>${esc(CATS[c].name)}<span class="n">${fmtBytes(tot.b[c * NQ + LASTQ])}</span></div>`).join("");
  pickList.innerHTML = (catHTML ? `<div class="grp">Categories</div>${catHTML}` : "") + `<div class="grp">Articles</div><div class="empty">searching…</div>`;
  picker.classList.add("open"); bindPick();
  sTimer = setTimeout(async () => {
    const r = await fetch(`/api/growth/search?q=${encodeURIComponent(pick.value.trim())}`).then(r => r.json());
    const art = r.articles.map(a => `<div class="item" data-a="${a.page_id}" data-ac="${a.cats[0] ?? ""}">${esc(a.title)}<span class="n">${fmtBytes(a.bytes)}</span></div>`).join("");
    pickList.innerHTML = (catHTML ? `<div class="grp">Categories</div>${catHTML}` : "") + `<div class="grp">Articles</div>` + (art || `<div class="empty">no article titles match</div>`);
    bindPick();
  }, 180);
};
function bindPick() {
  pickList.querySelectorAll(".item").forEach(el => el.onclick = () => {
    picker.classList.remove("open"); pick.value = "";
    if (el.dataset.c) zoomTo(+el.dataset.c);
    else { S.article = +el.dataset.a; const c = +el.dataset.ac; zoomTo(Number.isFinite(c) && el.dataset.ac !== "" ? c : 0); panelSoon(); }
  });
}
addEventListener("click", e => { if (!picker.contains(e.target)) picker.classList.remove("open"); });

// ---------- controls ----------
document.querySelectorAll(".seg").forEach(seg => {
  const key = seg.dataset.key, cur = key === "size" ? S.m : S[key];
  seg.querySelectorAll(".chip").forEach(b => {
    b.classList.toggle("on", b.dataset.v === cur);
    b.onclick = () => {
      seg.querySelectorAll(".chip").forEach(x => x.classList.toggle("on", x === b));
      if (key === "size") { S.m = b.dataset.v; sortKids(); tlStatic = null; labelCache.clear(); panelSoon(); }
      else S[key] = b.dataset.v;
      legend(); dirty = true; syncURL();
    };
  });
});
$("ringsBtn").classList.toggle("on", S.rings);
$("labelsBtn").classList.toggle("on", S.labels);
$("ringsBtn").onclick = e => { S.rings = !S.rings; e.target.classList.toggle("on", S.rings); dirty = true; syncURL(); };
$("labelsBtn").onclick = e => { S.labels = !S.labels; e.target.classList.toggle("on", S.labels); dirty = true; syncURL(); };

let urlTimer = null;
function syncURL() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const p = new URLSearchParams();
    if (S.t !== LASTQ) p.set("year", yearOf(S.t));
    if (S.sel) p.set("cat", S.sel);
    if (S.m !== "b") p.set("size", S.m);
    if (S.color !== "branch") p.set("color", S.color);
    if (S.scale !== "grow") p.set("scale", S.scale);
    if (!S.rings) p.set("rings", "0");
    if (!S.labels) p.set("labels", "0");
    if (S.article) p.set("article", S.article);
    history.replaceState(null, "", p.toString() ? "?" + p : location.pathname);
  }, 300);
}

// ---------- loop ----------
new ResizeObserver(() => { resize(); resizeTL(); }).observe(stage);
new ResizeObserver(() => resizeTL()).observe($("twrap"));
resize(); resizeTL(); legend(); finding(); renderPanel(); updateSQL("");
let lastNow = performance.now(), lastKey = "";
function frame(now) {
  const dt = Math.min(0.05, (now - lastNow) / 1000); lastNow = now;
  if (playing) {
    let t = S.t + dt * 6;                       // ~16 s for 23 years
    if (t >= LASTQ) { t = LASTQ; stopPlay(); }
    setT(t);
  }
  if (dirty || zoom) {
    dirty = false;
    draw(now); drawTL();
    const key = Math.round(S.t * 8) + S.m;
    if (key !== lastKey) { lastKey = key; updateNow(); }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if (qs.get("play") === "1") togglePlay();
