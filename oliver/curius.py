"""Fetch a user's entire Curius library (stdlib only, no extra deps).

Curius exposes a public JSON API keyed by *numeric user id*:
    https://curius.app/api/users/{id}/links     (paginated, ~30 links/page)

Usernames are not resolvable through the API, so we accept a numeric id directly
and, as a convenience, try to extract the id from a profile URL / username by
scraping the embedded data on the profile HTML page.
"""

from __future__ import annotations

import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

API = "https://curius.app/api/users/{uid}/links"
PROFILE = "https://curius.app/{name}"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def _ctx() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        c = ssl.create_default_context()
        c.check_hostname = False
        c.verify_mode = ssl.CERT_NONE
        return c


def _get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as r:
        return r.read()


def resolve_user_id(raw: str) -> str | None:
    """Turn user input (numeric id, profile URL, or username) into a numeric id."""
    raw = (raw or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        return raw

    # pull a username out of a profile URL if they pasted one
    name = raw
    m = re.search(r"curius\.app/(?:user/)?([^/?#]+)", raw)
    if m:
        name = m.group(1)
    name = name.lstrip("@").strip("/")
    if name.isdigit():
        return name

    # best effort: the Next.js profile page embeds the numeric id somewhere
    try:
        html = _get(PROFILE.format(name=urllib.parse.quote(name))).decode(
            "utf-8", errors="replace"
        )
    except Exception:
        return None
    for pat in (r'"userId"\s*:\s*(\d+)', r"/api/users/(\d+)/links", r'"user"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)'):
        m = re.search(pat, html)
        if m:
            return m.group(1)
    return None


def fetch_links(uid: str, max_pages: int = 400) -> list[dict]:
    """Paginate the whole library, deduped by link id."""
    by_id: dict[int, dict] = {}
    page = 1
    while page <= max_pages:
        url = API.format(uid=uid) + (f"?page={page}" if page > 1 else "")
        try:
            batch = json.loads(_get(url)).get("userSaved", [])
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Curius returned HTTP {exc.code}") from exc
        if not batch:
            break
        for link in batch:
            if link.get("id"):
                by_id[link["id"]] = link
        page += 1
    return list(by_id.values())


def extract_highlights(links: list[dict]) -> list[dict]:
    """Flatten Curius links into highlight rows: {curius_link_id, title, url, text}."""
    rows: list[dict] = []
    for link in links:
        title = link.get("title") or link.get("link") or "Untitled"
        url = link.get("link", "")
        lid = link.get("id")
        for h in link.get("highlights", []) or []:
            text = (h.get("highlight") or "").strip()
            if len(text) >= 8:
                rows.append(
                    {"curius_link_id": lid, "title": title, "url": url, "text": text}
                )
    return rows
