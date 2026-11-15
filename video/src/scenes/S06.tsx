import { C, Chip, FadeUp, RecWindow, SceneFade, Stage, cue, vo } from "../kit";

// Who resembles whom, played through the years: the glass tiles flip per snapshot.
export const S06: React.FC<{ dur: number }> = ({ dur }) => (
  <SceneFade dur={dur}>
    <Stage glow={0.3}>
      <RecWindow dur={dur} width={1560} src="R4.mp4" startFrom={14.2} playbackRate={1}
        overlay={<FadeUp at={cue("s06", "copy", 0, vo(7))} style={{ position: "absolute", right: 28, bottom: 24 }}><Chip color={C.accent} fill size={22}>Ukrainian ↔ Russian: 98% shared</Chip></FadeUp>} />
    </Stage>
  </SceneFade>
);
