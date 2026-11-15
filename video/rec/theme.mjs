// Reads the look of a website and writes it to src/site-theme.json, so the video matches the app:
// colours (background, text, muted text, accent, borders, cards), fonts (downloaded to public/fonts/), corner radius,
// light or dark, and the logo (public/logos/site-logo.png). It reads what the browser renders, not the source.
//
// Usage: node rec/theme.mjs [url] [--dark] [--no-logo] [--logo "<css selector>"]
//        node rec/theme.mjs --reset          back to the template's own look
// Without a url it uses `url` from video.config.json. Check out/site.png and out/theme.png after a run.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CURSOR, launch } from "./helpers.mjs";

const root = new URL("../", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const OUT_JSON = root + "src/site-theme.json";

if (flag("--reset")) {
  writeFileSync(OUT_JSON, "{}\n");
  rmSync(root + "public/fonts", { recursive: true, force: true });
  rmSync(root + "public/logos/site-logo.png", { force: true });
  console.log("src/site-theme.json reset: the video uses the template's own look.");
  process.exit(0);
}

const config = JSON.parse(readFileSync(root + "video.config.json", "utf8"));
let url = args.find((a) => !a.startsWith("--") && a !== opt("--logo")) ?? config.url;
if (!/^https?:\/\//.test(url)) url = (url.startsWith("localhost") ? "http://" : "https://") + url;

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: flag("--dark") ? "dark" : "light" });
await ctx.addInitScript(CURSOR);
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
mkdirSync(root + "out", { recursive: true });
await page.screenshot({ path: root + "out/site.png" });

// ---- Colours, fonts and radius, measured in the page ----
const found = await page.evaluate(() => {
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const g = cv.getContext("2d", { willReadFrequently: true });
  // Any CSS colour (rgb, oklch, lab, color-mix...) -> [r, g, b, a] through the canvas.
  const rgba = (c) => {
    if (!c || c === "transparent" || !CSS.supports("color", c)) return null;
    g.clearRect(0, 0, 1, 1); g.fillStyle = "#000"; g.fillStyle = c; g.fillRect(0, 0, 1, 1);
    const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : [r, gg, b, a / 255];
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05;
  };
  // The page background: the opaque background behind points near the edges (body, html or a wrapper div).
  const behind = (x, y) => { for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) { const c = rgba(getComputedStyle(el).backgroundColor); if (c && c[3] > 0.9) return c; } return null; };
  const votes = new Map();
  for (const [x, y] of [[12, 450], [1428, 450], [720, 890], [12, 890], [1428, 890]]) { const c = behind(x, y); if (c) { const k = c.slice(0, 3).join(","); votes.set(k, (votes.get(k) ?? 0) + 1); } }
  let bg = votes.size ? [...[...votes.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number), 1] : null;
  for (const el of [document.body, document.documentElement]) { if (bg) break; const c = rgba(getComputedStyle(el).backgroundColor); if (c && c[3] > 0.9) bg = c; }
  bg ??= [255, 255, 255, 1];
  const over = (c) => (c[3] >= 1 ? c.slice(0, 3) : c.slice(0, 3).map((v, i) => Math.round(v * c[3] + bg[i] * (1 - c[3]))));
  const tally = () => new Map();
  const add = (m, c, w) => { if (!c) return; const k = over(c).join(","); m.set(k, (m.get(k) ?? 0) + w); };
  const texts = tally(), borders = tally(), cards = tally(), fills = tally(), accents = tally();
  const radii = [];
  const all = [...document.querySelectorAll("body *")].slice(0, 6000);
  for (const el of all) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    if (own.length) add(texts, rgba(s.color), own.length);
    const bw = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) + parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth);
    const bcol = rgba(s.borderTopColor) ?? rgba(s.borderBottomColor);
    if (bw >= 1 && bcol && s.borderTopStyle !== "none") add(borders, bcol, (r.width + r.height) * 2);
    const fill = rgba(s.backgroundColor);
    const radius = parseFloat(s.borderTopLeftRadius) || 0;
    const area = r.width * r.height;
    if (fill && area > 400) {
      if ((bw >= 1 || s.boxShadow !== "none") && radius >= 4 && area > 6000) { add(cards, fill, area); radii.push(radius); }
      else if (area < 900 * 1440 * 0.6) add(fills, fill, area);
    }
    const interactive = el.matches("button, [role=button], a, input[type=submit], [class*=btn], [class*=button], [class*=primary]");
    if (interactive) {
      if (fill && area > 600) { add(accents, fill, area); if (radius) radii.push(radius); }
      if (own.length && el.matches("a")) add(accents, rgba(s.color), 400);
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, w]) => ({ rgb: k.split(",").map(Number), w }));
  const fam = (sel) => { const el = document.querySelector(sel); return el && visible(el) ? getComputedStyle(el).fontFamily : null; };
  // Brand variables, when the site has them (hex, rgb, oklch, or shadcn's bare "222 47% 11%").
  const vars = {};
  const rootStyle = getComputedStyle(document.documentElement);
  for (const v of ["--primary", "--accent", "--brand", "--color-primary", "--color-accent", "--color-brand", "--ring"]) {
    const raw = rootStyle.getPropertyValue(v).trim();
    if (!raw) continue;
    const c = rgba(raw) ?? rgba(`hsl(${raw})`) ?? rgba(`hsl(${raw.replace(/\s+/g, ",")})`);
    if (c) vars[v] = over(c);
  }
  radii.sort((a, b) => a - b);
  return {
    bg: over(bg), texts: top(texts), borders: top(borders), cards: top(cards), fills: top(fills), accents: top(accents), vars,
    radius: radii.length ? radii[Math.floor(radii.length / 2)] : null,
    fonts: { display: fam("h1") ?? fam("h2") ?? fam("body"), text: fam("p") ?? fam("body"), mono: fam("code") ?? fam("pre") ?? fam("kbd") },
    title: document.title,
  };
});

