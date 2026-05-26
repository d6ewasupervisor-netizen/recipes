"""Preloaded cooking-assistant skills and compact context for voice LLM calls."""

from __future__ import annotations

from typing import Any

# Kept short for latency; client mirrors key rules for instant handling.
SKILLS_PROMPT = """SKILLS (apply without inventing recipe facts):
- Navigation: next/back/repeat; read remaining or all ingredients/steps from current index.
- Servings: scale all ingredient amounts proportionally (base_servings → current_servings).
- Units: imperial↔metric; volumes may convert to grams when density_key exists in recipe data.
- Substitutions: suggest only common safe swaps (butter↔oil, milk↔cream, brown↔white sugar); warn when unsure; never change recipe DB.
- Temperatures: read from steps/notes; convert F↔C when user unit_system differs.
- Timing: extract bake/chill/rest times from steps and notes.
- Print: user says print → action print_recipe (client prints).
- Current position: respect session.phase and session.index; "this/that" means current item.
- Be brief in speech. Do not tell user to say "next" unless they ask for help.
- In speech text use full words (teaspoon not tsp, tablespoon not tbsp, ounce, cup, degrees Fahrenheit).
- Pause: hold on, wait, hang on, give me a minute → action pause (stop listening until user resumes).
- Resume: I'm back, let's go, start again, ok I'm ready → action resume only when session is paused."""


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
    import re

    for pat in fast:
        if re.search(pat, t):
            return False
    # Likely needs reasoning: substitutions, comparisons, how/what/why/can
    if re.search(r"\b(substitut|instead of|swap|replace|can i use|what if)\b", t):
        return True
    if re.search(r"^(how|what|why|can|should|is|are|does)\b", t):
        return True
    return len(t.split()) > 6
