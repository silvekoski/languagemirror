import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wiki = (id) => `https://fi.wikipedia.org/?curid=${id}`;

const D = await (await fetch("/api/linkweb/graph")).json();
$("loading").remove();
const S = D.snaps, NS = S.length, YEARS = S.map((s) => s.year);
const N = D.nodes.page_id.length, E = D.edges.length / 3;
const params = new URLSearchParams(location.search);

// ---------- colours: one hue per topic cluster (golden-angle spread), muted so warm "new" links stand out ----------
const clusterColor = (c) => new THREE.Color().setHSL(((c * 137.508) % 360) / 360, 0.55, 0.62);
const cssColor = (c) => `#${clusterColor(c).getHexString()}`;

// ---------- scene ----------
const canvas = $("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x05060b);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 5000);
const narrow = innerWidth < 820;
camera.position.set(0, 40, narrow ? 820 : 560);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.target.set(narrow ? 0 : -40, narrow ? -60 : 0, 0);
// keep the graph visually centred in the free space between the side panels
canvas.addEventListener("pointerdown", () => (controls.autoRotate = false));

const P = new Float32Array(D.nodes.xyz);

// ---------- edges ----------
const ePos = new Float32Array(E * 6), eCol = new Float32Array(E * 6), eKind = new Float32Array(E * 2),
  eEnds = new Float32Array(E * 4), eLen = new Float32Array(E * 2);
for (let e = 0; e < E; e++) {
  const a = D.edges[e * 3], b = D.edges[e * 3 + 1];
  ePos.set(P.subarray(a * 3, a * 3 + 3), e * 6);
  ePos.set(P.subarray(b * 3, b * 3 + 3), e * 6 + 3);
  const ca = clusterColor(D.nodes.cluster[a]), cb = clusterColor(D.nodes.cluster[b]);
  eCol.set([ca.r, ca.g, ca.b, cb.r, cb.g, cb.b], e * 6);
  eEnds.set([a, b, a, b], e * 4);
  eLen[e * 2] = eLen[e * 2 + 1] = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
}
const eGeo = new THREE.BufferGeometry();
eGeo.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
eGeo.setAttribute("color", new THREE.BufferAttribute(eCol, 3));
eGeo.setAttribute("kind", new THREE.BufferAttribute(eKind, 1));
eGeo.setAttribute("ends", new THREE.BufferAttribute(eEnds, 2));
eGeo.setAttribute("len", new THREE.BufferAttribute(eLen, 1));
const eMat = new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 }, uFade: { value: 1 }, uSel: { value: -1 }, uHov: { value: -1 }, uA: { value: narrow ? .55 : 1 } },
  vertexShader: `
    attribute vec3 color; attribute float kind; attribute vec2 ends; attribute float len;
    varying vec3 vC; varying float vK; varying float vS; varying float vL;
    uniform float uSel, uHov;
    void main() {
      vC = color; vK = kind; vL = 1. - .7 * smoothstep(60., 260., len);   // long links recede
      float f = uSel >= 0. ? uSel : uHov;
      vS = f < 0. ? 0. : ((abs(ends.x - f) < .5 || abs(ends.y - f) < .5) ? 1. : -1.);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
    }`,
  fragmentShader: `
    varying vec3 vC; varying float vK; varying float vS; varying float vL;
    uniform float uT, uFade, uA;
    void main() {
      if (vK < .5) discard;
      vec3 c; float a;
      if (vK < 1.5) { c = mix(vec3(.45,.55,.85), vC, .5); a = .085 * vL; }                      // link already there
      else if (vK < 2.5) { c = vec3(1., .6, .26);                                                // new: fade in, then pulse
        a = (.24 + .08 * sin(uT * 2.2)) * (.25 + .75 * uFade) * (.45 + .55 * vL); }
      else { c = vec3(1., .3, .38); a = .22 * (1. - .4 * uFade); }                               // removed
      if (vS > .5) { a = .85; if (vK < 1.5) c = mix(vC, vec3(1.), .3); }
      else if (vS < -.5) a *= .3;
      gl_FragColor = vec4(c, vS > .5 ? a : a * uA);
    }`,
  transparent: true, depthWrite: false,
});
scene.add(new THREE.LineSegments(eGeo, eMat));

