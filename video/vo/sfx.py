# Generates the sound effects with ElevenLabs: every sound in sfx.json and every sfx prompt in script.json.
# Only missing files are made, so it is cheap to run again. Usage: python3 vo/sfx.py [--force] [names...]
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from eleven import inline_sounds, post

args = [a for a in sys.argv[1:] if a != "--force"]
force = "--force" in sys.argv
sounds = {**json.load(open("sfx.json")), **inline_sounds(json.load(open("script.json")))}
os.makedirs("public/sfx", exist_ok=True)
for name, s in sounds.items():
    path = f"public/sfx/{name}.mp3"
    if (args and name not in args) or (os.path.exists(path) and not force and not args):
        continue
    audio = post("/sound-generation?output_format=mp3_44100_192",
                 {"text": s["prompt"], "duration_seconds": s.get("seconds"), "prompt_influence": s.get("influence", 0.6)})
    open(path, "wb").write(audio)
    print("sfx", name, flush=True)