// ---- Turn the measurements into the theme ----
const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const sat = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const bg = found.bg;
const dark = lum(bg) < 0.25;
const text = found.texts.find((t) => contrast(t.rgb, bg) >= 7)?.rgb ?? found.texts[0]?.rgb ?? (dark ? [240, 240, 240] : [26, 26, 26]);
const sub = found.texts.find((t) => dist(t.rgb, text) > 30 && sat(t.rgb) < 0.25 && contrast(t.rgb, bg) >= 2.5 && contrast(t.rgb, bg) < contrast(text, bg))?.rgb ?? mix(text, bg, 0.45);
const varAccent = Object.values(found.vars).find((c) => sat(c) > 0.3 && contrast(c, bg) > 1.8);
const seenAccent = found.accents.find((a) => sat(a.rgb) > 0.3 && contrast(a.rgb, bg) > 1.8 && dist(a.rgb, bg) > 40)?.rgb;
const neutralAccent = found.accents.find((a) => dist(a.rgb, bg) > 60)?.rgb;
const accent = varAccent ?? seenAccent ?? neutralAccent ?? text;
const accentIsColour = sat(accent) > 0.3;
const line = found.borders.find((b) => dist(b.rgb, bg) > 6 && contrast(b.rgb, bg) < 2.2)?.rgb ?? mix(bg, text, 0.1);
const panel = found.cards[0]?.rgb ?? bg;
const panel2 = found.fills.find((f) => dist(f.rgb, bg) > 4 && dist(f.rgb, panel) > 4 && sat(f.rgb) < 0.2 && contrast(f.rgb, bg) < 1.5)?.rgb ?? mix(bg, text, dark ? 0.06 : 0.04);

const colors = {
  bg: hex(bg), panel: hex(panel), panel2: hex(panel2), line: hex(line), line2: hex(mix(line, text, 0.1)),
  text: hex(text), sub: hex(sub), dim: hex(mix(sub, bg, 0.4)), accent: hex(accent),
};

