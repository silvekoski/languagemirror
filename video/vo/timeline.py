# Builds src/timeline.json, src/words.json and src/audio.json from script.json, video.config.json, the voice clips
# and the sounds in public/. Usage: python3 vo/timeline.py
#
# Each scene is as long as its voice clip: voAt frames of lead-in + the clip + `tail` frames (or the scene's `hold`).
# A scene without a clip yet gets a length estimated from its words, and plays silent (vo = 0).
# A scene with `seconds` has a fixed length (title cards, recordings without voice). `frames` overrides everything.
import json, os, re, subprocess, math

cfg = json.load(open("video.config.json"))
fps, vo_at, tail, wpm = cfg["fps"], cfg["voAt"], cfg["tail"], cfg["wordsPerMinute"]
script = json.load(open("script.json"))
auto = cfg.get("sfx", {})


def clip(sid):
    """(seconds, ext) of public/vo/<sid>.mp3 or .wav, or (None, None). Timings come from the align file when present."""
    for ext in ("mp3", "wav"):
        p = f"public/vo/{sid}.{ext}"
        if os.path.exists(p):
            align = f"vo/{sid}.align.json"
            if os.path.exists(align):
                return json.load(open(align))["character_end_times_seconds"][-1], ext
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
                                 capture_output=True, text=True, check=True).stdout
            return float(out), ext
    return None, None


def words(sid):
    p = f"vo/{sid}.align.json"
    if not os.path.exists(p):
        return []
    a = json.load(open(p))
    out, w, t0 = [], "", None
    for ch, t in zip(a["characters"], a["character_start_times_seconds"]):
        if ch.isspace():
            if w: out.append([w, round(t0, 3)])
            w, t0 = "", None
        else:
            t0 = t if t0 is None else t0
            w += ch
    if w: out.append([w, round(t0, 3)])
    return out


timeline, word_map, at = [], {}, 0
for s in script:
    sid, lead = s["id"], s.get("voAt", vo_at)
    vo, ext = clip(sid) if s.get("text") else (None, None)
    if "frames" in s:
        frames = s["frames"]
    elif "seconds" in s:
        frames = round(s["seconds"] * fps)
    elif vo is not None:
        frames = math.ceil(lead + vo * fps + s.get("hold", tail))
    else:
        est = len(s.get("text", "").split()) / wpm * 60
        frames = math.ceil(lead + est * fps + s.get("hold", tail))
    row = {"id": sid, "from": at, "frames": frames, "vo": round(vo, 2) if vo else 0, "voAt": lead, "voExt": ext or "mp3"}
    timeline.append(row)
    word_map[sid] = words(sid) if vo else []
    at += frames
    print(f"{sid:6} {frames / fps:6.2f} s  {'voice ' + str(row['vo']) + ' s' if vo else 'silent (no clip)' if s.get('text') else 'no voice'}")

# Sounds. Each scene starts with auto.sceneStart (a scene's "enter" overrides it; "enter": null for none), then
# the scene's "sfx" list: {"sound" or "prompt", "word" (+ "nth") or "at" (seconds into the voice), "offset", "volume"}.
norm = lambda w: re.sub(r"[^\w]", "", w.lower())
have = lambda name: os.path.exists(f"public/sfx/{name}.mp3")
cues, missing = [], set()


def add(name, frame, volume):
    if have(name):
        cues.append({"frame": max(0, round(frame)), "sound": name, "volume": volume})
    else:
        missing.add(name)


for s, row in zip(script, timeline):
    # The first scene gets no automatic whoosh, only an explicit "enter".
    enter = s["enter"] if "enter" in s else (auto.get("sceneStart") if row["from"] > 0 else None)
    if enter:
        add(enter, row["from"], s.get("enterVolume", auto.get("sceneStartVolume", 0.22)))
    for i, c in enumerate(s.get("sfx", [])):
        name = c.get("sound") or f"{s['id']}-{i}"
        sec = c.get("at", 0)
        if "word" in c:
            hits = [t for w, t in word_map[row["id"]] if norm(w) == norm(c["word"])]
            if not hits:  # no timings yet: estimate from the word's place in the text
                ws = [norm(w) for w in s.get("text", "").split()]
                idx = [k for k, w in enumerate(ws) if w == norm(c["word"])]
                if not idx:
                    raise SystemExit(f"{s['id']}: sfx word '{c['word']}' is not in the narration")
                hits = [k / wpm * 60 for k in idx]
            sec = hits[min(c.get("nth", 0), len(hits) - 1)]
        add(name, row["from"] + row["voAt"] + (sec + c.get("offset", 0)) * fps, c.get("volume", auto.get("volume", 0.3)))

typing = auto.get("typing")
music = cfg.get("music") or None
music_file = music and music.get("file", "music.mp3")
audio = {
    "cues": sorted(cues, key=lambda c: c["frame"]),
    "typing": {"sound": typing, "volume": auto.get("typingVolume", 0.18)} if typing and have(typing) else None,
    "music": {"file": music_file, "volume": music.get("volume", 0.14)} if music and os.path.exists("public/" + music_file) else None,
}
if typing and not have(typing): missing.add(typing)

json.dump(timeline, open("src/timeline.json", "w"), indent=1)
json.dump(audio, open("src/audio.json", "w"), indent=1)
json.dump(word_map, open("src/words.json", "w"))
print(f"total  {at / fps:6.2f} s  ({at} frames), {len(cues)} sound cues" + (", music" if audio["music"] else ""))
if missing:
    print("sounds not generated yet (skipped):", ", ".join(sorted(missing)), "-> npm run audio")
if music and not audio["music"]:
    print(f"music public/{music_file} not there yet (skipped) -> npm run audio")
