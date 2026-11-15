# ElevenLabs access for the voice, sound and music scripts. The key comes from ELEVENLABS_API_KEY in the
# environment, else from the first .env up the directory tree (this project, the challenge dir, the repo root).
import json, os, sys, urllib.error, urllib.request

API = "https://api.elevenlabs.io/v1"


def key():
    k = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    d = os.getcwd()
    while not k:
        p = os.path.join(d, ".env")
        if os.path.exists(p):
            for line in open(p):
                if line.startswith("ELEVENLABS_API_KEY="):
                    k = line.split("=", 1)[1].strip().strip('"').strip("'")
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    if not k:
        sys.exit("No ElevenLabs key: put ELEVENLABS_API_KEY=... in .env (see .env.example). "
                 "Without a key the video renders silent with estimated scene lengths.")
    return k


def post(path, body, timeout=240):
    """POSTs JSON and returns the raw response bytes. An API error stops the script with its message."""
    req = urllib.request.Request(API + path, data=json.dumps(body).encode(),
                                 headers={"xi-api-key": key(), "content-type": "application/json"})
    try:
        return urllib.request.urlopen(req, timeout=timeout).read()
    except urllib.error.HTTPError as e:
        sys.exit(f"ElevenLabs {path.split('?')[0]}: HTTP {e.code} {e.read().decode(errors='replace')[:400]}")


def inline_sounds(script):
    """Sounds written as a prompt inside script.json: {name: {prompt, seconds}}, named <scene>-<n>."""
    out = {}
    for s in script:
        for i, c in enumerate(s.get("sfx", [])):
            if "prompt" in c:
                out[c.get("sound") or f"{s['id']}-{i}"] = {"prompt": c["prompt"], "seconds": c.get("seconds", 1.5)}
    return out
