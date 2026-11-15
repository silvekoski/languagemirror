# Video (Remotion template)

A pitch or demo video: React scenes, real screen recordings of the app, and an ElevenLabs voice, sound effects and music.
Made from `.claude/skills/remotion-video/template`. Read that skill's `SKILL.md` for the method.

```sh
pnpm install                  # or npm install
npm run theme -- <url>        # take the app's colours, fonts, radius and logo (src/site-theme.json); --reset undoes
npm run timeline              # script.json + clips + sounds -> src/timeline.json, words.json, audio.json
npm run studio                # preview and scrub at http://localhost:3000
cp .env.example .env          # paste ELEVENLABS_API_KEY
npm run audio                 # ElevenLabs: missing sounds, changed voice clips, music; then the timeline
npm run rec -- R1             # screen recordings from rec/takes.mjs to public/rec/ (needs ffmpeg, the app running)
npm run words -- s02          # each spoken word with its second, to place cues
npm run typecheck
npm run render                # out/video.mp4
```

On NixOS: `REMOTION_BROWSER=$(readlink -f $(which chromium))` for studio, still and render;
`CHROME_PATH=$(readlink -f $(which chromium))` and `nix shell nixpkgs#ffmpeg` for `rec` and `timeline`.

| Path | What |
|---|---|
| `video.config.json` | title, address, size, fps, voice, automatic sounds, music |
| `script.json` | one row per scene: `id`, `text` (narration) or `seconds`; optional `hold`, `voAt`, `frames`, `enter`, `sfx` |
| `sfx.json` | the named sounds and their ElevenLabs prompts |
| `src/theme.ts` | the default look (colours, fonts, logos), overridden by `src/site-theme.json` |
| `src/site-theme.json` | the measured look of the app, from `npm run theme`; `{}` = the default look |
| `src/kit.tsx` | shared components and motion: `FadeUp`, `H`, `Type`, `Chip`, `Panel`, `Stage`, `RecWindow`, `FullClip`, `Draw`, `Rail`, `cue`, `vo` |
| `src/scenes/` | one file per scene, registered in `index.ts` |
| `src/cues.ts` | the stage rail, extra sounds |
| `rec/` | Playwright takes, manual takes, a live browser REPL, the theme measurement |
| `vo/` | ElevenLabs voice, sounds and music; word timings; timeline builder |