// ---------- nodes ----------
const nSize = new Float32Array(N), nFrom = new Float32Array(N), nTo = new Float32Array(N), nCol = new Float32Array(N * 3),
  nIdx = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const c = clusterColor(D.nodes.cluster[i]);
  nCol.set([c.r, c.g, c.b], i * 3);
  nIdx[i] = i;
}
const nGeo = new THREE.BufferGeometry();
nGeo.setAttribute("position", new THREE.BufferAttribute(P, 3));
nGeo.setAttribute("color", new THREE.BufferAttribute(nCol, 3));
nGeo.setAttribute("size", new THREE.BufferAttribute(nSize, 1));
nGeo.setAttribute("idx", new THREE.BufferAttribute(nIdx, 1));
const nMat = new THREE.ShaderMaterial({
  uniforms: { uPx: { value: renderer.getPixelRatio() * innerHeight / 900 }, uSel: { value: -1 }, uHov: { value: -1 } },
  vertexShader: `
    attribute vec3 color; attribute float size; attribute float idx;
    uniform float uPx, uSel, uHov; varying vec3 vC; varying float vHi;
    void main() {
      vC = color; vHi = (abs(idx - uSel) < .5 || abs(idx - uHov) < .5) ? 1. : 0.;
      vec4 mv = modelViewMatrix * vec4(position, 1.);
      gl_PointSize = size <= 0. ? 0. : min((size + vHi * 4.) * uPx * (520. / -mv.z), 34. * uPx + vHi * 8.);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vC; varying float vHi;
    void main() {
      vec2 p = gl_PointCoord - .5; float r = length(p);
      if (r > .5) discard;
      float core = smoothstep(.5, .32, r);
      vec3 c = mix(vC, vec3(1.), .18 + .5 * vHi + .25 * smoothstep(.25, .0, r));
      if (vHi > .5 && r > .38) c = vec3(1.);
      gl_FragColor = vec4(c, core);
    }`,
  transparent: true, depthWrite: false,
});
scene.add(new THREE.Points(nGeo, nMat));

// ---------- state per snapshot ----------
const indeg = D.nodes.indeg;
const sizeOf = (i, k) => (D.nodes.mask[i] >> k & 1) ? 1.6 + 0.62 * Math.sqrt(indeg[i][k]) : 0;
let K = -1, tween = 1, tweenStart = 0;

function setSnap(k, animate = true) {
  if (k === K) return;
  const prevK = K;
  K = k;
  const bit = 1 << k, pbit = k ? 1 << (k - 1) : 0;
  for (let e = 0; e < E; e++) {
    const m = D.edges[e * 3 + 2];
    let kind = 0;
    if (m & bit) kind = k && !(m & pbit) ? 2 : 1;
    else if (k && m & pbit) kind = 3;
    eKind[e * 2] = eKind[e * 2 + 1] = kind;
  }
  eGeo.attributes.kind.needsUpdate = true;
  for (let i = 0; i < N; i++) {
    nFrom[i] = prevK < 0 || !animate ? sizeOf(i, k) : nSize[i];
    nTo[i] = sizeOf(i, k);
  }
  tween = animate ? 0 : 1;
  if (!animate) { nSize.set(nTo); nGeo.attributes.size.needsUpdate = true; }
  tweenStart = performance.now();
  $("slider").value = k;
  document.querySelectorAll(".bar, #years .y").forEach((b) => b.classList.toggle("on", +b.dataset.k === k));
  renderStory();
  pickLabels();
  if (sel >= 0) openDetail(sel, false);
}

