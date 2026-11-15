import { C, Chip, FadeUp, RecWindow, SceneFade, Stage, cue, vo } from "../kit";

// Any article: paste a link and load it (Stepan Bandera).
export const S08: React.FC<{ dur: number }> = ({ dur }) => (
  <SceneFade dur={dur}>
    <Stage glow={0.3}>
      <RecWindow dur={dur} width={1560} src="R5.mp4" startFrom={19} playbackRate={1}
        overlay={<FadeUp at={cue("s08", "Polish", 0, vo(5))} style={{ position: "absolute", right: 28, bottom: 24 }}><Chip color={C.accent} fill size={22}>9 of 68 editions compared</Chip></FadeUp>} />
    </Stage>
  </SceneFade>
);
