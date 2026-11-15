// Kielipeili: the Glass Tiles Studio look (glass-tiles-studio/src/app/tiles/scene.ts, defaults from params.ts) on two
// parts of the page: "who resembles whom" (a grid of slabs) and the language score cards (one slab behind each card).
// Same slab geometry, physical iridescent material, light-panel environment, bloom, vignette and flip easing.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { VignetteShader } from "three/addons/shaders/VignetteShader.js";

// the studio's defaults (params.ts)
export const STUDIO = {
  color: "#5b8cff", emissive: "#2c5cff", emissiveStrength: 0.08, metalness: 0.2, roughness: 0.24, clearcoat: 1,
  iridescence: 0.9, iridescenceIor: 1.6, film: 420, sheen: 0.4, sheenColor: "#8fd4ff", envIntensity: 1.35,
  keyColor: "#3fb2ff", key: 1.6, fillColor: "#3a4dff", fill: 1.2, stripColor: "#ffffff", strip: 3.6, stripAngle: 40,
  rimColor: "#cfe3ff", rim: 2.4, lightTurn: 0, background: "#04070f", stage: "#eef3ff",
  bloom: 0.12, bloomRadius: 0.4, bloomThreshold: 0.75, exposure: 0.95, vignette: 0,
  thickness: 0.2, radius: 0.2, bevel: 0.05, ease: 0.8, axis: 45, duty: 0.7, sway: 5, drift: 0.55, tilt: 4, loop: 7.4,
};
const DEG = Math.PI / 180;
export const STAGE_HDR = (globalThis.__stage || [0.64, 0.89, 3.0]);

// "Reduce motion" keeps the glass look but stops the sway, the flips and the tilt
const STILL = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const glassSupported = () => {
  if (innerWidth < 760) return false;
  try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
};

const PRESS_MS = 900;
const easeInOut = (x, ease = STUDIO.ease) => { const k = 1 + ease * 3; return x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 - 2 * x, k); };

// studio tileGeometry: a rounded rectangle extruded with a bevel
function slabGeometry(w, h, thickness = STUDIO.thickness, radiusShare = STUDIO.radius, bevelShare = STUDIO.bevel) {
  const size = Math.min(w, h);
  const bevel = Math.min(bevelShare * size, thickness * 0.49, radiusShare * size * 0.99);
  const hw = w / 2 - bevel, hh = h / 2 - bevel;
  const r = Math.max(0.0001, Math.min(radiusShare * size - bevel, hw, hh));
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh); s.lineTo(hw - r, -hh); s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r); s.quadraticCurveTo(hw, hh, hw - r, hh); s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r); s.lineTo(-hw, -hh + r); s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  const g = new THREE.ExtrudeGeometry(s, { bevelEnabled: bevel > 0, bevelSegments: 6, bevelSize: bevel, bevelThickness: bevel,
    curveSegments: 24, depth: Math.max(0.001, thickness - 2 * bevel) });
  g.center();
  return g;
}

// studio buildEnv: light panels, a rim ring and a streak around a dark dome, baked into an environment map
function studioEnv(renderer) {
  const S = STUDIO, scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(30, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(S.background), side: THREE.BackSide })));
  const group = new THREE.Group(); group.rotation.z = S.lightTurn * DEG; scene.add(group);
  const panel = (color, intensity, w, h, x, y, z, rz = 0) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    mesh.position.set(x, y, z); mesh.lookAt(0, 0, 0); mesh.rotateZ(rz); group.add(mesh);
  };
  panel(S.keyColor, S.key, 11, 11, -4.5, 4.5, 6);
  panel(S.fillColor, S.fill, 11, 11, 4.5, -4.5, 6);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.9, 12, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(S.rimColor).multiplyScalar(S.rim) }));
  ring.position.z = 1.5; group.add(ring);
  panel(S.keyColor, S.key * 0.35, 10, 4, 0, -8, -2);
  panel(S.stripColor, S.strip, 16, 0.35, 0, 1.5, 7, S.stripAngle * DEG);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.02).texture;
  scene.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  pmrem.dispose();
  return tex;
}

