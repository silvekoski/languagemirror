import { C, Chip, FadeUp, RecWindow, SceneFade, Stage, cue, vo } from "../kit";

// Scores: the six editions of the Finnish Civil War article, then how the index is made.
export const S03: React.FC<{ dur: number }> = ({ dur }) => (
  <SceneFade dur={dur}>
    <Stage glow={0.3}>
      <RecWindow dur={dur} width={1560} src="R1.mp4" startFrom={7.5} playbackRate={0.9}
        overlay={<FadeUp at={cue("s03", "least", 0, vo(6))} style={{ position: "absolute", right: 28, bottom: 24 }}><Chip color={C.accent} fill size={22}>index = 0.5 coverage + 0.3 agreement + 0.2 sourcing</Chip></FadeUp>} />
    </Stage>
  </SceneFade>
);
