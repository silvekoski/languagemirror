// Typewriter: replay an article's lead section version by version (MariaDB FOR SYSTEM_TIME ALL).
const $ = (s) => document.querySelector(s);
const API = "/api/typewriter";
const params = new URLSearchParams(location.search);
const fmtN = (n) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (ts) => { const [d] = ts.split(" "); const [y, m, dd] = d.split("-"); return `${+dd} ${MONTHS[m - 1]} ${y}`; };
const hm = (ts) => ts.slice(11, 16);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const kind = (v) => (v.bot ? "bot" : v.anonymous ? "anon" : "reg");
const KIND_LABEL = { reg: "registered", anon: "anonymous", bot: "bot" };
const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

let M = null;              // meta for the current article
let V = [];                // versions
let changedIdx = new Map();// seq -> index in M.changed
let cur = 0;               // current seq
let speed = 10, playing = false, token = 0;
const leads = new Map();   // seq -> {tokens, ops}
const chunks = new Map();  // chunk -> Promise

// ---------------- data ----------------
async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); }

function loadChunk(k) {
  if (k < 0 || k * M.chunk >= M.changed.length) return Promise.resolve();
  if (!chunks.has(k)) {
    const pid = M.page_id;
    chunks.set(k, getJSON(`${API}/leads/${pid}?chunk=${k}`).then((d) => {
      if (M.page_id !== pid) return;
      for (const l of d.leads) leads.set(l.seq, l);
    }));
  }
  return chunks.get(k);
}
async function ensure(seq) {
  // text of the last lead change at or before seq, plus its predecessor (for the deletions)
  const ci = lastChangeIndex(seq);
  if (ci < 0) return;
  const k = Math.floor(ci / M.chunk);
  await Promise.all([loadChunk(k), ci % M.chunk === 0 ? loadChunk(k - 1) : null]);
  if (ci % M.chunk > M.chunk - 15) loadChunk(k + 1);   // prefetch
}
function lastChangeIndex(seq) {
  let lo = 0, hi = M.changed.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (M.changed[mid] <= seq) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

// ---------------- rendering the lead ----------------
const paper = $("#paper");
function wordsHTML(toks, cls) {
  let out = "";
  for (const t of toks) {
    if (t === "\n\n") out += `<span class="pb"></span>`;
    else out += cls ? `<span class="${cls}">${esc(t)} </span>` : esc(t) + " ";
  }
  return out;
}
// Render version `seq`'s lead. mode: "anim" (type in), "diff" (static highlights), "plain".
function renderLead(seq, mode) {
  const ci = lastChangeIndex(seq);
  if (ci < 0) { paper.innerHTML = `<span class="empty">No readable lead text in this version.</span>`; return Promise.resolve(); }
  const cs = M.changed[ci];
  const L = leads.get(cs);
  if (!L) return Promise.resolve();
  if (cs !== seq) mode = "plain";
  const prev = ci > 0 ? leads.get(M.changed[ci - 1]) : null;
  const P = prev ? prev.tokens : [];
  if (!L.tokens.length) { paper.innerHTML = `<span class="empty">The lead is empty in this version (the article opens with a heading or only templates).</span>`; return Promise.resolve(); }
  if (mode === "plain") { paper.classList.add("static"); paper.innerHTML = wordsHTML(L.tokens); return Promise.resolve(); }
  paper.classList.remove("static");
  let h = "";
  for (const [tag, i1, i2, j1, j2] of L.ops) {
    if (tag === "e") h += wordsHTML(L.tokens.slice(j1, j2));
    if (tag === "d" || tag === "r") h += wordsHTML(P.slice(i1, i2).filter((t) => t !== "\n\n"), "del");
    if (tag === "i" || tag === "r") h += wordsHTML(L.tokens.slice(j1, j2), mode === "anim" ? "ins hidden" : "ins");
  }
  paper.innerHTML = h;
  const ins = [...paper.querySelectorAll(".ins")];
  const dels = [...paper.querySelectorAll(".del")];
  const first = paper.querySelector(".ins, .del");
  if (first) scrollIntoPaper(first);
  if (mode !== "anim") return Promise.resolve();
  // typing: total time grows with the number of words, compressed by speed
  const total = Math.min(3600, 260 + ins.length * 55) / speed;
  const step = ins.length ? total / ins.length : 0;
  const my = token;
  return new Promise((resolve) => {
    setTimeout(() => dels.forEach((d) => d.classList.add("fade")), Math.min(900, 500 / speed));
    if (!ins.length) return setTimeout(resolve, Math.max(30, 700 / speed));
    let i = 0;
    const tick = () => {
      if (my !== token) return resolve();
      const n = Math.max(1, Math.round(16 / Math.max(step, 1)));  // several words per frame at high speed
      for (let k = 0; k < n && i < ins.length; k++, i++) {
        if (i) ins[i - 1].classList.remove("caret");
        ins[i].classList.remove("hidden"); ins[i].classList.add("typed", "caret");
        if (i % 12 === 0) scrollIntoPaper(ins[i]);
      }
      if (i < ins.length) setTimeout(tick, Math.max(step, 4));
      else setTimeout(() => { ins[i - 1].classList.remove("caret"); resolve(); }, Math.max(40, 500 / speed));
    };
    tick();
  });
}
function scrollIntoPaper(el) {
  const pr = paper.getBoundingClientRect(), er = el.getBoundingClientRect();
  if (er.top < pr.top + 20 || er.bottom > pr.bottom - 20) paper.scrollTop += er.top - pr.top - pr.height * 0.3;
}

// ---------------- side panel ----------------
function renderNow(seq) {
  const v = V[seq], k = kind(v);
  const ci = lastChangeIndex(seq);
  const lc = v.lead_changed;
  $("#vdate").textContent = day(v.ts);
  $("#vnote").innerHTML = lc
    ? `${hm(v.ts)} UTC · this edit changed the lead: <span class="plus">+${v.w_add}</span> <span class="minus">−${v.w_del}</span> words`
    : `${hm(v.ts)} UTC · lead unchanged by this edit${ci >= 0 ? ` (last changed ${day(V[M.changed[ci]].ts)})` : ""}`;
  $("#now").innerHTML = `
    <h2>Version ${fmtN(seq + 1)} of ${fmtN(V.length)}</h2>
    <div class="who">${esc(v.user || "(hidden)")} <span class="badge ${k}">${KIND_LABEL[k]}</span>${v.is_revert ? `<span class="badge rev">revert</span>` : ""}${v.minor ? `<span class="badge reg">minor</span>` : ""}</div>
    <div class="when">${day(v.ts)}, ${hm(v.ts)} UTC</div>
    <p class="summary ${v.comment ? "" : "none"}">${v.comment ? "“" + esc(v.comment) + "”" : "no edit summary"}</p>
    <div class="nums"><span>lead <span class="plus">+${v.w_add}</span> <span class="minus">−${v.w_del}</span> words</span>
      <span>article ${v.delta >= 0 ? "+" : "−"}${fmtN(Math.abs(v.delta))} bytes</span><span>${fmtN(v.len)} bytes total</span>
      <a href="https://fi.wikipedia.org/?oldid=${v.rev_id}" target="_blank" rel="noopener">this version ↗</a></div>`;
  $("#counter").textContent = `version ${fmtN(seq + 1)}/${fmtN(V.length)} · lead change ${fmtN(Math.max(0, ci + 1))}/${fmtN(M.changed.length)}`;
  document.querySelectorAll("#big li").forEach((li) => li.classList.toggle("on", +li.dataset.seq === seq));
}

function renderArticle() {
  const reverts = V.reduce((a, v) => a + v.is_revert, 0);
  const anon = V.reduce((a, v) => a + v.anonymous, 0);
  const editors = new Set(V.map((v) => v.user)).size;
  const last = V[V.length - 1];
  const peak = V.reduce((a, v) => (v.lead_words > a.lead_words ? v : a), V[0]);
  $("#title").textContent = M.title;
  document.title = `${M.title} · Typewriter — Wikipedia Through Time`;
  $("#kicker").textContent = `${V[0].ts.slice(0, 4)} → ${last.ts.slice(0, 4)} · ${fmtN(V.length)} versions by ${fmtN(editors)} editors`;
  $("#stats").innerHTML = [
    [fmtN(M.changed.length), "edits changed the lead"],
    [fmtN(reverts), "reverts"],
    [Math.round((100 * anon) / V.length) + "%", "anonymous"],
    [fmtN(last.lead_words), `lead words now · peak ${fmtN(peak.lead_words)} in ${peak.ts.slice(0, 4)}`],
  ].map(([b, t]) => `<div><b>${b}</b><span>${t}</span></div>`).join("");
  $("#big").innerHTML = biggest().map((v) => `
    <li data-seq="${v.seq}"><span class="d">${day(v.ts).replace(/^\d+ /, "")}</span>
      <span class="u">${esc(v.user)}${v.is_revert ? ` <span class="badge rev">revert</span>` : ""}</span>
      <span class="mono"><span class="plus">+${v.w_add}</span> <span class="minus">−${v.w_del}</span></span>
      <span class="c">${v.comment ? esc(v.comment) : "<i>no edit summary</i>"}</span></li>`).join("");
  $("#big").querySelectorAll("li").forEach((li) => li.onclick = () => jump(+li.dataset.seq));
  $("#sql").textContent = M.sql;
  $("#chunkn").textContent = M.chunk;
}
function biggest(n = 5) {
  return V.slice(1).filter((v) => v.lead_changed).sort((a, b) => b.w_add + b.w_del - (a.w_add + a.w_del)).slice(0, n);
}

// ---------------- timeline canvas ----------------
const cv = $("#scrub"), ctx = cv.getContext("2d");
let base = null, W = 0, H = 0, dpr = 1;
const PAD = 8, AREA_H = 52, TICK_Y = 66, TICK_H = 30;
const xOf = (i) => PAD + (V.length > 1 ? (i / (V.length - 1)) * (W - 2 * PAD) : 0);
function drawBase() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  base = document.createElement("canvas"); base.width = cv.width; base.height = cv.height;
  const g = base.getContext("2d"); g.scale(dpr, dpr);
  const C = { reg: cssv("--ink-2"), anon: cssv("--anon"), bot: cssv("--bot"), rev: cssv("--revert"), acc: cssv("--accent"), mute: cssv("--mute"), faint: cssv("--faint") };
  // year grid
  g.font = `11px ${cssv("--mono")}`; g.textBaseline = "top";
  let lastY = null, lastX = -99;
  V.forEach((v, i) => {
    const y = v.ts.slice(0, 4);
    if (y !== lastY) {
      lastY = y; const x = xOf(i);
      g.fillStyle = "rgba(255,255,255,.05)"; g.fillRect(x, 0, 1, TICK_Y + TICK_H);
      if (x - lastX > 34 && x < W - 30) { g.fillStyle = C.mute; g.fillText(y, x + 3, 0); lastX = x; }
    }
  });
  // lead length area
  const maxW = Math.max(1, ...V.map((v) => v.lead_words));
  const yA = (w) => 14 + AREA_H - (w / maxW) * (AREA_H - 4);
  g.beginPath(); g.moveTo(xOf(0), yA(0));
  V.forEach((v, i) => g.lineTo(xOf(i), yA(v.lead_words)));
  g.lineTo(xOf(V.length - 1), yA(0)); g.closePath();
  const grad = g.createLinearGradient(0, 14, 0, 14 + AREA_H);
  grad.addColorStop(0, "rgba(138,180,255,.32)"); grad.addColorStop(1, "rgba(138,180,255,.03)");
  g.fillStyle = grad; g.fill();
  g.beginPath(); V.forEach((v, i) => (i ? g.lineTo : g.moveTo).call(g, xOf(i), yA(v.lead_words)));
  g.strokeStyle = C.acc; g.lineWidth = 1.3; g.stroke();
  // label the peak of the lead's length
  const pk = V.reduce((a, v) => (v.lead_words > a.lead_words ? v : a), V[0]);
  const pl = `longest lead: ${fmtN(pk.lead_words)} words, ${pk.ts.slice(0, 4)}`;
  g.font = `10.5px ${cssv("--sans")}`;
  const pw = g.measureText(pl).width, px = Math.min(Math.max(PAD, xOf(pk.seq) + 5), W - PAD - pw);
  g.fillStyle = "rgba(7,8,13,.7)"; g.fillRect(px - 2, yA(pk.lead_words) - 1, pw + 4, 13);
  g.fillStyle = C.acc; g.fillText(pl, px, yA(pk.lead_words));
  // ticks
  const maxC = Math.max(1, ...V.map((v) => v.w_add + v.w_del));
  const tw = Math.max(1, Math.min(4, (W - 2 * PAD) / V.length * 0.8));
  V.forEach((v, i) => {
    const x = xOf(i) - tw / 2;
    const h = v.lead_changed ? 9 + Math.sqrt((v.w_add + v.w_del) / maxC) * (TICK_H - 9) : 6;
    const y = TICK_Y + TICK_H - h;
    const k = v.is_revert ? "rev" : kind(v);
    if (k === "anon") { g.strokeStyle = C.anon; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, Math.max(tw, 2) - 1, h - 1); }
    else { g.fillStyle = C[k]; g.globalAlpha = v.lead_changed ? 1 : 0.55; g.fillRect(x, y, tw, h); g.globalAlpha = 1; }
  });
  // biggest changes: little labelled markers on the area
  g.font = `10.5px ${cssv("--sans")}`;
  const placed = [];
  biggest(3).sort((p, q) => p.seq - q.seq).forEach((v) => {
    const x = xOf(v.seq);
    g.fillStyle = cssv("--warm"); g.beginPath(); g.arc(x, TICK_Y - 4, 2.5, 0, 7); g.fill();
    const label = `${v.user.length > 16 ? v.user.slice(0, 15) + "…" : v.user} +${v.w_add}/−${v.w_del}`;
    const tw2 = g.measureText(label).width;
    const lx = Math.min(Math.max(PAD, x - tw2 / 2), W - PAD - tw2);
    let row = 0;  // stack labels that would overlap
    while (placed.some((p) => p.row === row && lx < p.r + 6 && lx + tw2 > p.l - 6)) row++;
    placed.push({ l: lx, r: lx + tw2, row });
    const ly = TICK_Y - 18 - row * 15;
    if (row) { g.fillStyle = cssv("--warm"); g.fillRect(x - 0.5, ly + 12, 1, TICK_Y - 6 - ly - 12); }
    g.fillStyle = "rgba(7,8,13,.75)"; g.fillRect(lx - 3, ly - 1, tw2 + 6, 13);
    g.fillStyle = cssv("--warm"); g.fillText(label, lx, ly);
  });
}
function drawScrub() {
  if (!base) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(base, 0, 0);
  ctx.scale(dpr, dpr);
  const x = xOf(cur);
  ctx.fillStyle = "rgba(255,180,107,.12)"; ctx.fillRect(PAD, TICK_Y + TICK_H + 3, x - PAD, 3);
  ctx.fillStyle = cssv("--warm"); ctx.fillRect(PAD, TICK_Y + TICK_H + 3, Math.max(0, x - PAD), 3);
  ctx.fillRect(x - 1, 12, 2, TICK_Y + TICK_H - 10);
  ctx.beginPath(); ctx.arc(x, TICK_Y + TICK_H + 4.5, 5, 0, 7); ctx.fill();
}
const idxAt = (clientX) => {
  const r = cv.getBoundingClientRect();
  return Math.max(0, Math.min(V.length - 1, Math.round(((clientX - r.left - PAD) / (W - 2 * PAD)) * (V.length - 1))));
};
let dragging = false;
cv.addEventListener("pointerdown", (e) => { dragging = true; cv.setPointerCapture(e.pointerId); jump(idxAt(e.clientX), "drag"); });
cv.addEventListener("pointermove", (e) => {
  const i = idxAt(e.clientX), v = V[i];
  if (dragging) { jump(i, "drag"); }
  if (!v) return;
  const tip = $("#tip"); tip.hidden = false;
  tip.innerHTML = `<b>${day(v.ts)}</b> ${hm(v.ts)} · v${fmtN(i + 1)}<br>${esc(v.user)} <span class="mute">(${KIND_LABEL[kind(v)]}${v.is_revert ? ", revert" : ""})</span><br>`
    + (v.lead_changed ? `lead <span class="plus">+${v.w_add}</span> <span class="minus">−${v.w_del}</span> words · ` : `lead unchanged · `)
    + `${fmtN(v.lead_words)} words<br><span class="mute">${v.comment ? esc(v.comment.slice(0, 140)) : "no edit summary"}</span>`;
  const tx = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  tip.style.left = tx + "px"; tip.style.top = (e.clientY - tip.offsetHeight - 14) + "px";
});
cv.addEventListener("pointerup", () => { if (dragging) { dragging = false; jump(cur); } });
cv.addEventListener("pointerleave", () => { $("#tip").hidden = true; });

