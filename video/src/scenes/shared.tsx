import { Img, Loop, OffthreadVideo, staticFile } from "remotion";
import { C, TEXT } from "../kit";

export const Flag: React.FC<{ l: string; h?: number }> = ({ l, h = 34 }) => (
  <Img src={staticFile(`img/flags/${l}.svg`)} style={{ height: h, width: h * 1.4, objectFit: "cover", borderRadius: 5, boxShadow: "0 0 0 1px rgba(0,0,0,.08)" }} />
);
export const Quote: React.FC<{ l: string; who: string; text: string; color: string }> = ({ l, who, text, color }) => (
  <div style={{ background: "#fff", borderRadius: 26, padding: "34px 40px", width: 700, boxShadow: `inset 0 0 0 1px ${C.line}, 0 24px 50px -30px rgba(40,90,220,.4)`, borderLeft: `6px solid ${color}` }}>
    <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: TEXT, fontSize: 26, color: C.sub }}><Flag l={l} h={30} />{who}</div>
    <div style={{ fontFamily: TEXT, fontSize: 44, lineHeight: 1.25, color: C.text, marginTop: 18, fontWeight: 500 }}>{text}</div>
  </div>
);

/** The Toolcraft globe loop (wikitime-globe-studio, 8 s, 3:1) as a full-width band that fades into the stage. */
export const GlobeBand: React.FC<{ top?: number; opacity?: number }> = ({ top = 220, opacity = 1 }) => {
  const mask = "linear-gradient(180deg, rgba(0,0,0,0) 0, #000 14%, #000 86%, rgba(0,0,0,0) 100%)";
  return (
    <div style={{ position: "absolute", left: 0, top, width: 1920, height: 640, opacity, WebkitMaskImage: mask, maskImage: mask }}>
      <Loop durationInFrames={240}>
        <OffthreadVideo src={staticFile("img/hero-globe.mp4")} muted style={{ width: 1920, height: 640, objectFit: "cover" }} />
      </Loop>
    </div>
  );
};
