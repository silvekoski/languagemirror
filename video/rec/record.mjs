// Records the takes in rec/takes.mjs to public/rec/<id>.mp4 (30 fps H.264, needs ffmpeg on PATH).
// Usage: node rec/record.mjs [ids...]
import { mkdirSync } from "node:fs";
import { CURSOR, SLOW, SLOWMO, launch } from "./helpers.mjs";
import { startRecording } from "./screencast.mjs";
import { BASE, VIEWPORT, takes } from "./takes.mjs";

const OUT = new URL("../public/rec/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const want = new Set(process.argv.slice(2));
for (const id of want) if (!takes[id]) throw new Error(`No take ${id} in rec/takes.mjs`);

const { deviceScaleFactor, ...viewport } = VIEWPORT;
const browser = await launch();
const ctx = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion: "no-preference" });
await ctx.addInitScript(CURSOR);
await ctx.addInitScript(SLOWMO);
const page = await ctx.newPage();
page.setDefaultTimeout(60000);   // a hung wait fails the take instead of recording forever
// Playwright waits run SLOW times longer, so they match the slowed page clock.
const realWait = page.waitForTimeout.bind(page);
page.waitForTimeout = (ms) => realWait(ms * SLOW);
const cdp = await ctx.newCDPSession(page);
const scale = (m) => (m && typeof m === "object" ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? +(v / SLOW).toFixed(2) : v])) : m);

for (const [id, take] of Object.entries(takes)) {
  if (want.size && !want.has(id)) continue;
  await page.goto(BASE + take.url, { waitUntil: "load" });
  page.__mouse = null;
  if (SLOW !== 1) { await cdp.send("Animation.enable"); await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 / SLOW }); }
  await page.waitForTimeout(take.settle ?? 2500);
  await page.mouse.move(viewport.width - 100, viewport.height - 40);
  page.__mouse = { x: viewport.width - 100, y: viewport.height - 40 };
  const stop = await startRecording(page, OUT + id + ".mp4", { slow: SLOW });
  const marks = await take.act(page);
  console.log(id, await stop(), scale(marks) ?? "");
}
await browser.close();
