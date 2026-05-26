"""Fetch web pages with a stable user agent."""

import re
from urllib.parse import urlparse, urlunparse

import requests

# Many recipe sites (e.g. AllRecipes) return 403 for bot-style user agents from server IPs.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}
TIMEOUT = 30


def normalize_url(url: str) -> tuple[str, str | None]:
    """Return (fetch_url without fragment, fragment without #)."""
    parsed = urlparse(url.strip())
    fragment = parsed.fragment or None
    fetch = urlunparse(parsed._replace(fragment=""))
    return fetch, fragment


def fetch_html(url: str) -> str:
    response = requests.get(
        url,
        headers=BROWSER_HEADERS,
        timeout=TIMEOUT,
    )
    response.raise_for_status()
    return response.text


def youtube_video_id(url: str) -> str | None:
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower().replace("www.", "")
    if host in {"youtu.be"}:
        vid = parsed.path.lstrip("/").split("/")[0]
        return vid or None
    if host in {"youtube.com", "m.youtube.com"}:
        if parsed.path == "/watch":
            from urllib.parse import parse_qs

            return parse_qs(parsed.query).get("v", [None])[0]
        m = re.match(r"^/(?:embed|shorts|live)/([^/?]+)", parsed.path)
        if m:
            return m.group(1)
    return None


def is_youtube_url(url: str) -> bool:
    return youtube_video_id(url) is not None
