"""Preloaded kitchen heuristics for voice: dry/wet, sections (crust, filling, etc.)."""

from __future__ import annotations

import re
from typing import Any

# Canonical section → spoken aliases (ingredient groups + step text)
SECTION_ALIASES: dict[str, tuple[str, ...]] = {
    "crust": ("crust", "pastry", "dough", "shell", "base", "bottom"),
    "filling": ("filling", "inside", "center", "middle"),
    "topping": ("topping", "top", "finish", "streusel"),
    "frosting": ("frosting", "icing", "buttercream"),
    "glaze": ("glaze", "ganache"),
    "sauce": ("sauce", "gravy", "reduction"),
    "batter": ("batter", "mixture"),
    "marinade": ("marinade", "brine"),
    "assembly": ("assembly", "assemble", "put together", "layer"),
    "garnish": ("garnish", "garnish"),
}

DRY_KEYWORDS = (
    "flour",
    "sugar",
    "salt",
    "baking powder",
    "baking soda",
    "cocoa",
    "cornstarch",
    "starch",
    "oat",
    "meal",
    "semolina",
    "yeast",
    "spice",
    "cinnamon",
    "nutmeg",
    "pepper",
    "powder",
    "rice",
    "breadcrumb",
    "almond flour",
    "confectioners",
    "granulated",
)

WET_KEYWORDS = (
    "water",
    "milk",
    "cream",
    "egg",
    "oil",
    "butter",
    "juice",
    "broth",
    "stock",
    "vinegar",
    "wine",
    "honey",
    "syrup",
    "yogurt",
    "buttermilk",
    "vanilla",
    "extract",
    "molasses",
    "condensed",
    "evaporated",
    "coconut milk",
    "heavy cream",
    "sour cream",
)

_READ_VERB = r"(?:read|list|tell|give|say|what are|what's|whats)"


def resolve_section(query: str) -> str | None:
    q = query.lower().strip()
    for canonical, aliases in SECTION_ALIASES.items():
        if q == canonical or q in aliases:
            return canonical
    for canonical, aliases in SECTION_ALIASES.items():
        if any(a in q for a in aliases):
            return canonical
    return q if q else None


def parse_kitchen_query(transcript: str) -> dict[str, Any] | None:
    """Return {kind, label, section?} or None."""
    t = " ".join(transcript.lower().split())

    if re.search(r"\b(dry\s+(ingredients?|mix|goods)|all\s+(the\s+)?dry)\b", t):
        return {"kind": "dry", "label": "Dry ingredients"}
    if re.search(r"\b(wet\s+(ingredients?|mix)|all\s+(the\s+)?wet)\b", t):
        return {"kind": "wet", "label": "Wet ingredients"}

    m = re.search(
        rf"\b{_READ_VERB}\b.*\b(?:the\s+)?(\w+(?:\s+\w+)?)\s+ingredients?\b",
        t,
    ) or re.search(r"\bingredients?\s+for\s+(?:the\s+)?(\w+(?:\s+\w+)?)\b", t)
    if m:
        section = resolve_section(m.group(1))
        if section and section not in ("dry", "wet", "all", "remaining"):
            return {"kind": "section_ingredients", "section": section, "label": f"{section.title()} ingredients"}

    m = re.search(
        rf"\b{_READ_VERB}\b.*\b(?:steps?|instructions?)\b.*\b(?:for|to|making|of)\s+(?:the\s+)?(\w+(?:\s+\w+)?)\b",
        t,
    ) or re.search(r"\b(?:steps?|instructions?)\s+for\s+(?:the\s+)?(\w+(?:\s+\w+)?)\b", t)
    if m:
        section = resolve_section(m.group(1))
        if section:
            return {"kind": "section_steps", "section": section, "label": f"{section.title()} steps"}

    m = re.search(r"\b(?:how (?:do i|to) make|making|make)\s+(?:the\s+)?(\w+(?:\s+\w+)?)\b", t)
    if m and re.search(r"\b(steps?|instructions?|crust|filling|topping|frosting|sauce|batter)\b", t):
        section = resolve_section(m.group(1))
        if section:
            return {"kind": "section_steps", "section": section, "label": f"{section.title()} steps"}

    return None