function studioMaterial(color = STUDIO.color, glow = STUDIO.emissiveStrength) {
  const S = STUDIO;
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color), emissive: new THREE.Color(S.emissive), emissiveIntensity: glow, metalness: S.metalness,
    roughness: S.roughness, clearcoat: S.clearcoat, clearcoatRoughness: S.roughness * 0.5, iridescence: S.iridescence,
    iridescenceIOR: S.iridescenceIor, iridescenceThicknessRange: [S.film * 0.4, S.film], sheen: S.sheen,
    sheenColor: new THREE.Color(S.sheenColor), sheenRoughness: 0.4, envMapIntensity: S.envIntensity,
  });
}

function studioRenderer(canvas) {
  const S = STUDIO;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = S.exposure;
  const scene = new THREE.Scene();
  // the light stage colour, pre-boosted so that it comes out as #eef3ff after ACES tone mapping
  scene.background = new THREE.Color().setRGB(...STAGE_HDR);
  scene.environment = studioEnv(renderer);
  const camera = new THREE.PerspectiveCamera(18, 1, 0.05, 200);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), S.bloom, S.bloomRadius, S.bloomThreshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const vignette = new ShaderPass(VignetteShader);
  vignette.uniforms.offset.value = 1; vignette.uniforms.darkness.value = S.vignette;
  composer.addPass(vignette);
  const resize = (w, h) => {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio); renderer.setSize(w, h, false);
    composer.setPixelRatio(ratio); composer.setSize(w, h);
    camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  };
  return { renderer, scene, camera, composer, resize };
}

// similarity -> glass tone (deep navy -> blue -> pale ice blue) and glow
const DEEP = new THREE.Color("#122658"), MID = new THREE.Color(STUDIO.color), PALE = new THREE.Color("#dcecff");
const tone = v => {
  if (v == null) return DEEP.clone();
  const t = Math.max(0, Math.min(1, v / 100));
  return t < 0.6 ? DEEP.clone().lerp(MID, t / 0.6) : MID.clone().lerp(PALE, (t - 0.6) / 0.4);
};
const glowOf = v => STUDIO.emissiveStrength * (0.4 + 1.6 * Math.max(0, Math.min(1, (v ?? 0) / 100)));

