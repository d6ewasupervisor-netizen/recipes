"""Common cooking knowledge for instant voice answers (no LLM latency)."""

from __future__ import annotations

import re

# (pattern, answer) — checked in order; first match wins.
_BASICS: list[tuple[str, str]] = [
    (
        r"\b(medium|rare|medium.?rare|medium.?well|well.?done)\b.*\bsteak\b|"
        r"\bsteak\b.*\b(medium|rare|medium.?rare|medium.?well|well.?done|doneness|temp)\b",
        "Steak doneness by internal temp: rare one hundred twenty-five, medium-rare one hundred thirty-five, "
        "medium one hundred forty-five, medium-well one hundred fifty-five, well-done one hundred sixty plus degrees Fahrenheit. "
        "Pull a few degrees early and rest five minutes.",
    ),
    (
        r"\b(safe|internal|done|temp)\b.*\bpork\b|\bpork\b.*\b(safe|internal|temp|done)\b",
        "Pork is safely done at one hundred forty-five degrees Fahrenheit internal, then rest three minutes.",
    ),
    (
        r"\b(safe|internal|done|temp)\b.*\b(chicken|poultry|turkey)\b|"
        r"\b(chicken|poultry|turkey)\b.*\b(safe|internal|temp|done)\b",
        "Poultry is safely done at one hundred sixty-five degrees Fahrenheit in the thickest part, not touching bone.",
    ),
    (
        r"\b(safe|internal|done|temp)\b.*\b(ground beef|ground meat|hamburger|burger)\b|"
        r"\b(ground beef|ground meat|hamburger)\b.*\b(safe|temp|done)\b",
        "Ground beef and other ground meats should reach one hundred sixty degrees Fahrenheit internal.",
    ),
    (
        r"\b(safe|internal|done|temp)\b.*\b(fish|seafood|salmon|shrimp)\b|"
        r"\b(fish|salmon|shrimp)\b.*\b(safe|temp|done)\b",
        "Fish is usually done at one hundred forty-five degrees Fahrenheit, or when it flakes easily. "
        "Shrimp turns pink and opaque.",
    ),
    (
        r"\b(substitut|swap|replace|instead of)\b.*\bbutter\b|\bbutter\b.*\b(substitut|instead|swap)\b",
        "For butter, use equal oil for sautéing, or three-quarters oil plus a pinch of salt for baking. "
        "Margarine works one-to-one in most recipes.",
    ),
    (
        r"\b(substitut|swap|replace|instead of)\b.*\b(milk|cream|buttermilk)\b|"
        r"\b(milk|buttermilk)\b.*\b(substitut|instead|swap)\b",
        "Milk swaps: whole milk for cream in most cooking, half-and-half for lighter richness. "
        "Buttermilk: one cup milk plus one tablespoon lemon juice or vinegar, rest five minutes.",
    ),
    (
        r"\b(substitut|swap|replace|instead of)\b.*\b(egg|eggs)\b|\beggs?\b.*\b(substitut|instead|swap)\b",
        "One egg binds about one-quarter cup: try one tablespoon flax meal plus three tablespoons water, "
        "or one-quarter cup applesauce or mashed banana in baking.",
    ),
    (
        r"\b(substitut|swap|replace|instead of)\b.*\b(flour|all.?purpose)\b|"
        r"\bflour\b.*\b(substitut|instead|gluten.?free)\b",
        "For gluten-free, use a one-to-one gluten-free flour blend. "
        "Cake flour: subtract two tablespoons per cup of all-purpose and add two tablespoons cornstarch.",
    ),
    (
        r"\bwhat (is|does)\b.*\b(saut[eé]|braise|blanch|deglaze|reduce|proof|rest|fold)\b|"
        r"\b(saut[eé]|braise|blanch|deglaze|reduce|proof)\b.*\bmean\b",
        "Sauté: cook quickly in a little fat over medium-high heat. "
        "Braise: brown then simmer covered in liquid until tender. "
        "Blanch: brief boil then ice bath. Deglaze: loosen browned bits with liquid. "
        "Reduce: simmer to thicken and concentrate flavor.",
    ),
    (
        r"\b(food safety|cross.?contam|raw chicken|wash hands|leftovers)\b",
        "Keep raw meat separate from ready-to-eat food. Wash hands and surfaces after touching raw protein. "
        "Refrigerate leftovers within two hours. Reheat to one hundred sixty-five degrees Fahrenheit.",
    ),
    (
        r"\b(dutch oven|cast iron|nonstick|sheet pan|stand mixer|food processor)\b.*\b(what|when|use)\b|"
        r"\bwhat (is|for)\b.*\b(dutch oven|cast iron|nonstick|sheet pan)\b",
        "Dutch oven: heavy pot for braising, soups, and bread. Cast iron holds heat well for searing and baking. "
        "Nonstick is best for eggs and delicate foods on low to medium heat.",
    ),
    (
        r"\b(room temp|room temperature)\b.*\b(butter|eggs|cream cheese)\b|"
        r"\bwhy\b.*\broom temp\b",
        "Room-temperature butter and eggs cream and emulsify better, giving smoother batters and even baking.",
    ),
    (
        r"\b(al dente|mise en place|julienne|chiffonade)\b",
        "Al dente: pasta with a slight bite. Mise en place: prep and measure everything before cooking. "
        "Julienne: thin matchstick cuts. Chiffonade: roll leaves and slice into ribbons.",
    ),
]


def try_cooking_basics_answer(transcript: str) -> str | None:
    """Return a short spoken answer for common cooking questions, or None."""
    t = " ".join(transcript.lower().split())
    if not t:
        return None
    for pattern, answer in _BASICS:
        if re.search(pattern, t, re.I):
            return answer
    return None
