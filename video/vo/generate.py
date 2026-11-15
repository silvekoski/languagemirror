# Generates one ElevenLabs voice clip per scene, with character timings for cue(). A clip is made again only
# when its text changed (vo/<id>.text keeps the last text), so a script edit costs only the scenes you changed.
# Usage: python3 vo/generate.py [--force] [ids...]
import base64, json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from eleven import post

args = [a for a in sys.argv[1:] if a != "--force"]
force = "--force" in sys.argv
voice = json.load(open("video.config.json"))["voice"]
lines = [s for s in json.load(open("script.json")) if s.get("text")]
os.makedirs("public/vo", exist_ok=True)
for i, s in enumerate(lines):
    sid, text = s["id"], s["text"]
    if args and sid not in args:
        continue
    stamp = f"vo/{sid}.text"
    same = os.path.exists(stamp) and open(stamp).read() == text and os.path.exists(f"public/vo/{sid}.mp3")
    if same and not force and not args:
        continue
    body = {"text": text, "model_id": voice["model"],
            "previous_text": lines[i - 1]["text"] if i else None,
            "next_text": lines[i + 1]["text"] if i + 1 < len(lines) else None}
    if voice.get("settings"):
        body["voice_settings"] = voice["settings"]
    d = json.loads(post(f"/text-to-speech/{voice['voiceId']}/with-timestamps?output_format=mp3_44100_192", body))
    open(f"public/vo/{sid}.mp3", "wb").write(base64.b64decode(d["audio_base64"]))
    json.dump(d["alignment"], open(f"vo/{sid}.align.json", "w"))
    open(stamp, "w").write(text)
    print("voice", sid, round(d["alignment"]["character_end_times_seconds"][-1], 2), "s", flush=True)
