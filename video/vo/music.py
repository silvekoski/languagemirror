# Generates the music bed with ElevenLabs Music, as long as the video (10 s to 5 min), when video.config.json has
# "music": { "prompt": "...", "volume": 0.14 } and public/<file> does not exist yet. Usage: python3 vo/music.py [--force]
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from eleven import post

cfg = json.load(open("video.config.json"))
m = cfg.get("music")
if not m or not m.get("prompt"):
    sys.exit(0)
path = "public/" + m.get("file", "music.mp3")
if os.path.exists(path) and "--force" not in sys.argv:
    sys.exit(0)
t = json.load(open("src/timeline.json"))
seconds = (t[-1]["from"] + t[-1]["frames"]) / cfg["fps"]
ms = int(min(300, max(10, seconds + 2)) * 1000)
open(path, "wb").write(post("/music?output_format=mp3_44100_192", {"prompt": m["prompt"], "music_length_ms": ms, "model_id": m.get("model", "music_v1")}, timeout=600))
print("music", path, ms / 1000, "s")
