// Most sounds are placed for you by `npm run timeline` (src/audio.json): a whoosh at each scene start, the typing
// sound under each <Type>, and the "enter" and "sfx" entries of each scene in script.json. Put sounds that
// script.json cannot express here: [scene id, second into the scene, file in public/sfx without .mp3, volume].
export const SFX: [string, number, string, number][] = [];

// The stage rail at the top: the stage names, and which stage each scene lights. Scenes not listed show no rail.
export const STAGES: string[] = ["Capture", "Understand", "Answer"];
export const RAIL: Record<string, number> = {};
