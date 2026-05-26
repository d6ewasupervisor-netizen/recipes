"""Recipe URL scraping with intelligent multi-strategy fallbacks."""

from typing import Any

from recipe_scrapers import scrape_html

import convert
from fetch import fetch_html, is_youtube_url, normalize_url
from schema_extract import best_recipe_from_html
from text_extract import parse_structured_text
from wprm_extract import extract_wprm, extract_wprm_json
from youtube_extract import YouTubeParseError, parse_youtube


class ParseError(Exception):
    pass


def _parse_yields(yields_str: str | None) -> int:
    if not yields_str:
        return 4
    import re

    m = re.search(r"(\d+)", str(yields_str))
    return int(m.group(1)) if m else 4


def _parse_minutes(value: int | str | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    import re

    m = re.search(r"(\d+)", str(value))
    return int(m.group(1)) if m else None


def _build_recipe(
    *,
    title: str,
    source_url: str | None,
    image_url: str | None,
    base_servings: int,
    prep_time: int | None,
    cook_time: int | None,
    total_time: int | None,
    ingredient_lines: list[str],
    instruction_lines: list[str],
) -> dict[str, Any]:
    if not ingredient_lines:
        raise ParseError("No ingredients found")

    ingredients = convert.normalize_ingredients(ingredient_lines)
    instructions = [
        {"step": i, "text": text.strip()}
        for i, text in enumerate(instruction_lines, start=1)
        if text.strip()
    ]
    if not instructions:
        raise ParseError("No instructions found")

    return {
        "title": title.strip() or "Untitled Recipe",
        "source_url": source_url,
        "image_url": image_url,
        "base_servings": base_servings,
        "prep_time": prep_time,
        "cook_time": cook_time,
        "total_time": total_time,
        "unit_system": "imperial",
        "notes": None,
        "ingredients": ingredients,
        "instructions": instructions,
        "layout": {
            "ingredient_groups": [],
            "hidden_ingredient_ids": [],
            "step_order": None,
        },
    }


def _recipe_quality_ok(ingredient_lines: list[str], instruction_lines: list[str]) -> bool:
    if not ingredient_lines or not instruction_lines:
        return False
    if len(instruction_lines) > max(40, len(ingredient_lines) * 8):
        return False
    if any(len(step) > 1200 for step in instruction_lines):
        return False
    return True


def _from_partial(data: dict[str, Any], source_url: str) -> dict[str, Any]:
    return _build_recipe(
        title=data.get("title") or "Untitled Recipe",
        source_url=source_url,
        image_url=data.get("image_url"),
        base_servings=int(data.get("base_servings") or 4),
        prep_time=data.get("prep_time"),
        cook_time=data.get("cook_time"),
        total_time=data.get("total_time"),
        ingredient_lines=data["ingredient_lines"],
        instruction_lines=data["instruction_lines"],
    )


def _try_scrape_html(html: str, url: str) -> dict[str, Any] | None:
    try:
        scraper = scrape_html(html, url, supported_only=False)
        ingredient_lines = list(scraper.ingredients())
        instruction_lines = list(scraper.instructions())
        if not _recipe_quality_ok(ingredient_lines, instruction_lines):
            return None
        return _build_recipe(
            title=scraper.title() or "Untitled Recipe",
            source_url=url,
            image_url=scraper.image(),
            base_servings=_parse_yields(scraper.yields()),
            prep_time=_parse_minutes(scraper.prep_time()),
            cook_time=_parse_minutes(scraper.cook_time()),
            total_time=_parse_minutes(scraper.total_time()),
            ingredient_lines=ingredient_lines,
            instruction_lines=instruction_lines,
        )
    except Exception:
        return None


def parse_url(url: str) -> dict[str, Any]:
    original_url = url.strip()

    if is_youtube_url(original_url):
        try:
            data = parse_youtube(original_url)
            return _from_partial(data, original_url)
        except YouTubeParseError as exc:
            raise ParseError(str(exc)) from exc

    fetch_url, fragment = normalize_url(original_url)
    try:
        html = fetch_html(fetch_url)
    except Exception as exc:
        raise ParseError(f"Could not fetch page: {exc}") from exc

    strategies: list[dict[str, Any] | None] = [
        best_recipe_from_html(html, fetch_url),
        extract_wprm(html, fragment),
        extract_wprm_json(html),
    ]

    for data in strategies:
        if data and _recipe_quality_ok(data["ingredient_lines"], data["instruction_lines"]):
            return _from_partial(data, original_url)

    scraped = _try_scrape_html(html, fetch_url)
    if scraped:
        scraped["source_url"] = original_url
        return scraped

    raise ParseError(
        "Could not find a recipe on this page. The site may block imports or hide the recipe from structured data."
    )


def parse_manual(payload: dict[str, Any]) -> dict[str, Any]:
    title = payload.get("title", "").strip()
    ingredients_raw = payload.get("ingredients_raw", "")
    steps_raw = payload.get("steps_raw", "")

    ingredient_lines = [ln.strip() for ln in ingredients_raw.splitlines() if ln.strip()]
    instruction_lines = [ln.strip() for ln in steps_raw.splitlines() if ln.strip()]

    combined = f"{ingredients_raw}\n\n{steps_raw}".strip()
    structured = parse_structured_text(combined)
    if structured and not ingredient_lines:
        ingredient_lines = structured["ingredient_lines"]
        instruction_lines = structured["instruction_lines"]

    return _build_recipe(
        title=title or "Untitled Recipe",
        source_url=None,
        image_url=None,
        base_servings=4,
        prep_time=None,
        cook_time=None,
        total_time=None,
        ingredient_lines=ingredient_lines,
        instruction_lines=instruction_lines,
    )


if __name__ == "__main__":
    tests = [
        "https://overthefirecooking.com/chili-cheese-dog/#wprm-recipe-container-23371",
        "https://www.angrybbq.com/smoked-cream-cheese/",
        "https://www.youtube.com/watch?v=lG8x9vPfTZo",
    ]
    for test_url in tests:
        try:
            result = parse_url(test_url)
            print(
                f"OK: {result['title']} — {len(result['ingredients'])} ingredients, "
                f"{len(result['instructions'])} steps"
            )
        except ParseError as exc:
            print(f"FAIL: {test_url}\n  {exc}")
