"""Kielipeili: fetching Wikipedia articles in any language and splitting them into paragraph chunks that keep
their citations.

- resolve(): an article title or a Wikipedia URL -> Wikidata item and every language edition (sitelinks).
- fetch(): current wikitext + revision id/time per edition, through the cached history page and action=raw
  (the API itself rate-limits hard).
- chunks(): paragraph chunks of 280..1400 characters; each carries the citations (<ref>) that appear in it,
  parsed into url / title / kind, so a claim can be traced to its source.
"""
import hashlib, html, json, re, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

from wikitime.wikitext import clean

UA = "wikitime-kielipeili/0.2 (Junction 2026 hackathon demo; MariaDB challenge)"
MIN_CHARS, MAX_CHARS = 280, 1400

# Headings that start the end matter (sources, literature, links), in the languages we meet most.
STOP = re.compile(r"^(lähteet|viitteet|kirjallisuutta|kirjallisuus|aiheesta muualla|katso myös|"
                  r"källor|referenser|se även|externa länkar|litteratur|noter|"
                  r"references|notes|see also|external links|further reading|bibliography|sources|citations|footnotes|"
                  r"einzelnachweise|weblinks|literatur|anmerkungen|siehe auch|quellen|"
                  r"примечания|литература|ссылки|источники|см\. также|"
                  r"примітки|джерела|посилання|див\. також|література|"
                  r"przypisy|bibliografia|linki zewnętrzne|zobacz też|"
                  r"viited|kirjandus|välislingid|vaata ka|"
                  r"notes et références|références|bibliographie|liens externes|voir aussi|"
                  r"referencias|bibliografía|enlaces externos|véase también|"
                  r"note|collegamenti esterni|voci correlate|"
                  r"literatūra|atsauces|ārējās saites|šaltiniai|nuorodos|"
                  r"poznámky|reference|externí odkazy|literatura|odkazy|"
                  r"jegyzetek|források|irodalom|"
                  r"izvori|vanjske poveznice|"
                  r"referanser|eksterne lenker|henvisninger|"
                  r"注释|参考文献|外部链接|脚注|関連項目|出典|"
                  r"kaynakça|dış bağlantılar)$", re.I)

FILE_LINK = re.compile(r"\[\[[^\[\]|:]{1,30}:[^\[\]|]*\.(?:jpe?g|png|svg|gif|tiff?|webp|ogg|ogv|webm|pdf)"
                       r"(?:[^\[\]]|\[\[[^\]]*\]\])*\]\]", re.I)
NS_LINE = re.compile(r"^\s*\[\[[^\[\]|:]{1,30}:[^\]]*\]\]\s*$", re.M)          # category / interwiki lines
REF_FULL = re.compile(r"<ref(?P<attrs>[^>/]*)>(?P<body>.*?)</ref\s*>", re.S | re.I)
REF_SHORT = re.compile(r"<ref(?P<attrs>[^>]*?)/>", re.I)
NAME = re.compile(r"""name\s*=\s*["']?([^"'>/]+?)["']?\s*(?:$|/|\s)""", re.I)
MARK = re.compile(r"⟦(\d+)⟧")


def http_get(url, timeout=30, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 * (attempt + 1))
        except Exception:  # noqa: BLE001 - transient network trouble
            time.sleep(2 * (attempt + 1))
    return None


def parse_input(text, default_lang="en"):
    """'Stepan Bandera', 'fi:Talvisota' or 'https://et.wikipedia.org/wiki/Harald_Nugiseks' -> (lang, title)."""
    text = text.strip()
    m = re.match(r"https?://([a-z\-]+)\.(?:m\.)?wikipedia\.org/wiki/([^?#]+)", text)
    if m:
        return m.group(1), urllib.parse.unquote(m.group(2)).replace("_", " ")
    m = re.match(r"^([a-z]{2,3}(?:-[a-z]+)?):(.+)$", text)
    if m:
        return m.group(1), m.group(2).strip()
    return default_lang, text


