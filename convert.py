"""Parse-time ingredient normalization (mirrors client convert.js tokens)."""

import json
import re
from pathlib import Path
from typing import Any

DENSITIES_PATH = Path(__file__).parent / "data" / "densities.json"

UNIT_ALIASES: dict[str, str] = {
    "tsp": "tsp",
    "teaspoon": "tsp",
    "teaspoons": "tsp",
    "t": "tsp",
    "tbsp": "tbsp",
    "tablespoon": "tbsp",
    "tablespoons": "tbsp",
    "T": "tbsp",
    "cup": "cup",
    "cups": "cup",
    "c": "cup",
    "floz": "floz",
    "fl oz": "floz",
    "fl. oz.": "floz",
    "fluid ounce": "floz",
    "fluid ounces": "floz",
    "ml": "ml",
    "milliliter": "ml",
    "milliliters": "ml",
    "millilitre": "ml",
    "millilitres": "ml",
    "l": "l",
    "liter": "l",
    "liters": "l",
    "litre": "l",
    "litres": "l",
    "oz": "oz",
    "ounce": "oz",
    "ounces": "oz",
    "lb": "lb",
    "lbs": "lb",
    "pound": "lb",
    "pounds": "lb",
    "g": "g",
    "gram": "g",
    "grams": "g",
    "kg": "kg",
    "kilogram": "kg",
    "kilograms": "kg",
}

UNICODE_FRACTIONS = {
    "½": 0.5,
    "⅓": 1 / 3,
    "⅔": 2 / 3,
    "¼": 0.25,
    "¾": 0.75,
    "⅛": 0.125,
    "⅜": 0.375,
    "⅝": 0.625,
    "⅞": 0.875,
}

# ingredient phrase -> density_key (longer phrases first at match time)
DENSITY_ALIASES: list[tuple[str, str]] = [
    ("all-purpose flour", "flour_ap"),
    ("all purpose flour", "flour_ap"),
    ("ap flour", "flour_ap"),
    ("bread flour", "flour_bread"),
    ("cake flour", "flour_cake"),
    ("whole wheat flour", "flour_whole_wheat"),
    ("granulated sugar", "sugar_white"),
    ("white sugar", "sugar_white"),
    ("brown sugar", "sugar_brown"),
    ("powdered sugar", "sugar_powdered"),
    ("confectioners sugar", "sugar_powdered"),
    ("confectioners' sugar", "sugar_powdered"),
    ("vegetable oil", "oil_vegetable"),
    ("olive oil", "oil_olive"),
    ("heavy cream", "cream_heavy"),
    ("sour cream", "cream_sour"),
    ("maple syrup", "maple_syrup"),
    ("rolled oats", "oats_rolled"),
    ("bread crumbs", "breadcrumb"),
    ("breadcrumbs", "breadcrumb"),
    ("cheddar cheese", "cheese_cheddar"),
    ("parmesan cheese", "cheese_parmesan"),
    ("chocolate chips", "chocolate_chips"),
    ("peanut butter", "peanut_butter"),
    ("shredded coconut", "coconut_shredded"),
    ("flour", "flour_ap"),
    ("sugar", "sugar_white"),
    ("butter", "butter"),
    ("milk", "milk"),
    ("water", "water"),
    ("honey", "honey"),
    ("cornstarch", "cornstarch"),
    ("cocoa", "cocoa"),
    ("cocoa powder", "cocoa"),
    ("yogurt", "yogurt"),
    ("mayonnaise", "mayonnaise"),
    ("shortening", "shortening"),
    ("applesauce", "applesauce"),
    ("raisins", "raisins"),
    ("rice", "rice_uncooked"),
    ("oil", "oil_vegetable"),
]

_densities_cache: dict[str, Any] | None = None


def load_densities() -> dict[str, Any]:
    global _densities_cache
    if _densities_cache is None:
        with open(DENSITIES_PATH, encoding="utf-8") as f:
            _densities_cache = json.load(f)
    return _densities_cache


def parse_fraction(text: str) -> float | None:
    text = text.strip()
    if not text:
        return None
    for char, val in UNICODE_FRACTIONS.items():
        text = text.replace(char, f" {val} ")
    text = re.sub(r"\s+", " ", text).strip()

    mixed = re.match(r"^(\d+)\s+(\d+)/(\d+)$", text)
    if mixed:
        return int(mixed.group(1)) + int(mixed.group(2)) / int(mixed.group(3))

    frac = re.match(r"^(\d+)/(\d+)$", text)
    if frac:
        return int(frac.group(1)) / int(frac.group(2))

    try:
        return float(text)
    except ValueError:
        return None


