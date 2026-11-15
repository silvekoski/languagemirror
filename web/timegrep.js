import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const num = n => (+n).toLocaleString("en-US");
const END = new Date("2026-10-01T00:00:00Z");
const parseT = s => new Date(s.replace(" ", "T") + "Z");
const fmtDay = d3.utcFormat("%-d %b %Y"), fmtMin = d3.utcFormat("%Y-%m-%d %H:%M");
const oldid = r => `https://fi.wikipedia.org/?oldid=${r}`;
const isBot = u => /bot$/i.test(u || "");
const tip = $("#tip");

const LEDE = {
  article: `Every one of an article's thousands of versions is a row in MariaDB's system-versioned <code>article</code> table, so one
    <code>FOR SYSTEM_TIME ALL</code> query can grep them all. See exactly when a phrase entered the encyclopedia, who removed it,
    how fast it came back, and how the sentence around it was reworded over twenty years.`,
  wiki: `The same table answers “what did Finnish Wikipedia say on a given day?”: <code>FOR SYSTEM_TIME AS OF</code> plus
    <code>LIKE</code>, run once per date, shows how a name or term spread through the history-of-Finland articles from 2005 to 2026.`,
};
const PRESETS_A = [
  { page: 1256, title: "Talvisota", q: "105 päivää" },
  { page: 1275, title: "Urho Kekkonen", q: "diktaattori" },
  { page: 1150, title: "Suomen sisällissota", q: "vapaussota" },
  { page: 6021, title: "C. G. E. Mannerheim", q: "valkoinen kenraali" },
];
const PRESETS_W = ["Mannerheim", "Kekkonen", "sisällissota", "vapaussota"];

// ---------------------------------------------------------------- tooltip
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
  if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
  tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
}
const hideTip = () => { tip.hidden = true; };

function hlSQL(sql) {
  return esc(sql)
    .replace(/(--[^\n]*)/g, '<span class="cm">$1</span>')
    .replace(/\b(SET STATEMENT|FOR SYSTEM_TIME ALL|FOR SYSTEM_TIME AS OF|TIMESTAMP|SELECT|FROM|WHERE|ORDER BY|AND|AS|IN|LIKE|REGEXP|LIMIT|AGAINST|BOOLEAN MODE|FOR)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(REGEXP_INSTR|SUBSTRING|LOCATE|MATCH)\b/g, '<span class="fn">$1</span>');
}

function withMark(s, a, b) {
  if (a == null || a < 0 || b <= a) return esc(s);
  return esc(s.slice(0, a)) + "<mark>" + esc(s.slice(a, b)) + "</mark>" + esc(s.slice(b));
}

function ago(sec) {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 36000) return `${(sec / 3600).toFixed(1)} h`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  if (sec < 86400 * 60) return `${Math.round(sec / 86400)} days`;
  if (sec < 86400 * 730) return `${Math.round(sec / 86400 / 30.4)} months`;
  return `${(sec / 86400 / 365.25).toFixed(1)} years`;
}
const who = (u, anon) => `<b>${esc(u || "?")}</b>${anon ? ' <span class="badge anon">anon</span>' : isBot(u) ? ' <span class="badge bot">bot</span>' : ""}`;

// ---------------------------------------------------------------- mode switching & URL state
let mode = "article";
function setMode(m, push = true) {
  mode = m;
  document.querySelectorAll(".modes .chip").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  $("#m-article").hidden = m !== "article"; $("#m-wiki").hidden = m !== "wiki";
  $("#lede").innerHTML = LEDE[m];
  if (push) syncURL();
}
function syncURL() {
  const p = new URLSearchParams();
  if (mode === "wiki") { p.set("mode", "wiki"); if (W.q) p.set("q", W.q); }
  else { if (A.page) p.set("page", A.page); if (A.q) p.set("q", A.q); }
  history.replaceState(null, "", "?" + p.toString());
}
document.querySelectorAll(".modes .chip").forEach(b => b.onclick = () => {
  setMode(b.dataset.mode);
  if (b.dataset.mode === "wiki" && !W.data) runWiki(W.q);
});

// ================================================================ MODE 1
const A = { page: 1256, title: "Talvisota", q: "105 päivää", data: null, axis: "time" };

$("#p-article").innerHTML = PRESETS_A.map((p, i) =>
  `<button class="chip" data-i="${i}"><b>${esc(p.title)}</b> · <code>${esc(p.q)}</code></button>`).join("");