// ---- Fonts: download the @font-face files of the families in use ----
const first = (stack) => stack?.split(",")[0].trim().replace(/^["']|["']$/g, "");
const families = { display: first(found.fonts.display), text: first(found.fonts.text), mono: first(found.fonts.mono) };
const want = new Set(Object.values(families).filter(Boolean));
const css = [];
for (const href of await page.$$eval("link[rel=stylesheet]", (ls) => ls.map((l) => l.href))) {
  const r = await page.request.get(href).catch(() => null);
  if (r?.ok()) css.push({ base: href, text: await r.text() });
}
for (const t of await page.$$eval("style", (ss) => ss.map((s) => s.textContent))) css.push({ base: url, text: t });
// Follow one level of @import (Google Fonts, Typekit).
for (const c of [...css]) for (const m of c.text.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/g)) {
  const href = new URL(m[1], c.base).href; const r = await page.request.get(href).catch(() => null);
  if (r?.ok()) css.push({ base: href, text: await r.text() });
}
// unicode-range "U+0-FF,U+131,U+2??" covers code point cp?
const covers = (range, cp) => range.split(",").some((part) => {
  const m = part.trim().replace(/^u\+/i, "");
  const [a, b] = m.includes("?") ? [m.replace(/\?/g, "0"), m.replace(/\?/g, "F")] : m.split("-").concat(m.split("-").length === 1 ? [m] : []).slice(0, 2);
  return parseInt(a, 16) <= cp && cp <= parseInt(b, 16);
});
const faces = [];
for (const c of css) for (const block of c.text.match(/@font-face\s*{[^}]*}/g) ?? []) {
  const prop = (p) => block.match(new RegExp(`${p}\\s*:\\s*([^;}]+)`))?.[1]?.trim();
  const family = prop("font-family")?.replace(/^["']|["']$/g, "");
  if (!family || !want.has(family)) continue;
  const range = prop("unicode-range");
  if (range && !covers(range, 0x41)) continue; // keep the subset with Latin letters only
  const srcs = [...(prop("src") ?? "").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/g)];
  const pickSrc = srcs.find((s) => /woff2/.test(s[2] ?? s[1])) ?? srcs.find((s) => /woff/.test(s[2] ?? s[1])) ?? srcs[0];
  if (!pickSrc || pickSrc[1].startsWith("data:")) continue;
  faces.push({ family, url: new URL(pickSrc[1], c.base).href, weight: prop("font-weight") ?? "400", style: prop("font-style") ?? "normal" });
}
rmSync(root + "public/fonts", { recursive: true, force: true });
const fontFiles = [];
const seenUrl = new Set();
for (const f of faces) {
  if (seenUrl.has(f.url)) continue; seenUrl.add(f.url);
  const r = await page.request.get(f.url, { headers: { referer: url } }).catch(() => null);
  if (!r?.ok()) continue;
  mkdirSync(root + "public/fonts", { recursive: true });
  const ext = (f.url.match(/\.(woff2|woff|ttf|otf)(\?|$)/)?.[1]) ?? "woff2";
  const file = `fonts/${f.family.replace(/[^\w-]+/g, "_")}-${fontFiles.length}.${ext}`;
  writeFileSync(root + "public/" + file, await r.body());
  fontFiles.push({ family: f.family, file, weight: f.weight, style: f.style });
}
const loaded = new Set(fontFiles.map((f) => f.family));
// Use a site family only when its files came down; otherwise the template's Inter and JetBrains Mono stay.
const fonts = {
  display: loaded.has(families.display) ? found.fonts.display : undefined,
  text: loaded.has(families.text) ? found.fonts.text : undefined,
  mono: loaded.has(families.mono) ? found.fonts.mono : undefined,
  faces: fontFiles,
};

// ---- Logo: the home link or a logo image in the header, cut out with a transparent background ----
let logo;
if (!flag("--no-logo")) {
  const handle = await page.evaluateHandle((sel) => {
    const ok = (el) => { const r = el?.getBoundingClientRect(); return r && r.width >= 16 && r.height >= 12 && r.width <= 520 && r.height <= 160 && r.top < 200; };
    if (sel) return document.querySelector(sel);
    const head = document.querySelector("header, nav, [role=banner]") ?? document.body;
    const cands = [
      ...head.querySelectorAll("[class*=logo i], [id*=logo i], img[alt*=logo i], [aria-label*=logo i], svg[aria-label]"),
      ...head.querySelectorAll(`a[href="/"], a[href="${location.origin}/"], a[href="${location.origin}"]`),
      ...head.querySelectorAll("a img, a svg"),
    ];
    return cands.find(ok) ?? null;
  }, opt("--logo") ?? null);
  const el = handle.asElement();
  if (el) {
    // Clear the backgrounds behind the logo so the PNG is transparent.
    await el.evaluate((n) => {
      const st = document.createElement("style");
      st.textContent = ".__cut,.__cut::before,.__cut::after{background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important;border-color:transparent!important}";
      document.head.appendChild(st);
      for (let p = n; p; p = p.parentElement) p.classList.add("__cut");
    });
    mkdirSync(root + "public/logos", { recursive: true });
    await el.screenshot({ path: root + "public/logos/site-logo.png", omitBackground: true });
    logo = "site-logo.png";
  }
}

const theme = {
  source: url, measured: new Date().toISOString().slice(0, 10), title: found.title,
  url: new URL(url).host, dark, colors, fonts, radius: found.radius ?? undefined,
  glow: accentIsColour ? 1 : 0.35, logo,
};
writeFileSync(OUT_JSON, JSON.stringify(theme, null, 2) + "\n");

// A swatch sheet to check the result by eye: out/theme.png.
const sw = Object.entries(colors).map(([k, v]) => `<div style="display:flex;align-items:center;gap:12px;margin:6px 0"><div style="width:64px;height:36px;border-radius:8px;background:${v};border:1px solid #8884"></div><code>${k} ${v}</code></div>`).join("");
await page.setContent(`<body style="font:16px system-ui;padding:24px;background:#fff">${sw}<p>display: ${fonts.display ?? "(template Inter)"}<br>text: ${fonts.text ?? "(template Inter)"}<br>mono: ${fonts.mono ?? "(template JetBrains Mono)"}<br>font files: ${fontFiles.length} · radius: ${theme.radius ?? "-"} · ${dark ? "dark" : "light"} · logo: ${logo ?? "none"}</p></body>`);
await page.screenshot({ path: root + "out/theme.png", fullPage: true });
await browser.close();

console.log(`theme from ${url} (${dark ? "dark" : "light"})`);
for (const [k, v] of Object.entries(colors)) console.log(`  ${k.padEnd(7)} ${v}`);
console.log(`  accent  ${accentIsColour ? "a brand colour" : "neutral (no brand colour found): glow turned down"}`);
console.log(`  fonts   display ${families.display ?? "-"}${fonts.display ? "" : " (not downloadable: Inter stays)"}, text ${families.text ?? "-"}${fonts.text ? "" : " (Inter stays)"}, mono ${families.mono ?? "-"}${fonts.mono ? "" : " (JetBrains Mono stays)"}; ${fontFiles.length} files`);
console.log(`  radius  ${theme.radius ?? "-"}   logo ${logo ? "public/logos/site-logo.png" : "none found (try --logo '<selector>')"}`);
console.log("Check out/site.png and out/theme.png. Undo with: npm run theme -- --reset");