// ---------------------------------------------------------------- who resembles whom: a grid of slabs
export function mountGlassHeat(host, { onPick, onHover, flag, name }) {
  host.innerHTML = `<div class="gh-stage"><canvas class="gh-canvas"></canvas><div class="gh-labels"></div></div>`;
  const stage = host.querySelector(".gh-stage"), canvas = host.querySelector(".gh-canvas"), layer = host.querySelector(".gh-labels");
  const { scene, camera, composer, resize: rs } = studioRenderer(canvas);
  const grid = new THREE.Group(); scene.add(grid);
  const geo = slabGeometry(0.86, 0.86), diagGeo = slabGeometry(0.86, 0.86, 0.05);
  const axis = new THREE.Vector3(Math.cos(STUDIO.axis * DEG), Math.sin(STUDIO.axis * DEG), 0);
  let tiles = [], langs = [], selected = null, hovered = null, raf = 0, visible = true;
  const t0 = performance.now(), raycaster = new THREE.Raycaster(), ptr = new THREE.Vector2();

  function build(ls) {
    langs = ls;
    tiles.forEach(t => { grid.remove(t.mesh); t.mesh.material.dispose(); });
    tiles = []; layer.innerHTML = "";
    const n = ls.length, off = (n - 1) / 2;
    ls.forEach((a, i) => ls.forEach((b, j) => {
      const diag = a === b, mat = studioMaterial(diag ? "#c4d3f5" : STUDIO.color, diag ? 0 : STUDIO.emissiveStrength);
      if (diag) { mat.transparent = true; mat.opacity = 0.5; mat.iridescence = 0.3; }
      const mesh = new THREE.Mesh(diag ? diagGeo : geo, mat);
      mesh.position.set(j - off, off - i, 0); mesh.userData = { a, b, i, j, diag };
      grid.add(mesh);
      const label = document.createElement("span"); label.className = "gh-v"; layer.appendChild(label);
      tiles.push({ mesh, label, v: null, diag, i, j, flip: 0 });
    }));
    ls.forEach(l => {
      const r = document.createElement("span"); r.className = "gh-row"; r.innerHTML = `${flag(l)}<b>${name(l)}</b>`; layer.appendChild(r);
      const c = document.createElement("span"); c.className = "gh-col"; c.innerHTML = `${flag(l)}<b>${l.toUpperCase()}</b>`; layer.appendChild(c);
    });
    layout();
  }

  function setValue(t, v) {
    t.v = v;
    if (t.diag) { t.label.textContent = ""; return; }
    const c = tone(v);
    t.mesh.material.color.copy(c);
    t.label.textContent = v == null ? "" : v === 0 ? "·" : Math.round(v);
    t.label.classList.toggle("dark", 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.42);
  }

  function project(x, y, z = 0.12) {
    const p = new THREE.Vector3(x, y, z).applyMatrix4(grid.matrixWorld).project(camera);
    return [(p.x + 1) / 2 * stage.clientWidth, (1 - p.y) / 2 * stage.clientHeight];
  }

  function placeLabels() {
    grid.updateMatrixWorld();
    const off = (langs.length - 1) / 2;
    tiles.forEach(t => {
      const [x, y] = project(t.mesh.position.x, t.mesh.position.y);
      t.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      const pu = t.press ? Math.min(1, (performance.now() - t.press) / PRESS_MS) : 0;
      t.label.style.opacity = (t.flip > 0.2 && t.flip < 0.8) || (pu > 0.08 && pu < 0.92) ? 0 : 1;
    });
    layer.querySelectorAll(".gh-row").forEach((el, i) => { const [x, y] = project(-off - 0.62, off - i); el.style.transform = `translate(${x}px, ${y}px) translate(-100%, -50%)`; });
    layer.querySelectorAll(".gh-col").forEach((el, j) => { const [x, y] = project(j - off, off + 0.66); el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`; });
  }

  function layout() {
    rs(stage.clientWidth, stage.clientHeight);
    const n = Math.max(1, langs.length);
    camera.fov = 18;
    // fit the whole grid plus its labels: visible height = 2 d tan(fov/2), width scaled by the aspect
    const need = n + 1.9, aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
    const d = Math.max(need, (n + 2.6) / aspect) / (2 * Math.tan(9 * DEG));
    camera.position.set(0.15, 0.3, d);
    camera.lookAt(0.15, 0.3, 0);
    camera.updateProjectionMatrix();
  }

  // the studio's slow loop: the plane sways and drifts; the slabs flip when the values change
  function frame(now) {
    // a fixed pose (no idle sway): the scene draws only while a tile flips, lifts or the hover changes
    grid.rotation.set(-STUDIO.tilt * DEG * 4, 0.03, 0);
    grid.position.set(0.55, -0.1, 0);
    let moving = false;
    tiles.forEach(t => {
      const sel = selected && ((t.mesh.userData.a === selected[0] && t.mesh.userData.b === selected[1]) || (t.mesh.userData.a === selected[1] && t.mesh.userData.b === selected[0]));
      if (!t.diag) {
        t.mesh.material.emissive.set(sel ? STUDIO.keyColor : STUDIO.emissive);
        t.mesh.material.emissiveIntensity = sel ? 0.4 : glowOf(t.v) + (hovered === t ? 0.2 : 0);
      }
      t.mesh.position.z = hovered === t ? 0.14 : sel ? 0.07 : 0;
      let turn = Math.PI * easeInOut(t.flip);
      if (t.press) {
        const u = Math.min(1, (now - t.press) / PRESS_MS);
        turn += 2 * Math.PI * easeInOut(u);
        if (u >= 1) t.press = 0; else moving = true;
      }
      if (t.flip > 0 && t.flip < 1) moving = true;
      t.mesh.quaternion.setFromAxisAngle(axis, turn);
    });
    placeLabels();
    composer.render();
    raf = (moving || now < keepUntil) && visible && !document.hidden ? requestAnimationFrame(frame) : 0;
  }
  let keepUntil = 0;
  const kick = (ms = 0) => { keepUntil = Math.max(keepUntil, performance.now() + ms); if (!raf) raf = requestAnimationFrame(frame); };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); });
  io.observe(stage);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });

  function update(matrix, animate = true) {
    const ls = matrix.langs;
    if (ls.join() !== langs.join()) { build(ls); animate = false; }
    const target = tiles.map(t => t.diag ? null : matrix.get(langs[t.i], langs[t.j]));
    if (!animate || STILL()) { tiles.forEach((t, k) => { setValue(t, target[k]); t.flip = 0; }); kick(); return; }
    const start = performance.now(), dur = 1000 * STUDIO.duty * 1.3, spread = 75, done = new Set();
    const tick = now => {
      let busy = false;
      tiles.forEach((t, k) => {
        if (t.diag) return;
        const u = Math.max(0, Math.min(1, (now - start - (t.i + t.j) * spread) / dur));
        if (u < 1) busy = true;
        t.flip = u;
        if (u >= 0.5 && !done.has(k)) { done.add(k); setValue(t, target[k]); }
      });
      if (busy) requestAnimationFrame(tick); else tiles.forEach(t => { t.flip = 0; });
    };
    requestAnimationFrame(tick);
    kick(dur + (langs.length * 2) * spread + 100);
  }

  function pick(e) {
    const r = canvas.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ptr, camera);
    const hit = raycaster.intersectObjects(grid.children)[0];
    return hit ? tiles.find(t => t.mesh === hit.object) : null;
  }
  canvas.addEventListener("pointermove", e => {
    const t = pick(e), next = t && !t.diag ? t : null;
    canvas.style.cursor = next ? "pointer" : "default";
    if (next !== hovered) { hovered = next; kick(); }
    onHover?.(e, next ? { a: next.mesh.userData.a, b: next.mesh.userData.b, v: next.v } : null);
  });
  canvas.addEventListener("pointerleave", () => { hovered = null; kick(); onHover?.(null, null); });
  canvas.addEventListener("click", e => {
    const t = pick(e); if (!t || t.diag) return;
    if (STILL()) { onPick?.(t.mesh.userData.a, t.mesh.userData.b); return; }
    t.press = performance.now(); kick();
    setTimeout(() => onPick?.(t.mesh.userData.a, t.mesh.userData.b), PRESS_MS * 0.85);
  });
  const ro = new ResizeObserver(() => { layout(); kick(); }); ro.observe(stage);

  return {
    update,
    select(a, b) { selected = a && b ? [a, b] : null; kick(); },
    destroy() { ro.disconnect(); io.disconnect(); cancelAnimationFrame(raf); host.innerHTML = ""; },
  };
}

// ---------------------------------------------------------------- score cards: one slab behind each card
export function mountGlassCards(stage, cardsEl) {
  const canvas = document.createElement("canvas"); canvas.className = "kg-canvas";
  stage.prepend(canvas);
  const { scene, camera, composer, resize: rs } = studioRenderer(canvas);
  const group = new THREE.Group(); scene.add(group);
  const axis = new THREE.Vector3(Math.cos(STUDIO.axis * DEG), Math.sin(STUDIO.axis * DEG), 0);
  let slabs = [], raf = 0, flipStart = 0, flipping = false, visible = true;
  const t0 = performance.now();

  function layout(fresh) {
    rs(stage.clientWidth, stage.clientHeight);
    camera.fov = 18; camera.position.set(0, 0, 14); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    const scale = 2 * camera.position.z * Math.tan(camera.fov / 2 * DEG) / Math.max(1, stage.clientHeight);
    // untransformed layout boxes (offset*), never getBoundingClientRect: a card may be mid-flip when we measure
    const SW = stage.clientWidth, SH = stage.clientHeight, cards = [...cardsEl.querySelectorAll(".kpi")];
    const boxX = cardsEl.offsetLeft, boxY = cardsEl.offsetTop;
    while (slabs.length > cards.length) { const s = slabs.pop(); group.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    cards.forEach((card, i) => {
      const r = { left: boxX + card.offsetLeft, top: boxY + card.offsetTop, width: card.offsetWidth, height: card.offsetHeight };
      const w = (r.width - 4) * scale, h = (r.height - 4) * scale;
      let s = slabs[i];
      if (!s) { s = { mesh: new THREE.Mesh(slabGeometry(w, h, 0.22, 0.12, 0.04), studioMaterial()), rx: 0, ry: 0, tx: 0, ty: 0, w, h }; group.add(s.mesh); slabs[i] = s; }
      else if (Math.abs(s.w - w) > 0.01 || Math.abs(s.h - h) > 0.01) { s.mesh.geometry.dispose(); s.mesh.geometry = slabGeometry(w, h, 0.22, 0.12, 0.04); s.w = w; s.h = h; }
      const cx = r.left + r.width / 2 - SW / 2, cy = r.top + r.height / 2 - SH / 2;
      s.mesh.position.set(cx * scale, -cy * scale, 0);
      s.on = card.classList.contains("on");
    });
    if (fresh && !STILL()) { flipStart = performance.now(); flipping = true; }
    kick();
  }

  function frame(now) {
    const tau = (((now - t0) / 1000) % STUDIO.loop) / STUDIO.loop * Math.PI * 2;
    group.rotation.set(0, 0, 0);
    let busy = false;
    slabs.forEach((s, i) => {
      s.rx += (s.tx - s.rx) * 0.18; s.ry += (s.ty - s.ry) * 0.18;
      if (Math.abs(s.tx - s.rx) + Math.abs(s.ty - s.ry) > 0.002) busy = true;
      let flip = 0;
      if (flipping) {
        const u = Math.max(0, Math.min(1, (now - flipStart - i * 80) / (1000 * STUDIO.duty * 1.2)));
        flip = 1 - u; if (u < 1) busy = true;
      }
      let spin = 0;
      if (s.press) {
        const u = Math.min(1, (now - s.press) / PRESS_MS);
        spin = 2 * Math.PI * easeInOut(u); if (u < 1) busy = true; else s.press = 0;
      }
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.rx, s.ry + spin, 0));
      q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, Math.PI * easeInOut(flip)));
      s.mesh.quaternion.copy(q);
      s.mesh.position.z = s.on ? 0.18 : 0;
      s.mesh.material.emissive.set(s.on ? STUDIO.keyColor : STUDIO.emissive);
      s.mesh.material.emissiveIntensity = s.on ? 0.28 : STUDIO.emissiveStrength;
    });
    if (flipping && !busy) flipping = false;
    composer.render();
    raf = busy && visible && !document.hidden ? requestAnimationFrame(frame) : 0;
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); });
  io.observe(stage);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });

  cardsEl.addEventListener("pointermove", e => {
    const card = e.target.closest(".kpi"); if (!card || STILL()) return;
    const i = [...cardsEl.querySelectorAll(".kpi")].indexOf(card), s = slabs[i]; if (!s) return;
    const r = card.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    slabs.forEach((o, k) => { if (k !== i) { o.tx = 0; o.ty = 0; } });
    s.tx = y * 0.35; s.ty = x * 0.45; kick();
  });
  cardsEl.addEventListener("pointerleave", () => { slabs.forEach(s => { s.tx = 0; s.ty = 0; }); kick(); });
  const ro = new ResizeObserver(() => layout(false)); ro.observe(stage);

  return { layout, flip(i) { if (slabs[i] && !STILL()) { slabs[i].press = performance.now(); kick(); } }, destroy() { ro.disconnect(); io.disconnect(); cancelAnimationFrame(raf); canvas.remove(); } };
}
