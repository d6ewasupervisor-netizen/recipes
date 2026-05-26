"""Extract Recipe objects from schema.org JSON-LD (handles HowToSection steps)."""

import json
import re
from typing import Any

from extruct import extract


def _recipe_nodes(data: dict[str, Any]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for block in data.get("json-ld", []):
        if not isinstance(block, dict):
            continue
        if block.get("@graph"):
            nodes.extend(block["@graph"])
        else:
            nodes.append(block)
    return [n for n in nodes if _is_recipe(n)]


def _is_recipe(node: dict[str, Any]) -> bool:
    t = node.get("@type")
    if t == "Recipe":
        return True
    if isinstance(t, list):
        return "Recipe" in t
    return False


def _parse_iso8601_duration(value: str | None) -> int | None:
    if not value or not isinstance(value, str):
        return None
    m = re.fullmatch(
        r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?",
        value.strip(),
        re.I,
    )
    if not m:
        m2 = re.search(r"(\d+)", value)
        return int(m2.group(1)) if m2 else None
    hours = int(m.group(1) or 0)
    minutes = int(m.group(2) or 0)
    seconds = int(m.group(3) or 0)
    total = hours * 60 + minutes + (1 if seconds >= 30 else 0)
    return total or None


def _text_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("text", "name", "description", "headline"):
            if value.get(key):
                return str(value[key]).strip()
        return ""
    if isinstance(value, list):
        return " ".join(_text_value(v) for v in value if _text_value(v))
    return str(value).strip()


def _flatten_instructions(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in re.split(r"\n+|\r+", raw) if p.strip()]
        return parts or [raw.strip()]
    if not isinstance(raw, list):
        return [_text_value(raw)] if _text_value(raw) else []

    steps: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            t = item.get("@type") or item.get("type")
            types = t if isinstance(t, list) else [t]
            if "HowToSection" in types:
                section = _text_value(item.get("name"))
                for sub in item.get("itemListElement") or []:
                    text = _text_value(sub)
                    if text:
                        steps.append(f"{section}: {text}" if section else text)
            elif "HowToStep" in types or item.get("text") or item.get("name"):
                text = _text_value(item)
                if text:
                    steps.append(text)
            else:
                text = _text_value(item)
                if text:
                    steps.append(text)
        else:
            text = _text_value(item)
            if text:
                steps.append(text)
    return steps


def _ingredient_lines(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        return [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if isinstance(raw, list):
        lines = []
        for item in raw:
            text = _text_value(item)
            if text:
                lines.append(text)
        return lines
    text = _text_value(raw)
    return [text] if text else []


def _image_url(raw: Any) -> str | None:
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list) and raw:
        return _image_url(raw[0])
    if isinstance(raw, dict):
        return raw.get("url") or raw.get("@id")
    return None


def _parse_yields(raw: Any) -> int:
    if raw is None:
        return 4
    if isinstance(raw, (int, float)):
        return max(1, int(raw))
    text = _text_value(raw)
    m = re.search(r"(\d+)", text)
    return int(m.group(1)) if m else 4


def recipe_from_jsonld(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": _text_value(node.get("name")) or "Untitled Recipe",
        "image_url": _image_url(node.get("image")),
        "base_servings": _parse_yields(node.get("recipeYield") or node.get("yield")),
        "prep_time": _parse_iso8601_duration(node.get("prepTime")),
        "cook_time": _parse_iso8601_duration(node.get("cookTime")),
        "total_time": _parse_iso8601_duration(node.get("totalTime")),
        "ingredient_lines": _ingredient_lines(node.get("recipeIngredient")),
        "instruction_lines": _flatten_instructions(node.get("recipeInstructions")),
    }


def extract_recipes_from_html(html: str, base_url: str) -> list[dict[str, Any]]:
    data = extract(html, base_url=base_url, syntaxes=["json-ld"])
    recipes = []
    for node in _recipe_nodes(data):
        parsed = recipe_from_jsonld(node)
        if parsed["ingredient_lines"] and parsed["instruction_lines"]:
            recipes.append(parsed)
    return recipes


def best_recipe_from_html(html: str, base_url: str) -> dict[str, Any] | None:
    recipes = extract_recipes_from_html(html, base_url)
    if not recipes:
        return None
    return max(
        recipes,
        key=lambda r: len(r["ingredient_lines"]) + len(r["instruction_lines"]),
    )
