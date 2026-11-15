// The look of this video. The defaults below are the template's own look (light, Inter, one blue accent).
// `npm run theme -- <url>` measures a website and writes src/site-theme.json, which overrides them: colours,
// fonts, corner radius, light or dark, logo. `npm run theme -- --reset` goes back to the defaults.
// Edit the defaults here, or edit src/site-theme.json after a measurement to correct one value.
import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";
import config from "../video.config.json";
import siteJson from "./site-theme.json";

type SiteTheme = Partial<{
  url: string;
  dark: boolean;
  colors: Partial<typeof DEFAULT>;
  fonts: { display?: string; text?: string; mono?: string; faces?: { family: string; file: string; weight: string; style: string }[] };
  radius: number;
  glow: number;
  logo: string;
}>;
export const SITE = siteJson as SiteTheme;

const DEFAULT = {
  bg: "#FFFFFF",
  panel: "#FFFFFF",
  panel2: "#F4F4F5",
  line: "#E7E7EA",
  line2: "#D9D9DE",
  text: "#1A1A1A",
  sub: "#737373",
  dim: "#A3A3A3",
  accent: "#4A90F0",
  amber: "#9A6B00",
  red: "#D23F31",
  good: "#2F8A3E",
};
export const C = { ...DEFAULT, ...SITE.colors };

/** True when the background is dark: the browser window chrome and shadows follow it. */
export const DARK = SITE.dark ?? false;
/** Corner radius of cards and panels, from the site when measured. */
export const RADIUS = SITE.radius ?? 14;
/** Strength of the soft accent glow on Stage. Lower for a site with a neutral (black or grey) accent. */
export const GLOW = SITE.glow ?? 1;

const INTER = "'Inter Variable', Inter, system-ui, sans-serif";
const JETBRAINS = "'JetBrains Mono Variable', ui-monospace, monospace";
/** Headings. */
export const DISPLAY = SITE.fonts?.display ? `${SITE.fonts.display}, ${INTER}` : INTER;
/** Labels, chips, body text. */
export const TEXT = SITE.fonts?.text ? `${SITE.fonts.text}, ${INTER}` : INTER;
export const MONO = SITE.fonts?.mono ? `${SITE.fonts.mono}, ${JETBRAINS}` : JETBRAINS;
// The site's font files (public/fonts/), loaded before the first frame renders.
for (const f of SITE.fonts?.faces ?? []) {
  loadFont({ family: f.family, url: staticFile(f.file), weight: f.weight, style: f.style }).catch((e) => console.warn("font", f.file, e));
}

/** The address shown in the title bar of RecWindow. */
export const URL = SITE.url ?? config.url;

// Logos in public/logos. `mono: true` marks a dark or single-colour mark: Logo draws it black (or white with invert).
// After `npm run theme`, "product" is the logo cut from the site, in its own colours.
export const LOGOS: Record<string, { file: string; mono?: boolean }> = {
  product: SITE.logo ? { file: SITE.logo } : { file: "product.svg", mono: true },
};
