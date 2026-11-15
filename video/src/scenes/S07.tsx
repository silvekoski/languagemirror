import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, H, Label, MONO, Panel, SceneFade, Stage, cue, prog, vo } from "../kit";

// The MariaDB core: one system-versioned table with a vector index; one statement per language pair and moment.
const SQL = `SELECT a.chars,
  1 - (SELECT MIN(VEC_DISTANCE_COSINE(a.emb, b.emb))
       FROM lens_chunk FOR SYSTEM_TIME AS OF '2016-01-01' AS b
       WHERE b.topic = a.topic AND b.lang = 'ru') AS sim
FROM lens_chunk FOR SYSTEM_TIME AS OF '2016-01-01' AS a
WHERE a.topic = 'Suomen sisällissota' AND a.lang = 'fi'`;
export const S07: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const a = cue("s07", "vector", 0, vo(1.5)), b = cue("s07", "together", 0, vo(5.5)), c = cue("s07", "history", 0, vo(9));
  const lines = SQL.split("\n");
  return (
    <SceneFade dur={dur}>
      <Stage glow={0.6}>
        <AbsoluteFill style={{ padding: "130px 170px", gap: 34 }}>
          <div style={{ opacity: prog(f, vo(0), 18) }}><H size={64}>One MariaDB table does the work</H></div>
          <div style={{ display: "flex", gap: 24, opacity: prog(f, a, 18) }}>
            {["VECTOR(1024) · bge-m3", "VECTOR INDEX · cosine", "WITH SYSTEM VERSIONING", "real Wikipedia edit times"].map((t, i) => (
              <div key={t} style={{ opacity: prog(f, a + i * 6, 14), fontFamily: MONO, fontSize: 24, color: "#fff", background: C.accent, padding: "12px 18px", borderRadius: 12 }}>{t}</div>
            ))}
          </div>
          <Panel style={{ padding: "30px 36px", opacity: prog(f, b, 20) }}>
            {lines.map((l, i) => (
              <div key={i} style={{ fontFamily: MONO, fontSize: 27, lineHeight: 1.55, color: C.text, whiteSpace: "pre", opacity: prog(f, b + i * 5, 12) }}>{l}</div>
            ))}
          </Panel>
          <div style={{ opacity: prog(f, c, 18) }}><Label size={30}>matching · scores · history: vector search plus <span style={{ fontFamily: MONO, color: C.accent }}>FOR SYSTEM_TIME AS OF</span></Label></div>
        </AbsoluteFill>
      </Stage>
    </SceneFade>
  );
};