// ---------------- navigation & playback ----------------
let jumpSeq = 0;
async function jump(seq, how) {
  stop();
  cur = seq; renderNow(seq); drawScrub();
  if (how === "drag") { // cheap while dragging: show text if already loaded
    if (leads.has(M.changed[lastChangeIndex(seq)])) renderLead(seq, "plain");
    return;
  }
  const my = ++jumpSeq;
  await ensure(seq);
  if (my === jumpSeq) renderLead(seq, "diff");
  history.replaceState(null, "", `?page=${M.page_id}&v=${seq}`);
}
function stop() { playing = false; token++; $("#play").textContent = "▶"; }
async function play() {
  if (cur >= V.length - 1) cur = 0;
  playing = true; const my = ++token; $("#play").textContent = "❚❚";
  await ensure(cur); if (my !== token) return;
  await renderLead(cur, cur === 0 ? "anim" : "plain");
  while (playing && my === token && cur < V.length - 1) {
    const next = cur + 1;
    if (V[next].lead_changed) {
      await ensure(next); if (my !== token) return;
      cur = next; renderNow(cur); drawScrub();
      await renderLead(cur, "anim");
      await sleep(Math.max(20, 900 / speed)); // let the reader see the result
    } else {
      // unchanged lead: skip quickly, but let the scrubber and editor card move
      let n = Math.max(1, Math.round(speed / 10));
      while (n-- && cur < V.length - 1 && !V[cur + 1].lead_changed) cur++;
      renderNow(cur); drawScrub();
      await sleep(70 / Math.sqrt(speed));
    }
  }
  if (my === token) { stop(); history.replaceState(null, "", `?page=${M.page_id}&v=${cur}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stepChange(dir) {
  const ci = lastChangeIndex(cur);
  let t = dir > 0 ? (M.changed[cur === M.changed[ci] || ci < 0 ? ci + 1 : ci + 1]) : (cur === M.changed[ci] ? M.changed[ci - 1] : M.changed[ci]);
  if (t !== undefined) jump(t);
}

$("#play").onclick = () => (playing ? stop() : play());
$("#restart").onclick = () => { stop(); cur = 0; renderNow(0); drawScrub(); play(); };
$("#prevc").onclick = () => stepChange(-1);
$("#nextc").onclick = () => stepChange(1);
$("#speeds").onclick = (e) => {
  const b = e.target.closest("[data-s]"); if (!b) return;
  speed = +b.dataset.s; document.querySelectorAll("#speeds .chip").forEach((c) => c.classList.toggle("on", c === b));
};
addEventListener("keydown", (e) => {
  if (e.target.matches("input, select")) return;
  if (e.code === "Space") { e.preventDefault(); playing ? stop() : play(); }
  if (e.key === "ArrowRight") stepChange(1);
  if (e.key === "ArrowLeft") stepChange(-1);
});
// redraw the timeline whenever its box changes size (window resize, scrollbar appearing) and once the web fonts land
let lastW = 0;
new ResizeObserver(() => { if (V.length && cv.clientWidth !== lastW) { lastW = cv.clientWidth; drawBase(); drawScrub(); } }).observe(cv);
document.fonts.ready.then(() => { if (V.length) { drawBase(); drawScrub(); } });

function notice(msg) {
  const n = $("#notice"); n.textContent = msg; n.hidden = false;
  clearTimeout(notice.t); notice.t = setTimeout(() => (n.hidden = true), 7000);
}

// ---------------- article picker ----------------
async function loadArticle(pid, seq) {
  stop();
  paper.innerHTML = `<span class="empty">Reading every version of the article from MariaDB…</span>`;
  let m;
  try { m = await getJSON(`${API}/meta/${pid}`); }
  catch (e) {
    const back = M ? M.page_id : pid !== 1256 ? 1256 : null;
    if (back === null) { paper.innerHTML = `<span class="empty">${esc(e.message)}</span>`; return; }
    if (!M) await loadArticle(back);
    else jump(cur);
    notice(`Article ${pid} has no stored text history (only ~17,400 articles carry their full text), so ${M.title} is shown instead.`);
    return;
  }
  M = m;
  V = M.rows.map((r) => Object.fromEntries(M.cols.map((c, i) => [c, r[i]]))); leads.clear(); chunks.clear();
  renderArticle(); drawBase();
  if (![...$("#pick").options].some((o) => +o.value === pid)) $("#pick").add(new Option(M.title, pid), 0);
  $("#pick").value = pid;
  // default: the biggest genuine rewrite (most words both removed and added) — it shows both kinds of change
  if (seq === undefined || !(seq >= 0 && seq < V.length)) {
    const rw = V.slice(1).filter((v) => v.lead_changed && !v.is_revert).sort((a, b) => Math.min(b.w_add, b.w_del) - Math.min(a.w_add, a.w_del))[0];
    seq = rw ? rw.seq : V.length - 1;
  }
  await jump(seq);
  loadChunk(0);
}

const arts = await getJSON(`${API}/articles`);
const famous = arts.filter((a) => a.famous), more = arts.filter((a) => !a.famous);
const og = (label, list) => `<optgroup label="${label}">${list.map((a) => `<option value="${a.page_id}">${esc(a.title)} · ${fmtN(a.versions)} versions</option>`).join("")}</optgroup>`;
$("#pick").innerHTML = og("Famous, heavily edited", famous) + og("Most edited with stored text", more);
$("#pick").onchange = () => loadArticle(+$("#pick").value);
let qt = 0;
$("#q").oninput = () => {
  clearTimeout(qt);
  const q = $("#q").value.trim();
  if (q.length < 2) { $("#qres").style.display = "none"; return; }
  qt = setTimeout(async () => {
    const r = await getJSON(`${API}/search?q=${encodeURIComponent(q)}`);
    $("#qres").innerHTML = r.length ? r.map((a) => `<div data-p="${a.page_id}">${esc(a.title)}</div>`).join("") : `<div class="mute">No article with stored text matches.</div>`;
    $("#qres").style.display = "block";
  }, 220);
};
$("#qres").onclick = (e) => { const d = e.target.closest("[data-p]"); if (!d) return; $("#qres").style.display = "none"; $("#q").value = ""; loadArticle(+d.dataset.p); };

const startPid = +(params.get("page") || 1256);
const startV = params.has("v") ? +params.get("v") : undefined;
await loadArticle(startPid, startV);
if (params.get("play") === "1") play();
