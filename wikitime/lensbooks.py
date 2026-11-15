"""Kielipeili: turn book citations into Google Books links.

Wikipedia history articles cite books in two ways:
  - in full, often with an ISBN ("Marjomaa, Risto: ... 952-5354-46-6"), sometimes in a {{cite book}} template;
  - in short form ("Upton 1981, 265–278"), pointing to the full entry in the article's own bibliography section.
We parse every edition's bibliography, resolve short references by surname + year, and link each book by ISBN to
Google Books (https://books.google.com/books?vid=ISBN...). Without an ISBN, Open Library is asked for one by title and
author; failing that we link a precise Google Books search (intitle + inauthor), marked as a search.
"""
import json, re, unicodedata, urllib.parse

from wikitime import lenswiki as W

ISBN_RE = re.compile(r"(?<![\d-])((?:97[89][\s‐-]?)?\d{1,5}[\s‐-]\d{1,7}[\s‐-]\d{1,7}[\s‐-][\dXx]|97[89]\d{10}|\d{9}[\dXx])(?![\d-])")
SHORT_RE = re.compile(r"([A-ZÄÖÅÜÉŠŽČ][\w’'\-]+(?:\s(?:&|ja|and|und|och|и)\s[A-ZÄÖÅ][\w’'\-]+)?)(?:\s+et\s+al\.?)?\s*,?\s*\(?((?:1[5-9]|20)\d\d)[a-z]?\)?")
YEAR_RE = re.compile(r"\b((?:1[5-9]|20)\d\d)\b")


def fold(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c)).casefold()


def isbn_ok(raw):
    d = re.sub(r"[^\dXx]", "", raw).upper()
    if len(d) == 10:
        return sum((10 - i) * (10 if c == "X" else int(c)) for i, c in enumerate(d)) % 11 == 0 and d
    if len(d) == 13 and d.isdigit():
        return sum(int(c) * (1 if i % 2 == 0 else 3) for i, c in enumerate(d)) % 10 == 0 and d
    return None


def find_isbns(text):
    out = []
    for m in ISBN_RE.finditer(text or ""):
        d = isbn_ok(m.group(1))
        if d and d not in out:
            out.append(d)
    return out


def gbooks(isbn):
    return f"https://books.google.com/books?vid=ISBN{isbn}"


def gsearch(title, author=None):
    q = f'intitle:"{title}"' + (f" inauthor:{author}" if author else "")
    return "https://www.google.com/search?tbm=bks&q=" + urllib.parse.quote(q)


def _tmpl_params(body):
    return {k.strip().lower(): v.strip() for k, v in re.findall(r"\|\s*([^=|{}]+?)\s*=\s*([^|{}]*)", body)}