def normalize_unit(raw_unit: str) -> str | None:
    key = raw_unit.strip().lower().rstrip(".")
    return UNIT_ALIASES.get(key)


def match_density_key(item: str) -> str | None:
    lower = item.lower()
    densities = load_densities()
    for phrase, key in DENSITY_ALIASES:
        if phrase in lower and key in densities:
            return key
    return None


def normalize_ingredient(raw: str, ing_id: str = "ing_1") -> dict[str, Any]:
    raw = raw.strip()
    if not raw:
        return {
            "id": ing_id,
            "raw": raw,
            "quantity": None,
            "unit": None,
            "item": raw,
            "density_key": None,
            "group": None,
        }

    # Section headers like "For the dough:" — no quantity
    if raw.endswith(":") and not re.match(r"^\d", raw):
        return {
            "id": ing_id,
            "raw": raw,
            "quantity": None,
            "unit": None,
            "item": raw.rstrip(":"),
            "density_key": None,
            "group": raw.rstrip(":"),
        }

    # Countable items first: "2 eggs", "3 cloves garlic"
    count_m = re.match(r"^(\d+(?:\.\d+)?(?:\s+\d+/\d+)?)\s+(.+)$", raw)
    if count_m:
        unit_candidate = count_m.group(2).split()[0] if count_m.group(2) else ""
        if not normalize_unit(unit_candidate):
            qty = parse_fraction(count_m.group(1).replace(" ", " "))
            return {
                "id": ing_id,
                "raw": raw,
                "quantity": qty,
                "unit": None,
                "item": count_m.group(2).strip(),
                "density_key": None,
                "group": None,
            }

    qty_pattern = (
        r"^(?:(\d+\s+\d+/\d+|\d+/\d+|\d+(?:\.\d+)?|[½⅓⅔¼¾⅛⅜⅝⅞]+(?:\s+[½⅓⅔¼¾⅛⅜⅝⅞]+)?)\s+)?"
        r"(?:(\w+(?:\.\s+\w+)?|\w+\s+oz\.?|\w+\.\s+\w+\.?|\w+/\w+|\w+\s+\w+))\s+"
        r"(.+)$"
    )
    m = re.match(qty_pattern, raw, re.IGNORECASE)
    if not m:
        return {
            "id": ing_id,
            "raw": raw,
            "quantity": None,
            "unit": None,
            "item": raw,
            "density_key": None,
            "group": None,
        }

    qty_str, unit_str, item = m.group(1), m.group(2), m.group(3).strip()
    unit = normalize_unit(unit_str)
    if not unit:
        return {
            "id": ing_id,
            "raw": raw,
            "quantity": None,
            "unit": None,
            "item": raw,
            "density_key": None,
            "group": None,
        }
    qty = parse_fraction(qty_str) if qty_str else 1.0

    return {
        "id": ing_id,
        "raw": raw,
        "quantity": qty,
        "unit": unit,
        "item": item,
        "density_key": match_density_key(item) if unit in ("tsp", "tbsp", "cup", "floz", "ml", "l") else None,
        "group": None,
    }


def normalize_ingredients(raw_lines: list[str]) -> list[dict[str, Any]]:
    result = []
    current_group: str | None = None
    for i, line in enumerate(raw_lines, start=1):
        line = line.strip()
        if not line:
            continue
        ing = normalize_ingredient(line, f"ing_{i}")
        if ing.get("group") and ing["quantity"] is None:
            current_group = ing["group"]
            continue
        if current_group:
            ing["group"] = current_group
        result.append(ing)
    return result


if __name__ == "__main__":
    tests = [
        ("1 1/2 cups all-purpose flour", 1.5, "cup", "flour_ap"),
        ("2 eggs", 2.0, None, None),
        ("½ tsp salt", 0.5, "tsp", None),
        ("350 g butter", 350.0, "g", None),
        ("1 tablespoon olive oil", 1.0, "tbsp", "oil_olive"),
    ]
    for raw, exp_qty, exp_unit, exp_density in tests:
        r = normalize_ingredient(raw)
        assert r["quantity"] == exp_qty, f"{raw}: qty {r['quantity']} != {exp_qty}"
        assert r["unit"] == exp_unit, f"{raw}: unit {r['unit']} != {exp_unit}"
        assert r["density_key"] == exp_density, f"{raw}: density {r['density_key']} != {exp_density}"
    print("convert.py self-test passed")
