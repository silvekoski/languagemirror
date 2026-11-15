import { Composition } from "remotion";
import config from "../video.config.json";
import timeline from "./timeline.json";
import { Video } from "./Video";

const last = timeline[timeline.length - 1];
export const Root = () => (
  <Composition id="Video" component={Video} durationInFrames={last.from + last.frames} fps={config.fps} width={config.width} height={config.height} />
);
