import { Config } from "@remotion/cli/config";
Config.setChromiumOpenGlRenderer("angle");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
// NixOS and other systems where Remotion's downloaded headless shell does not run: point at a local Chrome or Chromium.
if (process.env.REMOTION_BROWSER) Config.setBrowserExecutable(process.env.REMOTION_BROWSER);
