"""Smoke test for the Nemotron framing check, with a real key and no database:
    NVIDIA_API_KEY=nvapi-... uv run python -m scripts.nemotron_smoke
Sends one built-in Finnish/Russian paragraph pair (the France recognition difference from the Civil War
articles, shortened) through app.nemotron.compare and prints the verdict and the quote check."""
import json, sys

from app import nemotron as N

FI = ("Suomen itsenäisyyden tunnustivat ensimmäisinä Neuvosto-Venäjä, Ruotsi, Ranska, Saksa ja Norja tammikuussa 1918. "
      "Ranska oli ensimmäisten valtioiden joukossa, ja sen tunnustus vahvisti senaatin asemaa ennen sodan alkua.")
RU = ("В январе 1918 года независимость Финляндии признали Советская Россия, Швеция и Германия. "
      "Франция отказалась признать новое государство, пока в стране не будет восстановлен порядок.")

if __name__ == "__main__":
    if not N.nemotron_configured():
        sys.exit("NVIDIA_API_KEY is not set.")
    pairs = [{"ref": {"section": "Tunnustus", "text": FI}, "other": {"section": "Признание", "text": RU}, "sim": 0.62}]
    res = N.compare("nemotron", "Suomen sisällissota", "fi", "ru", "2026-11-14", pairs)
    print(N.NEMOTRON_LABEL, N.model())
    print(json.dumps(res, ensure_ascii=False, indent=2))
    ok = res["items"] and res["check"]["after_repair"]["quotes"] > 0
    sys.exit(0 if ok else 1)
