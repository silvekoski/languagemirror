import { AbsoluteFill } from "remotion";
import { C, FadeUp, H, Label, MONO, SceneFade, Stage, cue, vo } from "../kit";
import { Quote } from "./shared";

// Hook: one event, two Wikipedias, two stories (from the Claude review of fi vs ru, Suomen sisällissota).
export const S01: React.FC<{ dur: number }> = ({ dur }) => (
  <SceneFade dur={dur}>
    <Stage glow={0.5}>
      <AbsoluteFill style={{ padding: "150px 160px", gap: 60 }}>
        <FadeUp at={vo(0)}><Label style={{ fontFamily: MONO }} color={C.sub}>Finland, 1918 · the civil war</Label></FadeUp>
        <FadeUp at={cue("s01", "depends", 0, vo(4.2))}><H size={76}>Ask Wikipedia. The answer depends on your language.</H></FadeUp>
        <div style={{ display: "flex", gap: 40, marginTop: 10 }}>
          <FadeUp at={cue("s01", "Russian", 0, vo(7))}><Quote l="ru" who="Russian Wikipedia" text="The rising was a planned coup." color="#d6409f" /></FadeUp>
          <FadeUp at={cue("s01", "Finnish", 0, vo(9.5))}><Quote l="fi" who="Finnish Wikipedia" text="A power struggle in the labour movement." color="#2f6fed" /></FadeUp>
        </div>
        <FadeUp at={cue("s01", "right", 0, vo(11.5))}><H size={64} color={C.accent}>So which one is right?</H></FadeUp>
      </AbsoluteFill>
    </Stage>
  </SceneFade>
);
