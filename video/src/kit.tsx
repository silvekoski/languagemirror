// Shared look and motion for every scene: one accent, slow eased motion, frames tied to the voice.
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/jetbrains-mono";
import React from "react";
import { AbsoluteFill, Audio, Easing, Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import audioJson from "./audio.json";
import config from "../video.config.json";
import { C, DARK, DISPLAY, GLOW, LOGOS, MONO, RADIUS, TEXT, URL } from "./theme";
import timeline from "./timeline.json";
import words from "./words.json";

export { C, DARK, DISPLAY, MONO, RADIUS, TEXT };

/** src/audio.json, written by `npm run timeline`. Typed here because its fields can be null. */
export const AUDIO = audioJson as {
  cues: { frame: number; sound: string; volume: number }[];
  typing: { sound: string; volume: number } | null;
  music: { file: string; volume: number } | null;
};
export const FPS = config.fps;
export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const inOut = Easing.bezier(0.65, 0, 0.35, 1);

/** `#RRGGBB` + alpha → `rgba(...)`. */
export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** 0→1 over `dur` frames starting at `start`, with the house ease. */
export const prog = (f: number, start: number, dur = 20, e = ease) =>
  interpolate(f, [start, start + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The scene frame at `s` seconds into the voice clip (the clip starts `voAt` frames into the scene). */
export const vo = (s: number, voAt = config.voAt) => Math.round(voAt + s * FPS);

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/**
 * The scene frame at which the voice of scene `id` says `word` (its `nth` occurrence, from 0).
 * Needs vo/<id>.align.json (from vo/generate.py) and `npm run timeline`. Without timings it returns `fallback`.
 */
export const cue = (id: string, word: string, nth = 0, fallback = 0) => {
  const list = ((words as Record<string, [string, number][]>)[id] ?? []).filter(([w]) => norm(w) === norm(word));
  const row = timeline.find((t) => t.id === id);
  if (!list[nth] || !row) return fallback;
  return Math.round(row.voAt + list[nth][1] * FPS);
};

/** Fades in and rises 8 px; fades out from frame `out`. */
export const FadeUp: React.FC<{ at?: number; dur?: number; y?: number; out?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({ at = 0, dur = 18, y = 8, out, style, children }) => {
  const f = useCurrentFrame();
  const t = prog(f, at, dur);
  const o = out === undefined ? 1 : 1 - prog(f, out, 12);
  return <div style={{ opacity: t * o, transform: `translateY(${(1 - t) * y}px)`, ...style }}>{children}</div>;
};

export const H: React.FC<{ size?: number; weight?: number; color?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ size = 64, weight = 560, color = C.text, style, children }) => (
  <div style={{ fontFamily: DISPLAY, fontVariationSettings: "'opsz' 32", fontSize: size, fontWeight: weight, letterSpacing: "-0.02em", lineHeight: 1.08, color, ...style }}>{children}</div>
);
export const Label: React.FC<{ size?: number; color?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ size = 22, color = C.sub, style, children }) => (
  <div style={{ fontFamily: TEXT, fontSize: size, fontWeight: 450, color, letterSpacing: "-0.005em", ...style }}>{children}</div>
);
export const Mono: React.FC<{ size?: number; color?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ size = 20, color = C.sub, style, children }) => (
  <span style={{ fontFamily: MONO, fontSize: size, color, letterSpacing: "-0.01em", ...style }}>{children}</span>
);

/** Text that types in at `cps` characters per second, with a blinking caret and the typing sound (`sound={false}` for none). */
export const Type: React.FC<{ text: string; at?: number; cps?: number; caret?: boolean; sound?: boolean }> = ({ text, at = 0, cps = 40, caret = true, sound = true }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = Math.max(0, Math.floor(((f - at) / fps) * cps));
  const done = n >= text.length;
  const typing = AUDIO.typing;
  return (
    <>
      {sound && typing && (
        <Sequence from={at} durationInFrames={Math.max(1, Math.ceil((text.length / cps) * fps))} layout="none" name="typing">
          <Audio src={staticFile(`sfx/${typing.sound}.mp3`)} loop volume={typing.volume} />
        </Sequence>
      )}
      {text.slice(0, n)}
      {caret && f >= at && (!done || Math.floor(f / 15) % 2 === 0) ? <span style={{ opacity: 0.7 }}>▍</span> : null}
    </>
  );
};

export const Chip: React.FC<{ color?: string; fill?: boolean; mono?: boolean; size?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({ color = C.sub, fill, mono, size = 18, style, children }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", gap: 8, padding: `${size * 0.32}px ${size * 0.62}px`, borderRadius: 999,
    border: `1px solid ${fill ? "transparent" : color === C.sub ? C.line2 : color + "66"}`, background: fill ? color + (DARK ? "33" : "1A") : C.panel,
    color, fontFamily: mono ? MONO : TEXT, fontSize: size, fontWeight: 500, whiteSpace: "nowrap", ...style,
  }}>{children}</span>
);