// ---------- story panel ----------
const first = S[0], last = S[NS - 1];
const lk = (o) => `<a class="lk" data-pid="${o.page_id}">${esc(o.title)}</a>`;
$("sql").textContent = D.sql;

function renderStory() {
  const s = S[K];
  const when = K === NS - 1 ? "today" : `1 Jan ${s.year}`;
  $("kicker").textContent = `The link web as of ${when}`;
  $("headline").textContent = K === 0 ? "Scattered islands" : K === NS - 1 ? "One dense web" : `${fmt(s.edges_all)} links`;
  $("lede").innerHTML = `Every <code>[[link]]</code> inside ${fmt(last.pages)} Finnish articles on the history of Finland,
    re-read from MariaDB as each article stood at six moments in time (<code>FOR SYSTEM_TIME AS OF</code>).
    Links are how an encyclopedia stitches facts together: from ${fmt(first.edges_all)} links between
    ${fmt(first.pages)} articles in ${first.year} to ${fmt(last.edges_all)} today.`;
  const st = [
    [fmt(s.pages), "articles written by then"],
    [fmt(s.edges_all), "links between them"],
  ];
  if (K) st.push([`+${fmt(s.added)}`, `links new since ${S[K - 1].year}*`, "warm"], [`−${fmt(s.removed)}`, "links removed*", "red"]);
  $("stats").innerHTML = st.map(([v, l, c]) => `<div class="st ${c || ""}"><b>${v}</b><span>${l}</span></div>`).join("");
  let note = `Most linked-to: ${lk(s.top)}, ${fmt(s.top.in)} articles point to it.`;
  if (K && s.gainer) note += s.gainer.page_id === s.top.page_id
    ? ` It also gained the most since ${S[K - 1].year}: ${fmt(s.gainer.from)} → ${fmt(s.gainer.to)}.`
    : ` Biggest gain since ${S[K - 1].year}: <span class="warmt">${lk(s.gainer)}</span>, ${fmt(s.gainer.from)} → ${fmt(s.gainer.to)} incoming links.`;
  note += `<br><span class="mute small">Drawn: the ${fmt(N)} best-connected articles (${fmt(s.nodes_drawn)} existed then) and the ${fmt(s.edges_drawn)} links among them.${K ? " *counted over all articles." : ""}</span>`;
  $("note").innerHTML = note;
  // topics visible now, by drawn article count
  const cnt = new Map();
  for (let i = 0; i < N; i++) if (D.nodes.mask[i] >> K & 1) cnt.set(D.nodes.cluster[i], (cnt.get(D.nodes.cluster[i]) || 0) + 1);
  $("topics").innerHTML = `<b class="cap">Colour = topic cluster, named by its most typical category</b>` + [...cnt].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([c, n]) => `<span title="${n} articles drawn"><i style="background:${cssColor(c)}"></i>${esc(D.clusters[c] || "cluster " + c)}</span>`).join("");
}
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-pid]");
  if (!a) return;
  const i = byPid.get(+a.dataset.pid);
  if (i !== undefined) select(i, true);
  else window.open(wiki(a.dataset.pid), "_blank");
});

// ---------- timeline ----------
const maxE = Math.max(...S.map((s) => s.edges_all));
$("bars").innerHTML = S.map((s, k) => {
  const h = 6 + 30 * s.edges_all / maxE, nh = k ? 30 * s.added / maxE : 0;
  return `<div class="bar" data-k="${k}" title="${fmt(s.edges_all)} links as of ${s.label}">
    <span class="v">${s.edges_all >= 10000 ? Math.round(s.edges_all / 1000) + "k" : fmt(s.edges_all)}</span>
    <div class="col" style="height:${h}px"><i style="height:${nh}px"></i></div>
    </div>`;
}).join("");
$("years").innerHTML = S.map((s, k) => `<span class="y" data-k="${k}">${k === NS - 1 ? "today" : s.year}</span>`).join("");
$("years").addEventListener("click", (ev) => { const b = ev.target.closest(".y"); if (b) { stop(); setSnap(+b.dataset.k); } });
$("bars").addEventListener("click", (ev) => { const b = ev.target.closest(".bar"); if (b) { stop(); setSnap(+b.dataset.k); } });
$("slider").addEventListener("input", (ev) => { stop(); setSnap(+ev.target.value); });