def _ing_text(ing: dict[str, Any]) -> str:
    return f"{ing.get('item') or ''} {ing.get('raw') or ''}".lower()


def classify_dry_wet(ing: dict[str, Any]) -> str | None:
    """Return 'dry', 'wet', or None if unclear."""
    text = _ing_text(ing)
    group = (ing.get("group") or "").lower()
    if "dry" in group:
        return "dry"
    if "wet" in group:
        return "wet"

    wet_hits = sum(1 for k in WET_KEYWORDS if k in text)
    dry_hits = sum(1 for k in DRY_KEYWORDS if k in text)
    if re.search(r"\b(egg|eggs|milk|cream|butter|oil|water|juice|broth|stock)\b", text):
        wet_hits += 2
    if re.search(r"\b(flour|sugar|salt|powder|starch|yeast)\b", text):
        dry_hits += 2

    if wet_hits > dry_hits and wet_hits > 0:
        return "wet"
    if dry_hits > wet_hits and dry_hits > 0:
        return "dry"
    return None


def _section_aliases(section: str) -> tuple[str, ...]:
    canonical = resolve_section(section) or section
    return SECTION_ALIASES.get(canonical, (canonical,))


def filter_ingredients(
    ingredients: list[dict[str, Any]],
    *,
    kind: str,
    section: str | None = None,
) -> list[dict[str, Any]]:
    if kind == "dry":
        return [i for i in ingredients if classify_dry_wet(i) == "dry"]
    if kind == "wet":
        return [i for i in ingredients if classify_dry_wet(i) == "wet"]
    if kind == "section_ingredients" and section:
        aliases = _section_aliases(section)
        out = []
        for ing in ingredients:
            g = (ing.get("group") or "").lower()
            text = _ing_text(ing)
            if any(a in g for a in aliases):
                out.append(ing)
            elif any(a in text for a in aliases) and not g:
                out.append(ing)
        return out
    return []


def filter_steps_for_section(steps: list[dict[str, Any]], section: str) -> list[tuple[int, dict[str, Any]]]:
    """Return (1-based step number, step) matches for a section."""
    aliases = _section_aliases(section)
    matched: list[tuple[int, dict[str, Any]]] = []

    for i, step in enumerate(steps):
        text = (step.get("text") or "").lower()
        if any(re.search(rf"\b{re.escape(a)}\b", text) for a in aliases):
            matched.append((i + 1, step))

    if matched:
        return matched

    # Range: "For the crust:" until next "For the …"
    alias_pat = "|".join(re.escape(a) for a in aliases)
    start_idx: int | None = None
    for i, step in enumerate(steps):
        text = (step.get("text") or "").lower()
        if start_idx is None:
            if re.search(rf"^(for\s+)?(the\s+)?({alias_pat})\b", text):
                start_idx = i
                matched.append((i + 1, step))
        else:
            if i > start_idx and re.search(r"^for\s+(the\s+)?\w+", text):
                if not re.search(rf"\b({alias_pat})\b", text):
                    break
            matched.append((i + 1, step))

    return matched


def format_ingredient_list(
    ingredients: list[dict[str, Any]],
    label: str,
    *,
    display_fn: Any = None,
) -> str:
    if not ingredients:
        return f"I don't see any {label.lower()} in this recipe."
    parts = []
    for i, ing in enumerate(ingredients, 1):
        if display_fn:
            parts.append(f"Number {i}: {display_fn(ing)}")
        else:
            parts.append(f"Number {i}: {ing.get('item') or ing.get('raw')}")
    return f"{label}. " + ". ".join(parts) + "."


def format_step_list(
    steps: list[tuple[int, dict[str, Any]]],
    label: str,
    *,
    display_fn: Any = None,
) -> str:
    if not steps:
        return f"I don't see steps for {label.lower()} in this recipe."
    parts = []
    for n, step in steps:
        text = display_fn(step) if display_fn else step.get("text")
        parts.append(f"Step {n}: {text}")
    return f"{label}. " + ". ".join(parts) + "."