export const Panel: React.FC<{ style?: React.CSSProperties; children?: React.ReactNode }> = ({ style, children }) => (
  <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: RADIUS, boxShadow: DARK ? `0 18px 50px -24px rgba(0,0,0,0.6)` : `0 0 0 3px ${alpha(C.accent, 0.04 * GLOW)}, 0 18px 50px -24px ${alpha(C.accent, 0.28 * GLOW)}`, ...style }}>{children}</div>
);

/** Background: the theme colour with one soft accent glow (scaled by GLOW from the theme). */
export const Stage: React.FC<{ glow?: number; glowX?: number; glowY?: number; children?: React.ReactNode }> = ({ glow = 0.5, glowX = 50, glowY = -10, children }) => (
  <AbsoluteFill style={{ background: C.bg }}>
    <AbsoluteFill style={{ background: `radial-gradient(1200px 520px at ${glowX}% ${glowY}%, ${alpha(C.accent, 0.16 * glow * GLOW)}, transparent 70%)` }} />
    {children}
  </AbsoluteFill>
);

/** A logo from the LOGOS table in theme.ts. A mono mark is drawn black, or white with `invert` (the default on a dark theme). */
export const Logo: React.FC<{ name: string; h: number; invert?: boolean; style?: React.CSSProperties; opacity?: number }> = ({ name, h, invert = DARK, style, opacity = 1 }) => {
  const l = LOGOS[name];
  if (!l) throw new Error(`Logo "${name}" is not in LOGOS (src/theme.ts)`);
  const filter = l.mono ? (invert ? "brightness(0) invert(1)" : "brightness(0)") : undefined;
  return <Img src={staticFile("logos/" + l.file)} style={{ height: h, width: "auto", opacity, filter, ...style }} />;
};

/**
 * A screen recording (public/rec/<src>, made by rec/record.mjs) in a browser window with a slow 3 % push-in.
 * Without `src` it shows `children` as the screen, which is handy before the recording exists.
 * `startFrom` is in seconds into the recording.
 */
export const RecWindow: React.FC<{ src?: string; startFrom?: number; dur: number; playbackRate?: number; width?: number; origin?: string; url?: string; style?: React.CSSProperties; overlay?: React.ReactNode; children?: React.ReactNode }> = ({ src, startFrom = 0, dur, playbackRate = 1, width = 1440, origin = "50% 40%", url = URL, style, overlay, children }) => {
  const f = useCurrentFrame();
  const t = prog(f, 0, 22);
  const push = interpolate(f, [0, dur], [1, 1.03], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ width, opacity: t, transform: `translateY(${(1 - t) * 24}px) scale(${lerp(0.985, 1, t)})`, ...style }}>
        <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${C.line2}`, boxShadow: `0 40px 100px -30px rgba(${DARK ? "0,0,0,0.7" : "26,26,26,0.35"}), 0 0 0 4px ${alpha(C.accent, 0.06 * GLOW)}`, background: C.bg, position: "relative" }}>
          <div style={{ height: 34, background: DARK ? "#26272B" : "#F3F4F6", borderBottom: `1px solid ${DARK ? "#34353A" : "#E5E7EB"}`, display: "flex", alignItems: "center", gap: 7, padding: "0 14px" }}>
            {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => <div key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />)}
            <div style={{ flex: 1, textAlign: "center", fontFamily: TEXT, fontSize: 13, color: DARK ? "#9CA3AF" : "#6B7280", marginRight: 50 }}>{url}</div>
          </div>
          <div style={{ overflow: "hidden", height: Math.round((width * 9) / 16) - 34, position: "relative" }}>
            <div style={{ transform: `scale(${push})`, transformOrigin: origin, height: "100%" }}>
              {src
                ? <OffthreadVideo src={staticFile("rec/" + src)} startFrom={Math.round(startFrom * FPS)} playbackRate={playbackRate} muted style={{ width: "100%", display: "block" }} />
                : children}
            </div>
          </div>
          {overlay}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** A full-screen clip (a game, a phone, a field video) with a slow push-in and an optional title and note. */
export const FullClip: React.FC<{ dur: number; src: string; startFrom?: number; playbackRate?: number; title?: string; note?: string }> = ({ dur, src, startFrom = 0, playbackRate = 1, title, note }) => {
  const f = useCurrentFrame();
  const t = prog(f, 12, 20);
  return (
    <SceneFade dur={dur} inF={6}>
      <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
        <OffthreadVideo src={staticFile("rec/" + src)} startFrom={Math.round(startFrom * FPS)} playbackRate={playbackRate} muted
          style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${interpolate(f, [0, dur], [1, 1.03])})` }} />
        <div style={{ position: "absolute", left: 0, right: 0, top: 120, display: "flex", flexDirection: "column", alignItems: "center", opacity: t, transform: `translateY(${(1 - t) * 8}px)` }}>
          {title && <div style={{ fontFamily: DISPLAY, fontSize: 64, fontWeight: 400, letterSpacing: "-0.02em", color: "#F7F8F8" }}>{title}</div>}
          {note && <div style={{ fontFamily: MONO, fontSize: 24, color: "#F7F8F8", marginTop: 8, padding: "10px 18px", borderRadius: 10, background: "rgba(8,9,10,0.62)", backdropFilter: "blur(8px)", border: "1px solid rgba(255,255,255,0.12)" }}>{note}</div>}
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

