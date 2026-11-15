"""Kielipeili, step 1: fetch the showcase articles in six languages from the Wikipedia API.
For each Finnish title: find the sv/en/de/ru/uk versions (langlinks), then download the wikitext
of the current version and of the version current on 1 January of every second year since 2006.
Raw API answers go to data/lens/raw/<topic>/<lang>/<snapshot>.json (resumable: skips existing files).
    uv run python -m scripts.lens_fetch"""
import json, pathlib, re, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

TOPICS = [
    "Talvisota", "Jatkosota", "Suomen sisällissota", "Mainilan laukaukset",
    "Carl Gustaf Emil Mannerheim", "Lapin sota", "Suomettuminen", "Urho Kekkonen",
    "Molotov–Ribbentrop-sopimus",
]
LANGS = ["fi", "sv", "en", "de", "ru", "uk"]
YEARS = [2024, 2020, 2016, 2012, 2008]
OUT = pathlib.Path("data/lens/raw")
UA = "wikitime-kielipeili/0.1 (Junction 2026 hackathon demo; MariaDB challenge)"


def api(lang, **params):
    params |= {"format": "json", "formatversion": "2"}
    url = f"https://{lang}.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params)
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=60) as r:
                time.sleep(0.3)
                return json.load(r)
        except urllib.error.HTTPError as e:
            err = e
            wait = int(e.headers.get("Retry-After") or 0) or 5 * (attempt + 1)
            time.sleep(min(wait, 60))
        except Exception as e:  # noqa: BLE001 - retry anything transient
            err = e
            time.sleep(3 * (attempt + 1))
    raise err


def langlinks(fi_title):
    d = api("fi", action="query", titles=fi_title, redirects=1, prop="langlinks|pageprops",
            lllimit="max", ppprop="wikibase_item")
    page = d["query"]["pages"][0]
    titles = {"fi": page["title"]}
    for ll in page.get("langlinks", []):
        if ll["lang"] in LANGS:
            titles[ll["lang"]] = ll["title"]
    return titles, page.get("pageprops", {}).get("wikibase_item")


def get(url):
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(3 * (attempt + 1))
        except Exception:  # noqa: BLE001 - transient
            time.sleep(3 * (attempt + 1))
    return None


def fetch(lang, title, snap):
    """Same shape as an API revisions answer, built from the (cached, unthrottled) history page + action=raw."""
    base = f"https://{lang}.wikipedia.org/w/index.php?"
    q = {"title": title, "action": "history", "limit": 1}
    if snap != "current":
        q["offset"] = f"{snap}0101000000"
    page = get(base + urllib.parse.urlencode(q)) or ""
    rid, ts = re.search(r'data-mw-revid="(\d+)"', page), re.search(r'data-mw-ts="(\d{14})"', page)
    if not rid:
        return {"query": {"pages": [{"title": title, "missing": True}]}}
    text = get(base + urllib.parse.urlencode({"oldid": rid.group(1), "action": "raw"})) or ""
    t = ts.group(1)
    iso = f"{t[:4]}-{t[4:6]}-{t[6:8]}T{t[8:10]}:{t[10:12]}:{t[12:14]}Z"
    return {"query": {"pages": [{"title": title, "revisions": [
        {"revid": int(rid.group(1)), "timestamp": iso, "slots": {"main": {"content": text}}}]}]}}


def job(topic, lang, title, snap):
    f = OUT / topic / lang / f"{snap}.json"
    if f.exists():
        return
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(fetch(lang, title, snap), ensure_ascii=False))


def main():
    jobs = []
    mf = OUT / "meta.json"
    meta = json.loads(mf.read_text()) if mf.exists() else {}
    for fi in TOPICS:
        if fi not in meta:
            titles, qid = langlinks(fi)
            meta[fi] = {"titles": titles, "wikidata": qid}
        titles = meta[fi]["titles"]
        for lang, title in titles.items():
            for snap in ["current", *YEARS]:
                jobs.append((fi, lang, title, snap))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    jobs.sort(key=lambda j: (j[3] != "current", -int(j[3]) if j[3] != "current" else 0))
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(lambda j: job(*j), jobs))
    print(f"{len(jobs)} snapshots", flush=True)


if __name__ == "__main__":
    main()
