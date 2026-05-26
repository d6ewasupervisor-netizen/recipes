"""Preloaded cooking-assistant skills and compact context for voice LLM calls."""

from __future__ import annotations

import re
from typing import Any

from cooking_basics import try_cooking_basics_answer
from kitchen_knowledge import (
    filter_ingredients,
    filter_steps_for_section,
    format_ingredient_list,
    format_step_list,
    parse_kitchen_query,
)

# Kept short for latency; client mirrors key rules for instant handling.
SKILLS_PROMPT = """You are an expert home-cooking voice assistant. Answer cooking questions confidently — never say you cannot help with cooking.

RECIPE FACTS (never invent):
- Navigation: next/back/repeat; read remaining or all ingredients/steps from current index.
- Kitchen lists use recipe ingredients/steps only:
  • Dry/wet: classify by item text and ingredient group labels ("Dry mix", "Wet mix").
  • Sections: crust/pastry, filling, topping, frosting, glaze, sauce, batter, marinade, assembly, garnish.
- Servings: scale amounts proportionally (base_servings → current_servings).
- Units: imperial↔metric; volumes may convert to grams when density_key exists.
- Temperatures/timing: read from steps/notes; convert F↔C when user unit_system differs.
- Print: user says print → action print_recipe.
- Current position: respect session.phase and session.index; "this/that" means current item.

GENERAL COOKING KNOWLEDGE (action answer — use your culinary expertise):
- Techniques, terms, equipment, tools, food safety, substitutions, doneness temps.
- Safe internal temps: poultry 165°F; ground meats 160°F; pork 145°F + rest; fish 145°F.
- Steak: rare 125°F, medium-rare 135°F, medium 145°F, medium-well 155°F, well 160°F+.
- Prefer recipe data when relevant; otherwise give concise general guidance (2–3 sentences max).
- Substitutions: common safe swaps only; warn when unsure; never change the recipe database.

VOICE STYLE:
- Be brief and natural. Do not tell user to say "next" unless they ask for help.
- In speech use full words (teaspoon not tsp, degrees Fahrenheit not F).
- Pause: hold on, wait, hang on, hold up, stand by, gimme a minute → action pause.
- Resume: I'm back, let's go, ok I'm ready → action resume only when session is paused."""


def build_session_context(
    recipe: dict[str, Any],
    *,
    phase: str,
    index: int,
    servings: int,
    unit_system: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    ings = payload.get("ingredients") or []
    steps = payload.get("steps") or []
    current_ing = ings[index] if phase == "ingredients" and index < len(ings) else None
    current_step = steps[index] if phase == "steps" and index < len(steps) else None
    remaining_ings = ings[index:] if phase == "ingredients" else ings
    remaining_steps = steps[index:] if phase == "steps" else steps

    return {
        "phase": phase,
        "index": index,
        "servings": servings,
        "unit_system": unit_system,
        "base_servings": recipe.get("base_servings"),
        "ingredient_count": len(ings),
        "step_count": len(steps),
        "current": {
            "ingredient": current_ing,
            "step": current_step,
        },
        "remaining_ingredient_names": [i.get("item") or i.get("raw") for i in remaining_ings],
        "remaining_step_numbers": [s.get("n") for s in remaining_steps],
    }


def _norm_transcript(transcript: str) -> str:
    return " ".join(transcript.lower().split())


def transcript_needs_llm(transcript: str) -> bool:
    """Heuristic: skip LLM for obvious navigation/choreography phrases."""
    t = _norm_transcript(transcript)
    if not t:
        return False
    if re.search(
        r"\b(hold on|hang on|hold up|please hold|please wait|stand by|gimme a minute|"
        r"give me a minute|be a minute|i.?m back|let.?s go|start again|begin again|ok i.?m ready)\b",
        t,
    ):
        return False
    if parse_kitchen_query(transcript):
        return False

    fast = (
        r"^(next|continue|done|ok|okay|yes|ready|go on|move on|skip)$",
        r"^(back|previous|repeat|again|stop|quit|pause|resume|help)$",
        r"^(print|print recipe|print this)$",
        r"^(metric|imperial|celsius|fahrenheit)$",
        r"\b(double|triple|half)\b.*\b(recipe)?$",
        r"^\d+\s*servings?$",
        r"\b(read|list).*(remaining|rest of|left).*(ingredient|step)",
        r"\bgo to (step|ingredient) \d+\b",
        r"^ingredient \d+$",
    )

    for pat in fast:
        if re.search(pat, t):
            return False
    if try_cooking_basics_answer(transcript):
        return False
    # Likely needs reasoning: substitutions, comparisons, how/what/why/can
    if re.search(r"\b(substitut|instead of|swap|replace|can i use|what if)\b", t):
        return True
    if re.search(
        r"\b(technique|equipment|tool|safe|internal|mean|difference|saut[eé]|braise|blanch)\b", t
    ):
        return True
    if re.search(r"^(how|what|why|can|should|is|are|does|explain|tell me)\b", t):
        return True
    return len(t.split()) > 4


def try_kitchen_voice_answer(
    recipe: dict[str, Any],
    transcript: str,
    *,
    servings: int,
    unit_system: str,
) -> str | None:
    """Instant answer for dry/wet/section kitchen queries (server-side mirror of client)."""
    query = parse_kitchen_query(transcript)
    if not query:
        return None

    hidden = set((recipe.get("layout") or {}).get("hidden_ingredient_ids") or [])
    ingredients = [i for i in recipe.get("ingredients") or [] if i.get("id") not in hidden]
    steps = list(recipe.get("instructions") or [])
    order = (recipe.get("layout") or {}).get("step_order")
    if order:
        by_step = {s["step"]: s for s in steps}
        steps = [by_step[n] for n in order if n in by_step]

    kind = query["kind"]
    label = query["label"]

    if kind in ("dry", "wet", "section_ingredients"):
        filtered = filter_ingredients(ingredients, kind=kind, section=query.get("section"))
        return format_ingredient_list(
            filtered,
            label,
            display_fn=lambda ing: ing.get("raw") or ing.get("item") or "",
        )

    if kind == "section_steps" and query.get("section"):
        matched = filter_steps_for_section(steps, query["section"])
        return format_step_list(
            matched,
            label,
            display_fn=lambda s: s[1].get("text") or "",
        )

    return None
