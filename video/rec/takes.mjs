// The screen recordings of the Language Mirror pitch video: the real app on the real data.
// Run: npm run rec            (all takes)
//      npm run rec -- R2 R3   (some)
// BASE_URL defaults to the app on this machine (the wiki service, port 3016).
import { glide, press, smoothScroll } from "./helpers.mjs";

export const BASE = process.env.BASE_URL || "http://127.0.0.1:3016";

// 1280x800 at device scale 1.5 records at 1920x1200: sharp text, and RecWindow crops to 16:9.
export const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1.5 };

const CIVIL_WAR = "/kielipeili.html?topic=Suomen%20sis%C3%A4llissota&lang=ru";

/** Scroll so that `sel` sits `offset` px below the top of the window. */
const scrollToSel = async (page, sel, ms, offset = 70) => {
  const y = await page.evaluate(([s, o]) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect().top + scrollY - o : scrollY; }, [sel, offset]);
  await smoothScroll(page, Math.max(0, y), ms);
};
const t = (t0) => +((Date.now() - t0) / 1000).toFixed(2);

export const takes = {
  // Scores for the Finnish Civil War: the six glass cards, then how the index is made.
  R1: {
    url: CIVIL_WAR + "#overview",
    async act(page) {
      await page.waitForSelector(".kpi", { timeout: 30000 });
      await page.waitForTimeout(2500);
      const t0 = Date.now();
      await scrollToSel(page, "#overview", 1600, 40);
      const cards = t(t0);
      await glide(page, page.locator(".kpi").nth(0), { ms: 900 });
      await page.waitForTimeout(500);
      await glide(page, page.locator(".kpi").nth(5), { ms: 1400 });
      await page.waitForTimeout(900);
      await scrollToSel(page, "#analysis", 1800, 40);
      const analysis = t(t0);
      await glide(page, page.locator("#agree .bd").nth(5), { ms: 1200 });
      await page.waitForTimeout(2200);
      return { cards, analysis };
    },
  },

  // Disagreements: the war's end date, with the source verdicts.
  R2: {
    url: CIVIL_WAR + "#disagreements",
    async act(page) {
      await page.waitForSelector("details.conf", { timeout: 30000 });
      await page.waitForTimeout(1500);
      const t0 = Date.now();
      await scrollToSel(page, "#conflicts", 1400, 40);
      await page.waitForTimeout(600);
      const row = page.locator("details.conf").filter({ hasText: "End date of the war" }).first();
      // No scrollIntoViewIfNeeded: its "stable" check never settles while the page clock is slowed.
      const y = await page.evaluate(() => { const r = [...document.querySelectorAll("details.conf")].find((d) => d.textContent.includes("End date of the war")); return r ? r.getBoundingClientRect().top + scrollY - 260 : scrollY; });
      await smoothScroll(page, Math.max(0, y), 900);
      await press(page, row.locator("summary"), { ms: 1100 });
      const opened = t(t0);
      await page.waitForTimeout(1200);
      await scrollToSel(page, 'details.conf[open]', 1200, 120);
      await page.waitForTimeout(3500);
      return { opened };
    },
  },

  // The mirror: both articles paragraph by paragraph; click a gap to read it in English.
  R3: {
    url: CIVIL_WAR + "#compare",
    async act(page) {
      await page.waitForSelector("#mirrorSvg .blk", { timeout: 30000 });
      await page.waitForTimeout(2500);
      const t0 = Date.now();
      await scrollToSel(page, "#mirror", 1400, 40);
      await page.waitForTimeout(800);
      const gap = page.locator("#mirrorSvg .blk.gap").nth(6);
      await press(page, gap, { ms: 1300, fx: 0.5 });
      const clicked = t(t0);
      await page.waitForFunction(() => !document.querySelector(".para-en")?.textContent.includes("Translating"), null, { timeout: 60000 });
      await page.waitForTimeout(500);
      await scrollToSel(page, "#paraPanel", 1200, 260);
      await page.waitForTimeout(3000);
      return { clicked };
    },
  },

  // Over time: who resembles whom, played through the years (the glass tiles flip).
  R4: {
    url: CIVIL_WAR + "#history",
    async act(page) {
      await page.waitForSelector("#resemble", { timeout: 30000 });
      await page.waitForTimeout(3500);
      const t0 = Date.now();
      await scrollToSel(page, "#resemble", 1600, 30);
      await page.waitForTimeout(800);
      await press(page, page.locator("#play"), { ms: 900 });
      const play = t(t0);
      await page.waitForTimeout(6500);
      await glide(page, page.locator(".move").first(), { ms: 1200 });
      await page.waitForTimeout(1500);
      return { play };
    },
  },

  // Any article: paste a Wikipedia link and load it (Stepan Bandera, from the Ukrainian Wikipedia).
  R5: {
    url: "/kielipeili.html?topic=Harald%20Nugiseks#overview",
    async act(page) {
      await page.waitForSelector(".kpi", { timeout: 30000 });
      await page.evaluate(() => scrollTo(0, 0));   // the #overview hash jumps to the scores section
      await page.waitForTimeout(1500);
      const t0 = Date.now();
      const box = page.locator("#loadQ");
      await press(page, box, { ms: 1000 });
      await page.keyboard.type("https://uk.wikipedia.org/wiki/Степан_Бандера", { delay: 35 });
      const typed = t(t0);
      await press(page, page.locator(".loadform button"), { ms: 700 });
      await page.waitForFunction(() => document.querySelector("#topic")?.value === "Stepan Bandera" && document.querySelectorAll(".kpi").length >= 9, null, { timeout: 120000 });
      const loaded = t(t0);
      await page.waitForTimeout(1200);
      await scrollToSel(page, "#overview", 1500, 40);
      await page.waitForTimeout(3000);
      return { typed, loaded };
    },
  },
};