let playing = null;
function stop() { clearInterval(playing); playing = null; $("play").textContent = "▶"; }
function play() {
  stop();
  setSnap(0);
  $("play").textContent = "❚❚";
  playing = setInterval(() => (K < NS - 1 ? setSnap(K + 1) : stop()), 1300);
}
$("play").addEventListener("click", () => (playing ? stop() : play()));
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space") { e.preventDefault(); playing ? stop() : play(); }
  if (e.key === "ArrowLeft" && K > 0) { stop(); setSnap(K - 1); }
  if (e.key === "ArrowRight" && K < NS - 1) { stop(); setSnap(K + 1); }
  if (e.key === "Escape") select(-1);
});

// ---------- labels ----------
const labelsEl = $("labels");
let labelIdx = [];
function pickLabels() {
  const k = K, order = [...Array(N).keys()].filter((i) => D.nodes.mask[i] >> k & 1)
    .sort((a, b) => indeg[b][k] - indeg[a][k]);
  const gi = k && S[k].gainer ? byPid.get(S[k].gainer.page_id) ?? -1 : -1;
  // priority: selected, the snapshot's biggest gainer, then the most linked-to articles
  labelIdx = [...new Set([sel, gi, ...order.slice(0, narrow ? 8 : 22)].filter((i) => i >= 0))];
  labelsEl.innerHTML = labelIdx.map((i) =>
    `<div class="nl${i === sel ? " sel" : ""}${i === gi ? " gain" : ""}">${esc(D.nodes.title[i])}</div>`).join("");
}
const v3 = new THREE.Vector3();
function placeLabels() {
  const els = labelsEl.children, boxes = [];
  for (let j = 0; j < labelIdx.length; j++) {
    const i = labelIdx[j], el = els[j];
    if (!el) continue;
    v3.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).project(camera);
    const x = (v3.x + 1) / 2 * innerWidth, y = (1 - v3.y) / 2 * innerHeight - nSize[i] * 0.3;
    const w = D.nodes.title[i].length * 3.4 + 4;          // half width, ~12px font
    // greedy de-clutter: labels are in importance order (selected and biggest first); skip ones that collide
    const hit = v3.z > 1 || !nSize[i] || boxes.some((b) => Math.abs(b[0] - x) < b[2] + w && Math.abs(b[1] - y) < 15);
    el.style.opacity = hit ? 0 : 1;
    if (hit) continue;
    boxes.push([x, y, w]);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }
}