def bibliography(wikitext):
    """Entries of the end-matter lists: {"surnames", "year", "title", "isbn", "text"}."""
    t, _ = W.mark_refs(wikitext)
    lines, on = [], False
    for line in t.split("\n"):
        h = re.match(r"^(=+)\s*(.*?)\s*=+\s*$", line)
        if h:
            on = bool(W.STOP.match(re.sub(r"\[\[|\]\]", "", h.group(2)).strip())) or on and len(h.group(1)) > 2
            continue
        if on and line.lstrip().startswith(("*", "#", "{{")):
            lines.append(line)
    out = []
    for line in lines:
        p = {}
        for m in re.finditer(r"\{\{\s*(?:cite|citation|kirjaviite|verkkoviite|lehtiviite|книга|статья|cytuj|literatur|ouvrage|bokref|kniha)[^{}]*\}\}", line, re.I):
            p = _tmpl_params(m.group(0))
        text = re.sub(r"\{\{[^{}]*\}\}", lambda m: " ".join(v for _, v in _tmpl_params(m.group(0)).items()), line)
        text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
        text = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", text)
        text = re.sub(r"'''?|<[^>]+>|^[*#:\s]+", "", text).strip()
        if len(text) < 12:
            continue
        years = YEAR_RE.findall(p.get("year") or p.get("vuosi") or p.get("date") or p.get("год") or p.get("rok") or text)
        surnames = [p[k] for k in ("last", "last1", "surname", "author", "sukunimi", "tekijä", "автор", "nazwisko", "nom", "efternamn") if p.get(k)]
        if not surnames:
            head = re.split(r"[:(.]|\s\d{4}", text, 1)[0]
            surnames = [s.strip().split()[0] if "," in s else s.strip().split()[-1]
                        for s in re.split(r";|&|\s(?:ja|and|und|och|и)\s", head) if s.strip()][:3]
        title = p.get("title") or p.get("nimeke") or p.get("заглавие") or p.get("tytuł") or p.get("titel") or p.get("titre")
        if not title:
            m = re.search(r"[:.]\s*([^.:]{4,120})[.:]", text)
            title = m.group(1).strip() if m else None
        isbn = (find_isbns(p.get("isbn", "")) or find_isbns(text) or [None])[0]
        out.append({"surnames": [fold(re.sub(r"[^\w\s-]", "", s)).split()[-1] for s in surnames if re.sub(r"[^\w\s-]", "", s).strip()],
                    "year": years[0] if years else None, "title": title, "isbn": isbn, "text": text[:240]})
    return out


def openlibrary_isbn(title, author=None):
    if not title:
        return None
    q = {"title": title[:120], "fields": "title,isbn,first_publish_year,author_name", "limit": 3}
    if author:
        q["author"] = author
    data = json.loads(W.http_get("https://openlibrary.org/search.json?" + urllib.parse.urlencode(q), timeout=15, tries=2) or "{}")
    for d in data.get("docs", []):
        for i in d.get("isbn", []):
            if isbn_ok(i):
                return isbn_ok(i)
    return None


def resolve(ref, bib, ol_cache=None):
    """Links for one citation: [{"label", "url", "how": "isbn"|"bibliography"|"openlibrary"|"search"}]."""
    text = " ".join(x for x in (ref.get("title"), ref.get("text")) if x)
    links = []
    for isbn in find_isbns(text)[:2]:
        links.append({"label": ref.get("title") or text[:90], "url": gbooks(isbn), "how": "isbn", "isbn": isbn})
    if links:
        return links
    seen = set()
    for m in SHORT_RE.finditer(ref.get("text") or ""):
        name, year = fold(m.group(1)).split()[-1], m.group(2)
        if (name, year) in seen:
            continue
        seen.add((name, year))
        hit = next((b for b in bib if name in b["surnames"] and b["year"] == year), None) or \
              next((b for b in bib if name in b["surnames"] and b["year"] and b["year"][:3] == year[:3]), None)
        if not hit:
            continue
        label = f"{m.group(1)} {year}: {hit['title'] or hit['text'][:80]}"
        if hit["isbn"]:
            links.append({"label": label, "url": gbooks(hit["isbn"]), "how": "bibliography", "isbn": hit["isbn"]})
        else:
            key = (hit["title"], name)
            isbn = (ol_cache or {}).get(key) if ol_cache is not None and key in ol_cache else openlibrary_isbn(hit["title"], m.group(1))
            if ol_cache is not None:
                ol_cache[key] = isbn
            links.append({"label": label, "url": gbooks(isbn) if isbn else gsearch(hit["title"] or hit["text"][:60], m.group(1)),
                          "how": "openlibrary" if isbn else "search", "isbn": isbn})
        if len(links) >= 3:
            break
    if not links and ref.get("title") and ref.get("kind") in ("book", "journal", "other") and not ref.get("url"):
        isbn = openlibrary_isbn(ref["title"])
        links.append({"label": ref["title"], "url": gbooks(isbn) if isbn else gsearch(ref["title"]),
                      "how": "openlibrary" if isbn else "search", "isbn": isbn})
    return links
