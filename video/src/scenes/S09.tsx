import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { C, H, MONO, SceneFade, Stage, TEXT, prog } from "../kit";
import { GlobeBand } from "./shared";

// End card: the globe loop again, the name, the partners.
export const S09: React.FC<{ dur: number }> = ({ dur }) => {
  const f = useCurrentFrame();
  const t = prog(f, 0, 24), s = prog(f, 20, 24);
  return (
    <SceneFade dur={dur} outF={20}>
      <Stage glow={0.7} glowY={40}>
        <GlobeBand top={160} opacity={t} />
        <AbsoluteFill style={{ paddingLeft: 140, paddingTop: 330 }}>
          <div style={{ opacity: t }}>
            <H size={116} style={{ letterSpacing: "-0.03em" }}>Language Mirror</H>
            <div style={{ fontFamily: TEXT, fontSize: 42, color: C.sub, marginTop: 22 }}>One story, every Wikipedia.</div>
            <div style={{ fontFamily: MONO, fontSize: 34, color: C.accent, marginTop: 34, opacity: s }}>languagemirror.bobs.build</div>
          </div>
        </AbsoluteFill>
        <div style={{ position: "absolute", left: 140, right: 140, bottom: 110, display: "flex", gap: 56, alignItems: "center", opacity: s }}>
          {["mariadb", "claude", "contextdev", "wikidata"].map((n) => <Img key={n} src={staticFile(`img/logos/${n}.png`)} style={{ height: 52 }} />)}
          <div style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 26, color: C.sub }}>Built on MariaDB · Junction 2026</div>
        </div>
      </Stage>
    </SceneFade>
  );
};