// ---------- hover / select ----------
const byPid = new Map(D.nodes.page_id.map((p, i) => [p, i]));
const tip = $("tip");
let sel = -1, hov = -1, mouse = null;
function nearest(mx, my) {
  let best = -1, bd = 14 * 14;
  for (let i = 0; i < N; i++) {
    if (!nSize[i]) continue;
    v3.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).project(camera);
    if (v3.z > 1) continue;
    const dx = (v3.x + 1) / 2 * innerWidth - mx, dy = (1 - v3.y) / 2 * innerHeight - my;
    const d = dx * dx + dy * dy - nSize[i] * 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
canvas.addEventListener("pointermove", (e) => { mouse = [e.clientX, e.clientY]; });
canvas.addEventListener("pointerleave", () => { mouse = null; hov = -1; tip.style.display = "none"; });
let downAt = null;
canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
canvas.addEventListener("pointerup", (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const i = nearest(e.clientX, e.clientY);
  select(i);
});
function hover() {
  if (!mouse) return;
  const i = nearest(mouse[0], mouse[1]);
  hov = i;
  nMat.uniforms.uHov.value = eMat.uniforms.uHov.value = i;
  if (i < 0) { tip.style.display = "none"; canvas.style.cursor = "grab"; return; }
  canvas.style.cursor = "pointer";
  const d = indeg[i], k = K;
  const born = YEARS[Math.max(0, D.nodes.mask[i].toString(2).split("").reverse().indexOf("1"))];
  tip.innerHTML = `<b>${esc(D.nodes.title[i])}</b><br><span class="mute">${fmt(d[k])} incoming links ${k === NS - 1 ? "today" : "in " + YEARS[k]}`
    + (k ? ` · ${d[k] - d[k - 1] >= 0 ? "+" : ""}${fmt(d[k] - d[k - 1])} since ${YEARS[k - 1]}` : "")
    + `<br>topic: ${esc(D.clusters[D.nodes.cluster[i]] || "")} · in the web since ${born === YEARS[0] ? "≤ " + born : born}</span>`;
  tip.style.display = "block";
  tip.style.left = `${Math.min(mouse[0] + 14, innerWidth - 300)}px`;
  tip.style.top = `${Math.min(mouse[1] + 14, innerHeight - tip.offsetHeight - 8)}px`;
}

let detailReq = 0;
function select(i, fly = false) {
  sel = i;
  nMat.uniforms.uSel.value = eMat.uniforms.uSel.value = i;
  pickLabels();
  document.body.classList.toggle("has-detail", i >= 0);
  if (i < 0) { $("detail").style.display = "none"; return; }
  controls.autoRotate = false;
  if (fly) flyTo(i);
  openDetail(i, true);
}
let fly = null;
function flyTo(i) {
  const t = new THREE.Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  const dir = camera.position.clone().sub(controls.target).normalize();
  fly = { t0: performance.now(), fromT: controls.target.clone(), toT: t, fromP: camera.position.clone(),
    toP: t.clone().add(dir.multiplyScalar(narrow ? 380 : 260)) };
}

function chips(list, cls = "", cap = 60) {
  const shown = list.slice(0, cap).map((r) =>
    `<span class="${r.new ? "new" : ""} ${cls}" data-pid="${r.page_id}" title="${r.first ? "first seen " + (r.first === YEARS[NS - 1] ? "today" : "as of " + r.first) : ""}">${esc(r.title || "#" + r.page_id)}</span>`).join("");
  return `<div class="list">${shown}${list.length > cap ? `<span class="more">+${list.length - cap} more</span>` : ""}</div>`;
}
async function openDetail(i, fresh) {
  const box = $("detail"), pid = D.nodes.page_id[i], year = YEARS[K], req = ++detailReq;
  box.style.display = "block";
  if (fresh) box.innerHTML = `<button class="close">×</button><div class="sub">loading ${esc(D.nodes.title[i])} as of ${year}…</div>`;
  const r = await (await fetch(`/api/linkweb/node/${pid}?year=${year}`)).json();
  if (req !== detailReq) return;
  const when = K === NS - 1 ? "today" : `on 1 Jan ${year}`;
  const nIn = r.inn.filter((x) => x.new).length, nOut = r.out.filter((x) => x.new).length;
  const v = r.version;
  box.innerHTML = `<button class="close" title="Close (Esc)">×</button>
    <h2>${esc(r.title)}</h2>
    <div class="sub">Topic cluster: ${esc(D.clusters[D.nodes.cluster[i]] || "")}</div>
    <div class="sub">created ${r.created} · ${fmt(r.versions)} versions · <a href="${wiki(pid)}" target="_blank">open on fi.wikipedia ↗</a></div>
    <div class="ver">${v ? `The version current ${when}: <a href="https://fi.wikipedia.org/?oldid=${v.rev_id}" target="_blank">rev ${v.rev_id}</a>
      by ${esc(v.user)}, saved ${v.ts} UTC, ${fmt(v.len)} bytes with ${fmt(v.wikilinks)} wikilinks.`
      : `This article did not exist yet ${when}.`}
      <span class="ms">${r.ms} ms</span></div>
    <h3>Linked from · ${fmt(r.inn.length)} ${K ? `<em>+${nIn} new</em>` : ""}</h3>${r.inn.length ? chips(r.inn) : '<div class="mute small">nothing links here yet</div>'}
    ${r.in_gone.length ? `<h3>Links lost since ${YEARS[K - 1]}</h3>${chips(r.in_gone, "gone", 20)}` : ""}
    <h3>Links to · ${fmt(r.out.length)} ${K ? `<em>+${nOut} new</em>` : ""}</h3>${r.out.length ? chips(r.out) : '<div class="mute small">no links to other history articles</div>'}
    ${r.out_gone.length ? `<h3>Removed since ${YEARS[K - 1]}</h3>${chips(r.out_gone, "gone", 20)}` : ""}
    <details class="sqlbox"><summary>The SQL (live, ${r.ms} ms)</summary><pre class="sql">${esc(r.sql)}</pre></details>`;
  box.querySelector(".close").onclick = () => select(-1);
}

// ---------- search ----------
const sIn = $("search"), sRes = $("results");
sIn.addEventListener("input", () => {
  const q = sIn.value.trim().toLowerCase();
  if (q.length < 2) { sRes.style.display = "none"; return; }
  const hits = [];
  for (let i = 0; i < N && hits.length < 200; i++) if (D.nodes.title[i].toLowerCase().includes(q)) hits.push(i);
  hits.sort((a, b) => (D.nodes.title[b].toLowerCase().startsWith(q) - D.nodes.title[a].toLowerCase().startsWith(q)) || indeg[b][NS - 1] - indeg[a][NS - 1]);
  sRes.innerHTML = hits.slice(0, 12).map((i) => `<div data-i="${i}">${esc(D.nodes.title[i])}<span class="n">${indeg[i][NS - 1]}↘</span></div>`).join("")
    || '<div class="mute">not among the drawn articles</div>';
  sRes.style.display = "block";
});
sRes.addEventListener("click", (e) => { const d = e.target.closest("[data-i]"); if (d) { select(+d.dataset.i, true); sRes.style.display = "none"; sIn.value = ""; } });
sIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { const d = sRes.querySelector("[data-i]"); d && d.click(); } });