$("#p-article").querySelectorAll(".chip").forEach(b => b.onclick = () => {
  const p = PRESETS_A[+b.dataset.i];
  A.page = p.page; A.title = p.title; A.q = p.q; $("#art").value = p.title; $("#pat").value = p.q; runArticle();
});

// article suggestions
const art = $("#art"), sugg = $("#sugg");
let suggT = 0, suggList = [], suggOn = -1;
art.addEventListener("input", () => {
  clearTimeout(suggT);
  suggT = setTimeout(async () => {
    const q = art.value.trim();
    if (q.length < 2) { sugg.hidden = true; return; }
    suggList = await (await fetch(`/api/timegrep/pages?q=${encodeURIComponent(q)}`)).json();
    suggOn = -1;
    sugg.innerHTML = suggList.map((p, i) => `<div data-i="${i}">${esc(p.title)}<small>${num(p.versions)} versions</small></div>`).join("")
      || `<div class="mute">No article with stored history matches</div>`;
    sugg.hidden = false;
    sugg.querySelectorAll("[data-i]").forEach(d => d.onmousedown = e => { e.preventDefault(); pick(+d.dataset.i); });
  }, 140);
});
art.addEventListener("keydown", e => {
  if (sugg.hidden || !suggList.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    suggOn = (suggOn + (e.key === "ArrowDown" ? 1 : -1) + suggList.length) % suggList.length;
    sugg.querySelectorAll("[data-i]").forEach((d, i) => d.classList.toggle("on", i === suggOn));
  } else if (e.key === "Enter" && suggOn >= 0) { e.preventDefault(); pick(suggOn); }
});
art.addEventListener("blur", () => setTimeout(() => sugg.hidden = true, 120));
function pick(i) {
  const p = suggList[i]; A.page = p.page_id; A.title = p.title; art.value = p.title; sugg.hidden = true; $("#pat").focus();
}
$("#f-article").onsubmit = e => {
  e.preventDefault();
  if (suggList.length && art.value.trim() && art.value.trim() !== A.title) {
    const exact = suggList.find(p => p.title.toLowerCase() === art.value.trim().toLowerCase()) || suggList[0];
    A.page = exact.page_id; A.title = exact.title; art.value = exact.title;
  }
  A.q = $("#pat").value.trim() || A.q; $("#pat").value = A.q;
  runArticle();
};
document.querySelectorAll(".axis-toggle .chip").forEach(b => b.onclick = () => {
  A.axis = b.dataset.axis;
  document.querySelectorAll(".axis-toggle .chip").forEach(x => x.classList.toggle("on", x === b));
  if (A.data) drawStrip(A.data);
});

let runId = 0;
async function runArticle() {
  const id = ++runId;
  syncURL();
  $("#h-article").innerHTML = `<span class="loading">grepping every version of ${esc(A.title || "the article")} for <q>${esc(A.q)}</q> </span>`;
  let d;
  try {
    const r = await fetch(`/api/timegrep/grep?page=${A.page}&q=${encodeURIComponent(A.q)}`);
    d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
  } catch (e) {
    if (id !== runId) return;
    $("#h-article").innerHTML = `<span class="err">${esc(e.message)}</span>`;
    return;
  }
  if (id !== runId) return;
  const C = d.v;
  d.versions = C.t.map((t, i) => ({ t, rev: C.rev[i], user: C.user[i], c: C.c[i],
    anon: C.anon[i] === "1", hit: C.hit[i] === "1", rv: C.rv[i] === "1" }));
  A.data = d; A.title = d.title; art.value = d.title;
  document.querySelectorAll("#p-article .chip").forEach((b, i) =>
    b.classList.toggle("on", PRESETS_A[i].page === d.page_id && PRESETS_A[i].q === d.pattern));
  if (A.axis === "time" && d.stats.hits && d.stats.time_share < 0.02) setAxis("edit");
  renderArticle(d);
}
function setAxis(a) {
  A.axis = a;
  document.querySelectorAll(".axis-toggle .chip").forEach(x => x.classList.toggle("on", x.dataset.axis === a));
}

