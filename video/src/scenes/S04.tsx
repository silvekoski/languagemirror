import { C, Chip, FadeUp, RecWindow, SceneFade, Stage, cue, vo } from "../kit";

// Disagreements: the war's end date; the German claim is contradicted by the sources.
export const S04: React.FC<{ dur: number }> = ({ dur }) => (
  <SceneFade dur={dur}>
    <Stage glow={0.3}>
      <RecWindow dur={dur} width={1560} src="R2.mp4" startFrom={0.5} playbackRate={0.66}
        overlay={<FadeUp at={cue("s04", "fifteenth", 0, vo(13))} style={{ position: "absolute", right: 28, bottom: 24 }}><Chip color={C.accent} fill size={22}>checked with Context.dev</Chip></FadeUp>} />
    </Stage>
  </SceneFade>
);
