"""Discover individual recipe URLs on roundup / listicle pages."""

import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

NON_RECIPE_SEGMENTS = frozenset(
    {
        "about",
        "contact",
        "privacy",
        "terms",
        "faq",
        "start-here",
        "recipes",
        "dinner",
        "lunch",
        "breakfast",
        "desserts",
        "appetizers",
        "search",
        "wp-content",
        "wp-admin",
        "category",
        "tag",
        "author",
        "page",
        "comment",
        "feed",
        "shop",
        "cart",
        "account",
        "login",
        "subscribe",
        "newsletter",
        "work-with",
        "index",
        "home",
    }
)

LISTICLE_HINTS = re.compile(
    r"\b(\d+\s+recipes?|recipes?\s+for|roundup|collection|our favorite)\b",
    re.I,
)


def _normalize_link(page_url: str, href: str) -> str | None:
    if not href or href.startswith(("mailto:", "javascript:", "tel:")):
        return None
    full = urljoin(page_url, href).split("#")[0].split("?")[0].rstrip("/")
    if not full.startswith(("http://", "https://")):
        return None
    return full


def _looks_like_recipe_path(path: str) -> bool:
    slug = path.strip("/")
    if not slug:
        return False
    parts = [p.lower() for p in slug.split("/")]
    if any(part in NON_RECIPE_SEGMENTS for part in parts):
        return False
    if any(part.startswith(("cat", "tag")) for part in parts):
        return False
    if "recipe" in parts:
        return True
    if len(parts) == 1 and "-" in parts[0] and len(parts[0]) >= 10:
        return True
    if len(parts) == 2 and parts[0] in {"recipe", "recipes"}:
        return True
    return False


def discover_recipe_urls(html: str, page_url: str, *, limit: int = 50) -> list[str]:
    """Return same-site recipe page URLs found in article/main content."""
    soup = BeautifulSoup(html, "html.parser")
    base_host = (urlparse(page_url).netloc or "").lower().replace("www.", "")

    containers = soup.select("article, main, .entry-content, .post-content, .content-area")
    if not containers:
        containers = [soup.body] if soup.body else [soup]

    ordered: list[str] = []
    seen: set[str] = set()

    for container in containers:
        for anchor in container.select("a[href]"):
            full = _normalize_link(page_url, anchor.get("href", ""))
            if not full:
                continue
            parsed = urlparse(full)
            host = (parsed.netloc or "").lower().replace("www.", "")
            if host != base_host:
                continue
            path = parsed.path or "/"
            if full == page_url.rstrip("/"):
                continue
            if not _looks_like_recipe_path(path):
                continue
            if full in seen:
                continue
            seen.add(full)
            ordered.append(full)

    return ordered[:limit]


def looks_like_listicle(html: str, page_url: str) -> bool:
    """Heuristic: page is a multi-recipe roundup rather than a single recipe."""
    discovered = discover_recipe_urls(html, page_url, limit=60)
    if len(discovered) >= 5:
        return True
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    h1 = soup.find("h1")
    heading = h1.get_text(" ", strip=True) if h1 else ""
    return bool(LISTICLE_HINTS.search(f"{title} {heading}")) and len(discovered) >= 3