function renderArticle(d) {
  const s = d.stats, V = d.versions, first = d.events.find(e => e.kind === "first");
  const q = `<q>${esc(d.pattern)}</q>`, T = `<b>${esc(d.title)}</b>`;
  let h;
  if (!s.hits) {
    h = `${q} never appears in any of the <span class="n">${num(s.n)}</span> stored versions of ${T}.`;
  } else {
    const share = Math.round(s.time_share * 100);
    h = s.time_share >= 0.01
      ? `${q} has been in ${T} for <span class="n">${share}%</span> of the article's life: <span class="n">${num(s.hits)}</span> of its ${num(s.n)} versions. `
      : `${q} appeared in only <span class="n">${num(s.hits)}</span> of the ${num(s.n)} versions of ${T}, adding up to ${ago(s.time_share * (END - parseT(V[0].t)) / 1000)} in total. `;
    h += `First written on <span class="n">${fmtDay(parseT(first.t))}</span> by ${esc(first.user)}. `;
    const gone = d.events.filter(e => e.kind === "gone");
    if (gone.length) {
      const fast = gone.filter(e => e.absent_s != null && e.absent_s < 3600).length;
      const neverBack = gone.filter(e => !e.undone_by).length;
      h += `Removed <span class="n">${gone.length === 1 ? "once" : gone.length + " times"}</span>`;
      if (gone.length === 1 && gone[0].undone_by) h += `, back ${ago(gone[0].absent_s)} later${gone[0].undone_by.rv ? ' <span class="good">by a revert</span>' : ""}.`;
      else h += fast ? `; ${fast === gone.length ? "every time" : fast + " times"} it was back within the hour${s.revert_restores ? ` (${s.revert_restores} by revert)` : ""}.` : ".";
      if (!s.still_there) h += ` <span class="bad">Gone today</span>: last removed ${fmtDay(parseT(gone[gone.length - 1].t))}.`;
      else if (neverBack) h += "";
    } else if (s.still_there) h += `Never removed since.`;
  }
  $("#h-article").innerHTML = h;
  $("#sql-a").innerHTML = hlSQL(d.sql);
  $("#sql-meta-a").textContent = `· ${num(s.n)} versions grepped, ${(d.ms / 1000).toFixed(1)} s round trip` + (d.cache !== "live" ? ` (served from ${d.cache})` : "");
  drawStrip(d);
  renderFirst(d, first);
  renderEvents(d);
  renderWordings(d);
}