/** An SVG path that draws itself (t from 0 to 1). With `dash` it fades in as a dashed line instead. */
export const Draw: React.FC<{ d: string; t: number; color?: string; width?: number; dash?: string; opacity?: number }> = ({ d, t, color = C.line2, width = 1.5, dash, opacity = 1 }) => (
  <path d={d} fill="none" stroke={color} strokeWidth={width} pathLength={1} strokeDasharray={dash ?? "1 1"} strokeDashoffset={dash ? undefined : 1 - t} opacity={dash ? t * opacity : opacity} strokeLinecap="round" />
);

/** A thin row of stages at the top of the frame; `active` is lit. Video.tsx shows it over the scenes in RAIL. */
export const Rail: React.FC<{ stages: string[]; active: number; opacity?: number }> = ({ stages, active, opacity = 1 }) => (
  <div style={{ position: "absolute", top: 42, left: 0, right: 0, display: "flex", justifyContent: "center", opacity }}>
    <div style={{ display: "flex", alignItems: "center" }}>
      {stages.map((s, i) => (
        <React.Fragment key={s}>
          {i > 0 && <div style={{ width: 56, height: 1, background: i <= active ? alpha(C.accent, 0.5) : C.line2 }} />}
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 14px" }}>
            <div style={{ width: 7, height: 7, borderRadius: 4, background: i === active ? C.accent : i < active ? alpha(C.accent, 0.5) : C.dim, boxShadow: i === active ? `0 0 12px ${C.accent}` : undefined }} />
            <span style={{ fontFamily: TEXT, fontSize: 17, fontWeight: 500, color: i === active ? C.text : C.sub, letterSpacing: "-0.01em" }}>{s}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  </div>
);

/** Fades a whole scene in and out at its edges. */
export const SceneFade: React.FC<{ dur: number; inF?: number; outF?: number; children: React.ReactNode }> = ({ dur, inF = 10, outF = 10, children }) => {
  const f = useCurrentFrame();
  const o = Math.min(prog(f, 0, inF, inOut), 1 - prog(f, dur - outF, outF, inOut));
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

/** A round face from public/avatars/<slug>.jpg. */
export const Face: React.FC<{ slug: string; size?: number; style?: React.CSSProperties }> = ({ slug, size = 28, style }) => (
  <Img src={staticFile(`avatars/${slug}.jpg`)} style={{ width: size, height: size, borderRadius: size, objectFit: "cover", boxShadow: `0 0 0 2px ${C.bg}`, ...style }} />
);

/** A full-frame photo or generated background from public/ with a slow drift. */
export const PhotoBg: React.FC<{ src: string; dur: number; dim?: number }> = ({ src, dur, dim = 0 }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: "#05060A", overflow: "hidden" }}>
      <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${interpolate(f, [0, dur], [1.04, 1.12])}) translateX(${interpolate(f, [0, dur], [0, -18])}px)`, filter: `brightness(${1 - dim})` }} />
    </AbsoluteFill>
  );
};
