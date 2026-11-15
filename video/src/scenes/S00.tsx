import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, H, MONO, SceneFade, Stage, prog } from "../kit";
import { GlobeBand } from "./shared";

// Opening card: the Toolcraft globe loop, the name, the challenge.
export const S00: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const g = prog(f, 0, 14), t = prog(f, 4, 22), sub = prog(f, 16, 22);
  return (
    <SceneFade dur={dur} inF={1} outF={12}>
      <Stage glow={0.7} glowY={30}>
        <GlobeBand top={220} opacity={g} />
        <AbsoluteFill style={{ justifyContent: "center", paddingLeft: 140 }}>
          <div style={{ opacity: t, transform: `translateY(${(1 - t) * 18}px)`, filter: `blur(${(1 - t) * 6}px)` }}>
            <H size={150} style={{ letterSpacing: "-0.035em", lineHeight: 1 }}>Language<br />Mirror</H>
          </div>
          <div style={{ marginTop: 40, opacity: sub, fontFamily: MONO, fontSize: 26, color: C.sub }}>MariaDB · Wikipedia Through Time · Junction 2026</div>
        </AbsoluteFill>
      </Stage>
    </SceneFade>
  );
};
