// Lays the scenes, the voice clips, the sound effects, the rail and the music on one timeline.
// You edit scenes in src/scenes/, narration and sounds in script.json, extras in src/cues.ts. Not this file, usually.
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import config from "../video.config.json";
import script from "../script.json";
import { AUDIO, C, DISPLAY, H, Label, MONO, Rail, SceneFade, Stage, prog } from "./kit";
import { RAIL, SFX, STAGES } from "./cues";
import { SCENES } from "./scenes";
import timeline from "./timeline.json";

const FPS = config.fps;
const END = timeline[timeline.length - 1].from + timeline[timeline.length - 1].frames;
const at = (id: string) => {
  const t = timeline.find((t) => t.id === id);
  if (!t) throw new Error(`Scene "${id}" is in src/cues.ts but not in timeline.json: run npm run timeline`);
  return t;
};

/** Stands in for a scene that has no component yet: shows its id and narration. */
const Placeholder: React.FC<{ id: string; dur: number }> = ({ id, dur }) => {
  const text = (script as { id: string; text?: string }[]).find((s) => s.id === id)?.text ?? "";
  return (
    <SceneFade dur={dur}>
      <Stage glow={0.3}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 240, textAlign: "center" }}>
          <Label style={{ fontFamily: MONO }}>{id} · no scene in src/scenes yet</Label>
          <H size={48} weight={480} style={{ marginTop: 24, fontFamily: DISPLAY }}>{text}</H>
        </AbsoluteFill>
      </Stage>
    </SceneFade>
  );
};

const RailLayer = () => {
  const f = useCurrentFrame();
  const scene = [...timeline].reverse().find((t) => f >= t.from)!;
  const active = RAIL[scene.id];
  if (active === undefined || STAGES.length === 0) return null;
  // Fade in at the first rail scene, out at the end of the last one.
  const ids = timeline.filter((t) => RAIL[t.id] !== undefined);
  const first = ids[0], last = ids[ids.length - 1];
  const o = Math.min(prog(f, first.from, 16), 1 - prog(f, last.from + last.frames - 14, 14));
  return <Rail stages={STAGES} active={active} opacity={o} />;
};

const Music = () => {
  const m = AUDIO.music;
  if (!m) return null;
  return <Audio src={staticFile(m.file)} loop volume={(fr) => interpolate(fr, [0, 60, END - 120, END], [0, m.volume, m.volume, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />;
};

export const Video = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    {timeline.map((t) => {
      const Scene = SCENES[t.id];
      return (
        <Sequence key={t.id} from={t.from} durationInFrames={t.frames} name={t.id}>
          {Scene ? <Scene dur={t.frames} /> : <Placeholder id={t.id} dur={t.frames} />}
        </Sequence>
      );
    })}
    <RailLayer />
    {timeline.filter((t) => t.vo > 0).map((t) => (
      <Sequence key={"vo" + t.id} from={t.from + t.voAt} name={"vo " + t.id}>
        <Audio src={staticFile(`vo/${t.id}.${t.voExt}`)} />
      </Sequence>
    ))}
    {AUDIO.cues.map((c, i) => (
      <Sequence key={"cue" + i} from={c.frame} durationInFrames={4 * FPS} name={"sfx " + c.sound}>
        <Audio src={staticFile(`sfx/${c.sound}.mp3`)} volume={c.volume} />
      </Sequence>
    ))}
    {SFX.map(([id, sec, name, vol], i) => (
      <Sequence key={"sfx" + i} from={at(id).from + Math.round(sec * FPS)} durationInFrames={4 * FPS} name={"sfx " + name}>
        <Audio src={staticFile(`sfx/${name}.mp3`)} volume={vol} />
      </Sequence>
    ))}
    <Music />
  </AbsoluteFill>
);
