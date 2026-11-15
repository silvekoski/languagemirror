import { C, Chip, FadeUp, RecWindow, SceneFade, Stage, cue, vo } from "../kit";

// The mirror: click a grey paragraph to read it in English.
export const S05: React.FC<{ dur: number }> = ({ dur }) => (
  <SceneFade dur={dur}>
    <Stage glow={0.3}>
      <RecWindow dur={dur} width={1560} src="R3.mp4" startFrom={1.5} playbackRate={1}
        overlay={<FadeUp at={cue("s05", "English", 0, vo(6))} style={{ position: "absolute", right: 28, bottom: 24 }}><Chip color={C.accent} fill size={22}>translated by Claude</Chip></FadeUp>} />
    </Stage>
  </SceneFade>
);
