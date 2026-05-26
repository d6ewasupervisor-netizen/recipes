"""Expand recipe shorthand to words TTS engines pronounce correctly."""

from __future__ import annotations

import re

# Abbreviations only (do not include full words like "teaspoons" — would break plurals).
_UNIT_RULES: list[tuple[str, str, str]] = [
    (r"fl\.?\s*oz\.?", "fluid ounce", "fluid ounces"),
    (r"floz", "fluid ounce", "fluid ounces"),
    (r"tbsp?s?", "tablespoon", "tablespoons"),
    (r"tsp?s?", "teaspoon", "teaspoons"),
    (r"lbs?\.?", "pound", "pounds"),
    (r"oz\.?", "ounce", "ounces"),
    (r"kgs?", "kilogram", "kilograms"),
    (r"g\b", "gram", "grams"),
    (r"mls?", "milliliter", "milliliters"),
    (r"(?<![a-z])l\b", "liter", "liters"),
    (r"c\b", "cup", "cups"),
    (r"pkgs?\.?", "package", "packages"),
]

_QTY_RE = re.compile(
    r"^(\d+)(?:\s+(\d+)\s*/\s*(\d+))?(?:\s*-\s*(\d+)\s*/\s*(\d+))?$"
)


def _quantity_value(qty: str) -> float | None:
    qty = qty.strip()
    m = _QTY_RE.match(qty)
    if not m:
        return None
    val = float(m.group(1))
    if m.group(2) and m.group(3):
        val += int(m.group(2)) / int(m.group(3))
    return val


def _pick_unit_form(singular: str, plural: str, qty: str) -> str:
    val = _quantity_value(qty)
    if val is None:
        return singular
    if abs(val - 1.0) < 0.001:
        return singular
    return plural


def _replace_qty_unit(match: re.Match, singular: str, plural: str) -> str:
    qty = match.group(1).strip()
    return f"{qty} {_pick_unit_form(singular, plural, qty)}"


def normalize_for_speech(text: str) -> str:
    if not text or not text.strip():
        return text

    out = text

    out = re.sub(r"(\d+)\s*°\s*F\b", r"\1 degrees Fahrenheit", out, flags=re.I)
    out = re.sub(r"(\d+)\s*°\s*C\b", r"\1 degrees Celsius", out, flags=re.I)
    out = re.sub(r"(\d+)\s*degrees?\s*F\b", r"\1 degrees Fahrenheit", out, flags=re.I)
    out = re.sub(r"(\d+)\s*degrees?\s*C\b", r"\1 degrees Celsius", out, flags=re.I)

    out = re.sub(r"\b(\d+)\s*mins?\.\b", r"\1 minutes", out, flags=re.I)
    out = re.sub(r"\b(\d+)\s*hrs?\.\b", r"\1 hours", out, flags=re.I)
    out = re.sub(r"\b(\d+)\s*hrs?\b", r"\1 hours", out, flags=re.I)

    for pattern, singular, plural in _UNIT_RULES:
        qty_unit = re.compile(
            rf"(\d[\d\s/.\-]*)\s*{pattern}\b",
            re.IGNORECASE,
        )
        out = qty_unit.sub(lambda m, s=singular, p=plural: _replace_qty_unit(m, s, p), out)

        if pattern not in (r"g\b", r"(?<![a-z])l\b", r"c\b"):
            lone = re.compile(rf"(?<!\d[\d\s/.\-])\b{pattern}\b", re.IGNORECASE)
            out = lone.sub(singular, out)

    out = re.sub(
        r"\b(\d+)\s+(\d+)\s*/\s*(\d+)\b",
        lambda m: f"{m.group(1)} and {_fraction_words(int(m.group(2)), int(m.group(3)))}",
        out,
    )

    return re.sub(r"\s+", " ", out).strip()


def _fraction_words(num: int, den: int) -> str:
    names = {
        (1, 2): "a half",
        (1, 3): "a third",
        (2, 3): "two thirds",
        (1, 4): "a quarter",
        (3, 4): "three quarters",
        (1, 8): "an eighth",
        (3, 8): "three eighths",
    }
    return names.get((num, den), f"{num} over {den}")
