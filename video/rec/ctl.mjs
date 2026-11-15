// A long-lived visible browser you drive by POSTing JavaScript to http://127.0.0.1:9555. The code runs with
// `p` (page), `b` (browser), `ctx`, `rec` (startRecording) and `sleep` in scope. Good for trying a take step by step:
//   node rec/ctl.mjs &
//   curl -s localhost:9555 -d 'await p.goto("http://localhost:3000"); return await p.title()'
import http from "node:http";
import { launch } from "./helpers.mjs";
import { startRecording as rec } from "./screencast.mjs";

const b = await launch({ headless: false, args: ["--window-size=1920,1180", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
Object.assign(globalThis, { p, b, ctx, rec, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  try { const fn = new Function("return (async () => {" + body + "})()"); const r = await fn(); res.end(JSON.stringify(r ?? null, null, 1) + "\n"); }
  catch (e) { res.end("ERR " + e.stack + "\n"); }
}).listen(9555, () => console.log("ready on :9555"));
