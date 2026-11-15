import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, Chip, Draw, H, Label, Panel, SceneFade, Stage, cue, prog, vo } from "../kit";
import { Flag } from "./shared";

// The idea: every edition, scored against the consensus, checked against the sources.
const LANGS = ["fi", "sv", "en", "de", "ru", "uk"];
export const S02: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const a = cue("s02", "every", 0, vo(1.6)), b = cue("s02", "scored", 0, vo(4.4)), c = cue("s02", "sources", 0, vo(8));
  return (
    <SceneFade dur={dur}>
      <Stage glow={0.5}>
        <AbsoluteFill>
          <svg width={1920} height={1080} style={{ position: "absolute" }}>
            <Draw d="M 640 540 L 800 540" t={prog(f, b - 12, 18)} color={C.accent} width={3} />
            <Draw d="M 1160 540 L 1320 540" t={prog(f, c - 12, 18)} color={C.accent} width={3} />
          </svg>
          <Panel style={{ position: "absolute", left: 220, top: 400, width: 420, padding: 34, opacity: prog(f, a, 20) }}>
            <H size={36}>Every edition</H>
            <div style={{ display: "flex", gap: 10, marginTop: 22, flexWrap: "wrap" }}>{LANGS.map((l, i) => <div key={l} style={{ opacity: prog(f, a + i * 4, 14) }}><Flag l={l} h={36} /></div>)}</div>
          </Panel>
          <Panel style={{ position: "absolute", left: 800, top: 400, width: 360, padding: 34, opacity: prog(f, b, 20) }}>
            <H size={36}>The consensus</H>
            <Label style={{ marginTop: 12 }}>what most editions tell</Label>
            <Chip color={C.accent} fill style={{ marginTop: 18 }}>no edition is the truth</Chip>
          </Panel>
          <Panel style={{ position: "absolute", left: 1320, top: 400, width: 380, padding: 34, opacity: prog(f, c, 20) }}>
            <H size={36}>The sources</H>
            <Label style={{ marginTop: 12 }}>cited pages and independent web sources</Label>
          </Panel>
        </AbsoluteFill>
      </Stage>
    </SceneFade>
  );
};