// ---------- loop ----------
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  nMat.uniforms.uPx.value = renderer.getPixelRatio() * innerHeight / 900;
});
const ease = (t) => 1 - Math.pow(1 - t, 3);
function frame(now) {
  if (tween < 1) {
    tween = Math.min(1, (now - tweenStart) / 1100);
    const t = ease(tween);
    for (let i = 0; i < N; i++) nSize[i] = nFrom[i] + (nTo[i] - nFrom[i]) * t;
    nGeo.attributes.size.needsUpdate = true;
  }
  eMat.uniforms.uFade.value = tween;
  eMat.uniforms.uT.value = now / 1000;
  if (fly) {
    const t = ease(Math.min(1, (now - fly.t0) / 900));
    controls.target.lerpVectors(fly.fromT, fly.toT, t);
    camera.position.lerpVectors(fly.fromP, fly.toP, t);
    if (t >= 1) fly = null;
  }
  controls.update();
  hover();
  placeLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------- start: today (or ?year=), with the links added since the previous snapshot glowing; ▶ replays ----------
const qYear = +params.get("year"), qPid = +params.get("page");
setSnap(YEARS.includes(qYear) ? YEARS.indexOf(qYear) : NS - 1, false);
if (params.get("play")) play();
if (qPid && byPid.has(qPid)) select(byPid.get(qPid), true);
requestAnimationFrame(frame);
