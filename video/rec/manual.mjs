// A manual take: opens a visible browser at a URL and records while you use it. F9 (or closing the window) stops.
// Use it for things a script cannot drive well: a game, a canvas, a live demo. Usage: node rec/manual.mjs R9 http://localhost:3000/play
import { mkdirSync } from "node:fs";
import { launch } from "./helpers.mjs";
import { startRecording } from "./screencast.mjs";

const [id, url] = process.argv.slice(2);
if (!id || !url) throw new Error("Usage: node rec/manual.mjs <id> <url>");
const OUT = new URL("../public/rec/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await launch({ headless: false, args: ["--window-size=1920,1180", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
let stopped;
const done = new Promise((r) => (stopped = r));
await page.exposeFunction("__stopRec", () => stopped());
await page.addInitScript(() => addEventListener("keydown", (e) => e.key === "F9" && window.__stopRec(), true));
page.on("close", () => stopped());
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(2000);
console.log("Recording. F9 stops.");
const stop = await startRecording(page, OUT + id + ".mp4");
await done;
console.log(id, await stop());
await browser.close().catch(() => {});