def resolve(lang, title):
    """Wikidata item for a Wikipedia article: {"qid", "label", "titles": {lang: title}} over all Wikipedias."""
    q = urllib.parse.urlencode({"action": "wbgetentities", "sites": f"{lang}wiki", "titles": title, "normalize": 1,
                                "props": "sitelinks|labels", "languages": "en|" + lang, "format": "json"})
    data = json.loads(http_get("https://www.wikidata.org/w/api.php?" + q) or "{}")
    ents = [e for k, e in data.get("entities", {}).items() if not k.startswith("-")]
    if not ents:
        return None
    e = ents[0]
    titles = {}
    for site, s in e.get("sitelinks", {}).items():
        m = re.fullmatch(r"([a-z_]+)wiki", site)
        if m and m.group(1) not in ("commons", "species", "meta", "simple", "wikidata", "incubator", "sources", "mediawiki"):
            titles[m.group(1).replace("_", "-")] = s["title"]
    labels = e.get("labels", {})
    label = (labels.get("en") or labels.get(lang) or {}).get("value") or title
    return {"qid": e["id"], "label": label, "titles": titles}


def fetch(lang, title):
    """Current version: {"lang", "title", "rev_id", "ts", "wikitext"} or None."""
    base = f"https://{lang}.wikipedia.org/w/index.php?"
    page = http_get(base + urllib.parse.urlencode({"title": title, "action": "history", "limit": 1})) or ""
    rid, ts = re.search(r'data-mw-revid="(\d+)"', page), re.search(r'data-mw-ts="(\d{14})"', page)
    if not rid:
        return None
    text = http_get(base + urllib.parse.urlencode({"oldid": rid.group(1), "action": "raw"}))
    if text is None:
        return None
    t = ts.group(1)
    return {"lang": lang, "title": title, "rev_id": int(rid.group(1)),
            "ts": f"{t[:4]}-{t[4:6]}-{t[6:8]} {t[8:10]}:{t[10:12]}:{t[12:14]}", "wikitext": text}


def fetch_many(titles, workers=10):
    with ThreadPoolExecutor(workers) as ex:
        got = {r["lang"]: r for r in ex.map(lambda kv: fetch(*kv), titles.items()) if r}
    for lang, title in titles.items():           # retry the ones that failed under load, one at a time
        if lang not in got:
            r = fetch(lang, title)
            if r:
                got[lang] = r
    return got


