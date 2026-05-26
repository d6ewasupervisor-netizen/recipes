"""Extract recipes from WP Recipe Maker markup."""

import json
import re
from typing import Any

from bs4 import BeautifulSoup


def _wprm_id_from_fragment(fragment: str | None) -> str | None:
    if not fragment:
        return None
    m = re.search(r"wprm-recipe-container-(\d+)", fragment, re.I)
    if m:
        return m.group(1)
    m = re.search(r"wprm-recipe-(\d+)", fragment, re.I)
    return m.group(1) if m else None


def _lines_from_list(el) -> list[str]:
    if el is None:
        return []
    items = el.select("li") if hasattr(el, "select") else []
    if items:
        return [li.get_text(" ", strip=True) for li in items if li.get_text(strip=True)]
    text = el.get_text("\n", strip=True)
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def extract_wprm(html: str, fragment: str | None = None) -> dict[str, Any] | None:
    soup = BeautifulSoup(html, "html.parser")
    recipe_id = _wprm_id_from_fragment(fragment)

    container = None
    if recipe_id:
        container = soup.find(id=f"wprm-recipe-container-{recipe_id}")
        if not container:
            container = soup.find(id=re.compile(rf"wprm-recipe-{recipe_id}\b"))
    if not container:
        container = soup.select_one(".wprm-recipe-container")

    if not container:
        return None

    title_el = container.select_one(".wprm-recipe-name, h2, h3")
    title = title_el.get_text(strip=True) if title_el else "Untitled Recipe"

    ingredients: list[str] = []
    for group in container.select(".wprm-recipe-ingredient-group, .wprm-recipe-ingredients-container"):
        for ing in group.select(".wprm-recipe-ingredient"):
            text = ing.get_text(" ", strip=True)
            if text:
                ingredients.append(text)
    if not ingredients:
        ingredients = _lines_from_list(container.select_one(".wprm-recipe-ingredients"))

    instructions: list[str] = []
    for group in container.select(".wprm-recipe-instruction-group"):
        for step in group.select(".wprm-recipe-instruction-text"):
            text = step.get_text(" ", strip=True)
            if text:
                instructions.append(text)
    if not instructions:
        instructions = _lines_from_list(container.select_one(".wprm-recipe-instructions"))

    image_el = container.select_one(".wprm-recipe-image img, img")
    image_url = image_el.get("src") if image_el else None

    servings_el = container.select_one(".wprm-recipe-servings")
    base_servings = 4
    if servings_el:
        m = re.search(r"(\d+)", servings_el.get_text())
        if m:
            base_servings = int(m.group(1))

    if not ingredients or not instructions:
        return None

    return {
        "title": title,
        "image_url": image_url,
        "base_servings": base_servings,
        "prep_time": None,
        "cook_time": None,
        "total_time": None,
        "ingredient_lines": ingredients,
        "instruction_lines": instructions,
    }


def extract_wprm_json(html: str) -> dict[str, Any] | None:
    """Some themes embed WPRM recipe JSON in script tags."""
    for m in re.finditer(r"var\s+wprm_recipes\s*=\s*(\{.*?\});", html, re.S):
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data:
            first = next(iter(data.values()))
            if isinstance(first, dict):
                return _from_wprm_dict(first)
    return None


def _from_wprm_dict(data: dict[str, Any]) -> dict[str, Any] | None:
    ingredients = [str(x).strip() for x in data.get("ingredients", []) if str(x).strip()]
    instructions = [str(x).strip() for x in data.get("instructions", []) if str(x).strip()]
    if not ingredients or not instructions:
        return None
    return {
        "title": str(data.get("name") or "Untitled Recipe"),
        "image_url": data.get("image"),
        "base_servings": int(re.search(r"\d+", str(data.get("servings", "4"))).group())
        if re.search(r"\d+", str(data.get("servings", "4")))
        else 4,
        "prep_time": None,
        "cook_time": None,
        "total_time": None,
        "ingredient_lines": ingredients,
        "instruction_lines": instructions,
    }
