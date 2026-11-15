# Prints each word of a clip with its start time in seconds. Usage: python3 vo/words.py s02 s03
import json, sys
for sid in sys.argv[1:]:
    a = json.load(open(f"vo/{sid}.align.json"))
    out, w, t0 = [], "", None
    for ch, t in zip(a["characters"], a["character_start_times_seconds"]):
        if ch.isspace():
            if w: out.append(f"{w}@{t0:.1f}")
            w, t0 = "", None
        else:
            t0 = t if t0 is None else t0
            w += ch
    if w: out.append(f"{w}@{t0:.1f}")
    print(sid, " ".join(out))