def resolve_qid(qid):
    data = json.loads(http_get("https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "wbgetentities", "ids": qid, "props": "sitelinks|labels", "languages": "en", "format": "json"})) or "{}")
    e = data.get("entities", {}).get(qid)
    if not e:
        return None
    titles = {m.group(1).replace("_", "-"): s["title"] for site, s in e.get("sitelinks", {}).items()
              if (m := re.fullmatch(r"([a-z_]+)wiki", site)) and m.group(1) not in
              ("commons", "species", "meta", "simple", "wikidata", "incubator", "sources", "mediawiki")}
    return {"qid": qid, "label": (e.get("labels", {}).get("en") or {}).get("value"), "titles": titles}


# ---------- citations ----------
def _param(body, *names):
    for n in names:
        m = re.search(r"\|\s*" + n + r"\s*=\s*([^|}]*)", body, re.I)
        if m and m.group(1).strip():
            return m.group(1).strip()
    return None


def parse_ref(body):
    """A <ref> body -> {"kind", "url", "title", "text"}."""
    b = body.strip()
    head = (re.match(r"\{\{\s*([^|}]+)", b) or [None, ""])[1].strip().lower()
    url = _param(b, "url", "URL", "archive-url", "archiveurl") or (re.search(r"https?://[^\s\]|}<]+", b) or [None])[0]
    title = _param(b, "title", "otsikko", "titel", "заглавие", "назва", "tytuł", "pealkiri", "titre", "título", "titolo")
    if any(k in head for k in ("book", "kirja", "книга", "bok", "buch", "książka", "raamat", "ouvrage", "libro")):
        kind = "book"
    elif any(k in head for k in ("journal", "lehti", "статья", "tidskrift", "zeitschrift", "czasopismo", "article", "periodical")):
        kind = "journal"
    elif any(k in head for k in ("news", "uutis", "nyhet", "новост", "gazeta")):
        kind = "news"
    elif url:
        kind = "web"
    elif re.search(r"\b(19|20)\d\d\b", b) and len(b) > 25:
        kind = "book"
    else:
        kind = "other"
    text = re.sub(r"\{\{[^{}]*\}\}", lambda m: " ".join(p.split("=", 1)[-1] for p in m.group(0).strip("{}").split("|")[1:5]), b)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[(https?://\S+)\s+([^\]]*)\]", r"\2", text)
    text = re.sub(r"<[^>]+>|'''?|\s+", " ", html.unescape(text)).strip()
    return {"kind": kind, "url": url, "title": title, "text": text[:300]}


def mark_refs(wikitext):
    """Replace every <ref> with a marker ⟦i⟧ (named refs reuse their id); return (text, refs list)."""
    refs, by_name = [], {}

    def name_of(attrs):
        m = NAME.search(attrs or "")
        return m.group(1).strip() if m else None

    for m in REF_FULL.finditer(wikitext):          # first pass: definitions of named refs
        n = name_of(m.group("attrs"))
        if n and n not in by_name and m.group("body").strip():
            by_name[n] = len(refs)
            refs.append(parse_ref(m.group("body")))

    def full(m):
        n = name_of(m.group("attrs"))
        if n and n in by_name:
            return f"⟦{by_name[n]}⟧"
        if not m.group("body").strip():
            return ""
        refs.append(parse_ref(m.group("body")))
        return f"⟦{len(refs) - 1}⟧"

    def short(m):
        n = name_of(m.group("attrs"))
        return f"⟦{by_name[n]}⟧" if n in by_name else ""

    t = REF_FULL.sub(full, wikitext)
    t = REF_SHORT.sub(short, t)
    return t, refs


# ---------- chunks ----------
def chunks(wikitext, legacy=False):
    """[(section, text, [ref dicts])]. legacy=True reproduces the original chunk texts (no extra link cleanup),
    so citations can be attached to chunks that were built before this module existed."""
    t, refs = mark_refs(wikitext)
    if not legacy:
        t = NS_LINE.sub("", FILE_LINK.sub("", t))
    out, buf, buf_refs, section = [], [], [], ""

    def flush():
        if buf:
            text = " ".join(buf).strip()
            if len(text) >= 80:
                ids = sorted({int(i) for i in buf_refs})
                out.append((section, text, [refs[i] for i in ids if i < len(refs)]))
            buf.clear(); buf_refs.clear()

    for kind, text in clean(t):
        found = MARK.findall(text)
        text = re.sub(r"\s+", " ", MARK.sub("", text)).strip()
        if kind == "h":
            flush()
            if STOP.match(text):
                break
            section = text[:250]
            continue
        if not text or len(text) < 3:
            continue
        while len(text) > MAX_CHARS:
            cut = text.rfind(". ", 0, MAX_CHARS)
            cut = cut + 1 if cut > MIN_CHARS else MAX_CHARS
            buf.append(text[:cut]); buf_refs.extend(found); flush(); found = []; text = text[cut:].strip()
        buf.append(text); buf_refs.extend(found)
        if sum(map(len, buf)) >= MIN_CHARS:
            flush()
    flush()
    return out


def sha(text):
    return hashlib.sha1(text.encode()).hexdigest()


def prose_chars(wikitext):
    return sum(len(c[1]) for c in chunks(wikitext))
