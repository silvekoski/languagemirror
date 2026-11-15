// Records a Playwright Chromium page through the CDP screencast and streams the JPEG frames
// straight into ffmpeg as 30 fps H.264, so no frame folder goes to disk.
import { spawn } from "node:child_process";

export async function startRecording(page, outFile, { quality = 92, slow = 1 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const vp = page.viewportSize();
  const dpr = await page.evaluate(() => devicePixelRatio);
  const W = Math.round((vp.width * dpr) / 2) * 2, H = Math.round((vp.height * dpr) / 2) * 2;
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "30", "-c:v", "mjpeg", "-i", "-",
    "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "16", outFile],
    { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((ok, fail) => ff.on("close", (c) => (c === 0 ? ok() : fail(new Error("ffmpeg failed for " + outFile)))));
  // The screencast sends a frame only when the screen changes: repeat the last frame to hold a constant 30 fps.
  let t0 = null, last = null, written = 0;
  const fill = (t) => { while (last && written < Math.floor(((t - t0) / slow) * 30)) { ff.stdin.write(last); written++; } };
  cdp.on("Page.screencastFrame", (f) => {
    const t = f.metadata.timestamp;
    t0 ??= t;
    fill(t);
    last = Buffer.from(f.data, "base64");
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const wall0 = Date.now() / 1000;
  return async function stop() {
    await cdp.send("Page.stopScreencast").catch(() => {});
    if (t0 !== null) fill(t0 + (Date.now() / 1000 - wall0) + slow / 30);
    ff.stdin.end();
    await done;
    return { seconds: +(written / 30).toFixed(2) };
  };
}
