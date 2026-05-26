"""Recipe URL scraping and manual-paste parsing."""

import re
from typing import Any

from recipe_scrapers import scrape_html

import convert


class ParseError(Exception):
    pass


def _parse_yields(yields_str: str | None) -> int:
    if not yields_str:
        return 4
    m = re.search(r"(\d+)", str(yields_str))
    return int(m.group(1)) if m else 4


def _parse_minutes(value: int | str | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
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


def parse_url(url: str) -> dict[str, Any]:
    try:
        scraper = scrape_html(None, url, online=True)
    except Exception as exc:
        raise ParseError(str(exc)) from exc

    try:
        title = scraper.title() or "Untitled Recipe"
        image_url = scraper.image()
        base_servings = _parse_yields(scraper.yields())
        prep_time = _parse_minutes(scraper.prep_time())
        cook_time = _parse_minutes(scraper.cook_time())
        total_time = _parse_minutes(scraper.total_time())
        ingredient_lines = list(scraper.ingredients())
        instruction_lines = list(scraper.instructions())
    except Exception as exc:
        raise ParseError(str(exc)) from exc

    return _build_recipe(
        title=title,
        source_url=url,
        image_url=image_url,
        base_servings=base_servings,
        prep_time=prep_time,
        cook_time=cook_time,
        total_time=total_time,
        ingredient_lines=ingredient_lines,
        instruction_lines=instruction_lines,
    )


def parse_manual(payload: dict[str, Any]) -> dict[str, Any]:
    title = payload.get("title", "").strip()
    ingredients_raw = payload.get("ingredients_raw", "")
    steps_raw = payload.get("steps_raw", "")

    ingredient_lines = [ln.strip() for ln in ingredients_raw.splitlines() if ln.strip()]
    instruction_lines = [ln.strip() for ln in steps_raw.splitlines() if ln.strip()]

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
    manual = parse_manual(
        {
            "title": "Test Pancakes",
            "ingredients_raw": "1 cup all-purpose flour\n2 eggs\n1 cup milk",
            "steps_raw": "Mix ingredients.\nCook on griddle.",
        }
    )
    assert manual["title"] == "Test Pancakes"
    assert len(manual["ingredients"]) == 3
    assert manual["ingredients"][0]["density_key"] == "flour_ap"
    print("parser.py manual test passed")

    try:
        result = parse_url("https://www.allrecipes.com/recipe/24074/alysias-basic-meat-lasagna/")
        assert result["title"]
        assert len(result["ingredients"]) > 0
        print(f"parser.py URL test passed: {result['title']} ({len(result['ingredients'])} ingredients)")
    except ParseError as e:
        print(f"parser.py URL test skipped (network/site): {e}")
