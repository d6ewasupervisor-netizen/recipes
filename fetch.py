"""Fetch web pages with a stable user agent."""

import re
from urllib.parse import urlparse, urlunparse

import requests

USER_AGENT = "Mozilla/5.0 (compatible; RecipesBot/1.0; +https://recipes.tactag.app)"
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
        headers={"User-Agent": USER_AGENT},
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