// ---------------- presence strip
let stripObs = null;
function drawStrip(d) {
  const box = $("#strip"), W = box.clientWidth, narrow = W < 600;
  const V = d.versions, n = V.length, t = V.map(v => parseT(v.t));
  const M = { l: narrow ? 6 : 70, r: 10 }, H = 158;
  const yLbl = 22, yBand = 44, hBand = 40, yTick = yBand + hBand + 8, hTick = 14, yRv = yTick + hTick + 6, yAx = yRv + 14;
  const timeX = d3.scaleUtc().domain([t[0], END]).range([M.l, W - M.r]);
  const editX = d3.scaleLinear().domain([0, n]).range([M.l, W - M.r]);
  const byTime = A.axis === "time";
  const x0 = i => byTime ? timeX(t[i]) : editX(i);
  const x1 = i => byTime ? timeX(i + 1 < n ? t[i + 1] : END) : editX(i + 1);

  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("height", H);
  // band background + lit runs
  svg.append("rect").attr("x", M.l).attr("y", yBand).attr("width", W - M.l - M.r).attr("height", hBand)
    .attr("rx", 4).attr("fill", "rgba(255,255,255,.045)");
  const runs = [];
  for (let i = 0; i < n; i++) {
    if (!V[i].hit) continue;
    let j = i; while (j + 1 < n && V[j + 1].hit) j++;
    runs.push([i, j]); i = j;
  }
  const defs = svg.append("defs");
  const g = defs.append("linearGradient").attr("id", "litg").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", 1);
  g.append("stop").attr("offset", 0).attr("stop-color", "#ffd38f");
  g.append("stop").attr("offset", 1).attr("stop-color", "#e8932f");
  svg.append("g").selectAll("rect").data(runs).join("rect")
    .attr("x", r => x0(r[0])).attr("y", yBand).attr("height", hBand)
    .attr("width", r => Math.max(1.5, x1(r[1]) - x0(r[0]))).attr("fill", "url(#litg)");

  // one tick per version
  const ticks = svg.append("g");
  const tw = byTime ? 1 : Math.max(0.6, (W - M.l - M.r) / n - (n < 400 ? 1 : 0));
  ticks.selectAll("rect").data(V).join("rect")
    .attr("x", (v, i) => x0(i)).attr("y", v => v.hit ? yTick : yTick + 5).attr("width", tw)
    .attr("height", v => v.hit ? hTick : hTick - 5)
    .attr("fill", v => v.hit ? "rgba(255,196,107,.75)" : "rgba(255,255,255,.16)");
  // reverts row
  svg.append("g").selectAll("rect").data(V.map((v, i) => [v, i]).filter(p => p[0].rv)).join("rect")
    .attr("x", p => x0(p[1])).attr("y", yRv).attr("width", Math.max(1, tw)).attr("height", 5).attr("fill", "var(--revert)").attr("opacity", .8);
  if (!narrow) {
    svg.append("text").attr("class", "lbl k").attr("x", M.l - 10).attr("y", yBand + hBand / 2 + 4).attr("text-anchor", "end").text("present");
    svg.append("text").attr("class", "lbl k").attr("x", M.l - 10).attr("y", yTick + 11).attr("text-anchor", "end").text("versions");
    svg.append("text").attr("class", "lbl k").attr("x", M.l - 10).attr("y", yRv + 6).attr("text-anchor", "end").text("reverts");
  }
  // axis
  const ax = svg.append("g").attr("class", "ax").attr("transform", `translate(0,${yAx})`);
  if (byTime) ax.call(d3.axisBottom(timeX).ticks(narrow ? 5 : 12).tickSizeOuter(0));
  else {
    // label the edit axis with the years where they start
    const yrs = []; let last = null;
    t.forEach((d0, i) => { const y = d0.getUTCFullYear(); if (y !== last) { yrs.push([i, y]); last = y; } });
    const minGap = narrow ? 44 : 36; let lastX = -1e9;
    const shown = yrs.filter(([i]) => { const x = editX(i); if (x - lastX < minGap) return false; lastX = x; return true; });
    ax.call(d3.axisBottom(editX).tickValues(shown.map(s => s[0])).tickFormat((i) => shown.find(s => s[0] === i)[1]).tickSizeOuter(0));
  }
  ax.select(".domain").remove();

  // events
  const evs = d.events;
  const mk = svg.append("g");
  evs.forEach(e => {
    const x = x0(e.i);
    if (e.kind === "first") {
      mk.append("line").attr("x1", x).attr("x2", x).attr("y1", yLbl + 4).attr("y2", yBand + hBand).attr("stroke", "#fff").attr("stroke-width", 1).attr("opacity", .6);
      mk.append("circle").attr("cx", x).attr("cy", yBand - 4).attr("r", 4.5).attr("fill", "#fff").attr("stroke", "var(--lit)").attr("stroke-width", 2);
    } else if (e.kind === "gone") {
      mk.append("path").attr("d", `M${x - 5},${yBand - 11}L${x + 5},${yBand - 11}L${x},${yBand - 3}Z`).attr("fill", "var(--revert)");
    } else {
      mk.append("path").attr("d", `M${x - 5},${yBand + hBand + 11 - 4}L${x + 5},${yBand + hBand + 11 - 4}L${x},${yBand + hBand - 1}Z`).attr("fill", "var(--back)").attr("opacity", .9);
    }
  });
  const first = evs.find(e => e.kind === "first");
  if (first) {
    const x = x0(first.i), txt = `first: ${fmtDay(parseT(first.t))} · ${first.user}`;
    const right = x > W * 0.62;
    svg.append("text").attr("class", "lbl").attr("x", right ? x - 6 : x + 6).attr("y", yLbl)
      .attr("text-anchor", right ? "end" : "start").text(txt);
  }
  const last = V[n - 1];
  svg.append("text").attr("class", "lbl").attr("x", W - M.r).attr("y", yLbl).attr("text-anchor", "end")
    .attr("fill", last.hit ? "var(--lit)" : "var(--mute)").style("fill", last.hit ? "var(--lit)" : "var(--mute)")
    .text(last.hit ? "present today" : "absent today");

  // hover: nearest version
  const cursor = svg.append("line").attr("class", "cursor").attr("y1", yBand - 14).attr("y2", yRv + 6).attr("opacity", 0);
  const xs = V.map((v, i) => x0(i));
  svg.append("rect").attr("x", M.l).attr("y", 0).attr("width", W - M.l - M.r).attr("height", yAx).attr("fill", "transparent")
    .on("pointermove", ev => {
      const [mx] = d3.pointer(ev);
      let i = d3.bisectRight(xs, mx) - 1; i = Math.max(0, Math.min(n - 1, i));
      const v = V[i], e = evs.find(e => e.i === i);
      cursor.attr("x1", xs[i]).attr("x2", xs[i]).attr("opacity", 1);
      showTip(ev, `<div class="mono" style="color:var(--mute)">${fmtMin(t[i])} UTC · version ${num(i + 1)} of ${num(n)}</div>
        <div style="margin:3px 0">${v.hit ? '<span style="color:var(--lit)">● contains the phrase</span>' : '<span style="color:var(--mute)">○ phrase absent</span>'}
        ${e ? ` · <b style="color:${e.kind === "gone" ? "var(--revert)" : e.kind === "back" ? "var(--bot)" : "#fff"}">${{ first: "first appearance", gone: "removed here", back: "restored here" }[e.kind]}</b>` : ""}</div>
        <div>${who(v.user, v.anon)}${v.rv ? ' <span class="badge rv">revert</span>' : ""}</div>
        ${v.c ? `<div style="color:var(--mute);font-style:italic;margin-top:2px">${esc(v.c)}</div>` : ""}`);
    })
    .on("pointerleave", () => { cursor.attr("opacity", 0); hideTip(); })
    .on("click", ev => {
      const [mx] = d3.pointer(ev);
      const i = Math.max(0, Math.min(n - 1, d3.bisectRight(xs, mx) - 1));
      window.open(oldid(V[i].rev), "_blank", "noopener");
    }).style("cursor", "pointer");

  box.replaceChildren(svg.node());
  if (!stripObs) {
    let lastW = W;
    stripObs = new ResizeObserver(() => { if (A.data && Math.abs(box.clientWidth - lastW) > 4) { lastW = box.clientWidth; drawStrip(A.data); } });
    stripObs.observe(box);
  }
}

function renderFirst(d, f) {
  const el = $("#first");
  if (!f) { el.innerHTML = `<p class="mute" style="margin:0">The pattern never matched. Try a shorter phrase or a regex such as <code class="mono">talvi|winter</code>.</p>`; return; }
  el.innerHTML = `<p class="quote">${f.sentence != null ? withMark(f.sentence, f.a, f.b) : '<span class="mute">(match inside markup)</span>'}</p>
    <div class="meta">
      <span><b>${fmtMin(parseT(f.t))}</b> UTC</span>
      <span>${who(f.user, f.anon)}${f.rv ? ' <span class="badge rv">revert</span>' : ""}</span>
      <span>version ${num(f.i + 1)} of ${num(d.stats.n)}</span>
      <a href="${oldid(f.rev)}" target="_blank" rel="noopener">oldid ${f.rev} ↗</a>
      ${f.c ? `<span class="c">“${esc(f.c)}”</span>` : ""}
    </div>`;
}

function renderEvents(d) {
  const gone = d.events.filter(e => e.kind === "gone");
  $("#n-events").textContent = gone.length ? `${gone.length} removal${gone.length > 1 ? "s" : ""}` : "";
  if (!gone.length) {
    $("#events").innerHTML = `<p class="mute" style="font-size:14px">${d.stats.hits ? "Once in, the phrase was never removed." : "Nothing to show."}</p>`;
    return;
  }
  const MAX = 10;
  $("#events").innerHTML = gone.slice(0, MAX).map(e => {
    const u = e.undone_by;
    return `<div class="ev">
      <div class="when"><b>${fmtDay(parseT(e.t))}</b>${parseT(e.t).toISOString().slice(11, 16)}</div>
      <div class="what">
        <span class="k gone">Removed</span> by ${who(e.user, e.anon)}${e.rv ? ' <span class="badge rv">revert</span>' : ""}
        · <a href="${oldid(e.rev)}" target="_blank" rel="noopener">oldid ↗</a>
        ${e.c ? `<div class="c">“${esc(e.c)}”</div>` : ""}
        ${u ? `<div class="gap">↳ <span class="k back">back after ${ago(e.absent_s)}</span> (${e.edits_absent} edit${e.edits_absent > 1 ? "s" : ""}), restored by ${who(u.user, false)}${u.rv ? ' <span class="badge rv">revert</span>' : ""} · <a href="${oldid(u.rev)}" target="_blank" rel="noopener">oldid ↗</a></div>`
            : `<div class="gap"><span class="k gone">never came back</span></div>`}
      </div></div>`;
  }).join("") + (gone.length > MAX ? `<div class="ev-more">+ ${gone.length - MAX} more removals (hover the strip)</div>` : "");
}

// word diff (LCS over tokens) between consecutive wordings
function tokens(s) { const out = []; const re = /\s+|[^\s]+/g; let m; while ((m = re.exec(s))) out.push([m[0], m.index]); return out; }
function diffHTML(prev, cur, a, b) {
  const P = prev ? tokens(prev).filter(x => x[0].trim()) : null, C = tokens(cur);
  const Cw = C.filter(x => x[0].trim());
  const insSet = new Set(), dels = new Map();   // dels: index in Cw before which deleted words go
  if (P) {
    const n = P.length, m = Cw.length, L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i][j] = P[i][0] === Cw[j][0] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && P[i][0] === Cw[j][0]) { i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { insSet.add(Cw[j][1]); j++; }
      else { const k = j; (dels.get(k) || dels.set(k, []).get(k)).push(P[i][0]); i++; }
    }
  }
  let html = "", wi = 0, open = false;
  const inM = (at, len) => a >= 0 && at < b && at + len > a;
  for (const [tok, at] of C) {
    const m = tok.trim() ? inM(at, tok.length) : (a >= 0 && at >= a && at + tok.length <= b);
    if (open && !m) { html += "</mark>"; open = false; }
    if (!tok.trim()) { html += tok; continue; }
    if (dels.has(wi)) html += `${open ? "</mark>" : ""}<del>${esc(dels.get(wi).join(" "))}</del> ${open ? "<mark>" : ""}`;
    if (m && !open) { html += "<mark>"; open = true; }
    html += insSet.has(at) ? `<ins>${esc(tok)}</ins>` : esc(tok);
    wi++;
  }
  if (open) html += "</mark>";
  if (dels.has(wi)) html += ` <del>${esc(dels.get(wi).join(" "))}</del>`;
  return html;
}

function renderWordings(d) {
  const ws = d.wordings, V = d.versions;
  $("#n-word").textContent = ws.length ? (d.wordings_total > ws.length ? `${ws.length} longest-lived of ${d.wordings_total}` : `${ws.length} wording${ws.length > 1 ? "s" : ""}`) : "";
  if (!ws.length) { $("#wordings").innerHTML = ""; return; }
  const t0 = parseT(V[0].t), span = END - t0;
  const lastS = V[V.length - 1].hit ? ws.reduce((a, w) => (w.spans.at(-1)[1] > (a?.spans.at(-1)[1] || "") ? w : a), null) : null;
  let durable = null;   // diff each wording against the last one that lived at least a day
  $("#wordings").innerHTML = ws.map((w, k) => {
    const brief = w.dur < 86400, base = durable;
    if (!brief) durable = w;
    const bars = w.spans.map(([a, b]) => {
      const l = (parseT(a) - t0) / span * 100, r = (parseT(b) - t0) / span * 100;
      return `<i style="left:${l.toFixed(2)}%;width:${Math.max(0.15, r - l).toFixed(2)}%"></i>`;
    }).join("");
    return `<div class="wd${w === lastS ? " cur" : ""}${brief ? " brief" : ""}">
      <div class="bar" title="when this wording was live">${bars}</div>
      <div class="s">${diffHTML(base ? base.s : null, w.s, w.a, w.b)}</div>
      <div class="meta"><span><b>${fmtDay(parseT(w.first))}</b></span><span>${who(w.user, false)}</span>
        <span>${brief ? '<span class="badge rv">short-lived</span> ' : ""}live ${ago(w.dur)} across ${num(w.n)} version${w.n > 1 ? "s" : ""}</span>${w === lastS ? '<span class="badge new">today</span>' : ""}
        <a href="${oldid(w.rev)}" target="_blank" rel="noopener">oldid ↗</a></div>
    </div>`;
  }).join("");
}

// ================================================================ MODE 2
const W = { q: "Mannerheim", data: null, sel: null };
$("#p-wiki").innerHTML = PRESETS_W.map(q => `<button class="chip" data-q="${esc(q)}"><code>${esc(q)}</code></button>`).join("");
$("#p-wiki").querySelectorAll(".chip").forEach(b => b.onclick = () => { $("#wq").value = b.dataset.q; runWiki(b.dataset.q); });
$("#f-wiki").onsubmit = e => { e.preventDefault(); runWiki($("#wq").value.trim() || W.q); };

const dateLabel = s => s.startsWith("2026-10") ? "Oct 2026" : s.slice(0, 4);
const dateLong = s => s.startsWith("2026-10") ? "1 Oct 2026" : `1 Jan ${s.slice(0, 4)}`;
let wikiRun = 0;
async function runWiki(q) {
  const id = ++wikiRun;
  W.q = q; $("#wq").value = q; syncURL();
  $("#h-wiki").innerHTML = `<span class="loading">asking MariaDB what Finnish Wikipedia said about <q>${esc(q)}</q> on 8 dates </span>`;
  let d;
  try {
    const r = await fetch(`/api/timegrep/wiki?q=${encodeURIComponent(q)}`);
    d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
  } catch (e) { if (id === wikiRun) $("#h-wiki").innerHTML = `<span class="err">${esc(e.message)}</span>`; return; }
  if (id !== wikiRun) return;
  W.data = d; W.sel = d.snapshots.length - 1;
  document.querySelectorAll("#p-wiki .chip").forEach(b => b.classList.toggle("on", b.dataset.q.toLowerCase() === q.toLowerCase()));
  renderWiki();
}

function renderWiki() {
  const d = W.data, S = d.snapshots, q = `<q>${esc(d.phrase)}</q>`;
  if (!S.length) {
    $("#h-wiki").innerHTML = `No article with stored history contains ${q} today, so there is nothing to trace back.`;
    $("#bars").innerHTML = ""; $("#hits").innerHTML = ""; $("#hits-title").textContent = ""; $("#cap-note").textContent = ""; $("#dropped").innerHTML = "";
    return;
  }
  const a = S[0], z = S.at(-1);
  let jump = null;
  for (let i = 1; i < S.length; i++) { const g = S[i].n - S[i - 1].n; if (!jump || g > jump.g) jump = { g, i }; }
  const fall = S.slice(1).reduce((acc, s) => acc + s.dropped_n, 0);
  $("#h-wiki").innerHTML = `On ${dateLong(a.date)}, <span class="n">${num(a.n)}</span> article${a.n === 1 ? "" : "s"} said ${q}; on ${dateLong(z.date)}, <span class="n">${num(z.n)}</span> do.
    ${jump && jump.g > 0 ? `The biggest leap came between ${dateLabel(S[jump.i - 1].date)} and ${dateLabel(S[jump.i].date)} (<span class="n">+${num(jump.g)}</span>).` : ""}
    ${fall ? `Along the way it vanished from an article ${fall === 1 ? "once" : num(fall) + " times"} between snapshots.` : ""}`;
  $("#cap-note").innerHTML = `Searched the <b>${num(d.candidates)}</b> articles whose text today contains the phrase (FULLTEXT on <code>current_article</code>${d.candidates_total > d.candidates ? `, <b>capped at ${num(d.cap)}</b> of ${num(d.candidates_total)}` : ""}),
    each read <code>AS OF</code> ${S.length} dates. Articles that once said it but no longer do are not candidates; trace those one article at a time in the first tab.`;
  const ms = S.map(s => s.ms);
  $("#sql-w").innerHTML = hlSQL(d.sql);
  $("#sql-meta-w").textContent = `· candidates in ${(d.cand_ms / 1000).toFixed(1)} s, ${S.length} AS OF queries in parallel, ${(Math.min(...ms) / 1000).toFixed(1)}–${(Math.max(...ms) / 1000).toFixed(1)} s each` + (d.cache !== "live" ? ` (served from ${d.cache})` : "");
  drawBars(); renderHits();
}

function drawBars() {
  const d = W.data, S = d.snapshots, box = $("#bars"), Wd = box.clientWidth, H = Wd < 500 ? 220 : 300;
  const M = { t: 26, b: 30, l: 4, r: 4 };
  const x = d3.scaleBand().domain(S.map((s, i) => i)).range([M.l, Wd - M.r]).padding(0.28);
  const y = d3.scaleLinear().domain([0, d3.max(S, s => Math.max(s.existing, s.n)) || 1]).range([H - M.b, M.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${Wd} ${H}`).attr("height", H);
  svg.append("line").attr("x1", M.l).attr("x2", Wd - M.r).attr("y1", H - M.b).attr("y2", H - M.b).attr("stroke", "rgba(255,255,255,.12)");
  const g = svg.selectAll("g.col").data(S).join("g").attr("class", "col")
    .on("click", (ev, s) => { W.sel = S.indexOf(s); drawBars(); renderHits(); })
    .on("pointermove", (ev, s) => showTip(ev, `<b>${dateLong(s.date)}</b><div>${num(s.n)} of ${num(s.existing)} candidate articles that existed said <span style="color:var(--lit)">${esc(d.phrase)}</span></div>
      <div class="mute">+${num(s.added)} new since the previous date${s.dropped_n ? `, ${num(s.dropped_n)} dropped it` : ""}</div><div class="mute mono">AS OF query: ${(s.ms / 1000).toFixed(2)} s</div>`))
    .on("pointerleave", hideTip);
  g.append("rect").attr("x", (s, i) => x(i) - 6).attr("width", x.bandwidth() + 12).attr("y", 0).attr("height", H).attr("fill", (s, i) => i === W.sel ? "rgba(255,196,107,.06)" : "transparent").attr("rx", 8);
  g.append("rect").attr("x", (s, i) => x(i)).attr("width", x.bandwidth()).attr("y", s => y(s.existing)).attr("height", s => y(0) - y(s.existing))
    .attr("fill", "rgba(138,180,255,.10)").attr("stroke", "rgba(138,180,255,.35)").attr("stroke-dasharray", "3 3").attr("rx", 3);
  g.append("rect").attr("x", (s, i) => x(i)).attr("width", x.bandwidth()).attr("y", s => y(s.n)).attr("height", s => y(0) - y(s.n))
    .attr("fill", (s, i) => i === W.sel ? "#ffc46b" : "rgba(255,196,107,.62)").attr("rx", 3);
  g.append("text").attr("class", "lab").attr("x", (s, i) => x(i) + x.bandwidth() / 2).attr("y", s => y(Math.max(s.n, s.existing)) - 8)
    .attr("text-anchor", "middle").text(s => num(s.n));
  g.append("text").attr("class", (s, i) => "yr" + (i === W.sel ? " on" : "")).attr("x", (s, i) => x(i) + x.bandwidth() / 2).attr("y", H - 10)
    .attr("text-anchor", "middle").text(s => Wd < 500 ? (s.date.startsWith("2026-10") ? "Oct ’26" : "’" + s.date.slice(2, 4)) : dateLabel(s.date));
  box.replaceChildren(svg.node());
}

function renderHits() {
  const d = W.data, s = d.snapshots[W.sel], prevDate = W.sel ? dateLabel(d.snapshots[W.sel - 1].date) : null;
  $("#hits-title").innerHTML = `${num(s.n)} article${s.n === 1 ? "" : "s"} said <q class="mono" style="color:var(--lit)">${esc(d.phrase)}</q> on ${dateLong(s.date)}`;
  $("#dropped").innerHTML = (W.sel && s.added ? `<span class="badge new">new</span> ${num(s.added)} since ${prevDate}. ` : "") +
    (s.dropped_n ? `<b>No longer saying it:</b> ${s.dropped.map(esc).join(", ")}${s.dropped_n > s.dropped.length ? " …" : ""}` : "");
  const hits = [...s.hits].sort((a, b) => (b.new && W.sel ? 1 : 0) - (a.new && W.sel ? 1 : 0) || a.title.localeCompare(b.title, "fi"));
  $("#hits").innerHTML = hits.map(h => `<div class="hit" data-p="${h.page_id}">
      <div class="t">${esc(h.title)} ${h.new && W.sel ? '<span class="badge new">new</span>' : ""}<small>version of ${h.since.slice(0, 10)}</small></div>
      <div class="s">${withMark(h.s, h.a, h.b)}</div></div>`).join("") || `<p class="mute">None yet.</p>`;
  $("#hits").querySelectorAll(".hit").forEach(el => el.onclick = () => {
    const h = s.hits.find(x => x.page_id === +el.dataset.p);
    A.page = h.page_id; A.title = h.title; A.q = d.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    $("#art").value = h.title; $("#pat").value = A.q;
    setMode("article"); scrollTo({ top: 0, behavior: "smooth" }); runArticle();
  });
}
let barsW = 0;
new ResizeObserver(() => { const w = $("#bars").clientWidth; if (W.data && Math.abs(w - barsW) > 4) { barsW = w; drawBars(); } }).observe($("#bars"));

// ================================================================ boot
const P = new URLSearchParams(location.search);
if (P.get("mode") === "wiki") {
  setMode("wiki", false);
  runWiki(P.get("q") || W.q);
} else {
  setMode("article", false);
  if (P.get("page")) { A.page = +P.get("page"); A.title = null; }
  if (P.get("q")) A.q = P.get("q");
  $("#art").value = A.title || ""; $("#pat").value = A.q;
  runArticle();
}
