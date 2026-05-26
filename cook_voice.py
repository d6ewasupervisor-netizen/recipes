"""Cook-mode voice: OpenAI transcription, TTS, and command interpretation."""

from __future__ import annotations

import json
import os
from io import BytesIO
from typing import Any, Literal

from openai import OpenAI
from pydantic import BaseModel

from cook_skills import SKILLS_PROMPT, build_session_context, transcript_needs_llm, try_kitchen_voice_answer
from speech_normalize import normalize_for_speech
from voice_settings import VoiceSettings

VoiceAction = Literal[
    "next",
    "back",
    "repeat",
    "stop",
    "pause",
    "resume",
    "help",
    "goto_ingredients",
    "goto_steps",
    "read_remaining_ingredients",
    "read_remaining_steps",
    "read_all_ingredients",
    "read_all_steps",
    "print_recipe",
    "answer",
    "noop",
]


class VoiceCommandResult(BaseModel):
    action: VoiceAction = "noop"
    speech: str = ""
    servings: int | None = None
    unit_system: Literal["imperial", "metric"] | None = None
    phase: Literal["ingredients", "steps"] | None = None
    index: int | None = None


class SpeakRequest(BaseModel):
    text: str


def voice_enabled() -> bool:
    return bool(os.getenv("OPENAI_API_KEY", "").strip())


def _client() -> OpenAI:
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def _voice_model() -> str:
    return os.getenv("OPENAI_VOICE_MODEL", "gpt-4o-mini")


def _transcribe_model() -> str:
    return os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")


def _recipe_payload(recipe: dict[str, Any], servings: int, unit_system: str) -> dict[str, Any]:
    hidden = set((recipe.get("layout") or {}).get("hidden_ingredient_ids") or [])
    ingredients = [
        ing for ing in recipe.get("ingredients") or [] if ing.get("id") not in hidden
    ]
    steps = recipe.get("instructions") or []
    order = (recipe.get("layout") or {}).get("step_order")
    if order:
        by_step = {s["step"]: s for s in steps}
        steps = [by_step[n] for n in order if n in by_step]

    return {
        "title": recipe.get("title"),
        "base_servings": recipe.get("base_servings"),
        "current_servings": servings,
        "unit_system": unit_system,
        "notes": recipe.get("notes"),
        "prep_time": recipe.get("prep_time"),
        "cook_time": recipe.get("cook_time"),
        "total_time": recipe.get("total_time"),
        "ingredients": [
            {
                "n": i + 1,
                "raw": ing.get("raw"),
                "quantity": ing.get("quantity"),
                "unit": ing.get("unit"),
                "item": ing.get("item"),
                "group": ing.get("group"),
            }
            for i, ing in enumerate(ingredients)
        ],
        "steps": [{"n": i + 1, "text": s.get("text")} for i, s in enumerate(steps)],
    }


def transcribe_audio(data: bytes, filename: str = "audio.webm") -> str:
    client = _client()
    buf = BytesIO(data)
    buf.name = filename
    result = client.audio.transcriptions.create(
        model=_transcribe_model(),
        file=buf,
        language="en",
    )
    return (result.text or "").strip()


def synthesize_speech(text: str, settings: VoiceSettings) -> bytes:
    voice = settings.tts_voice if settings.tts_voice in (
        "alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"
    ) else "nova"
    model = settings.tts_model if settings.tts_model in ("tts-1", "tts-1-hd") else "tts-1-hd"
    spoken = normalize_for_speech(text)
    response = _client().audio.speech.create(
        model=model,
        voice=voice,
        input=spoken[:4096],
        response_format="mp3",
    )
    return response.content


def interpret_command(
    recipe: dict[str, Any],
    transcript: str,
    *,
    phase: str,
    index: int,
    servings: int,
    unit_system: str,
    settings: VoiceSettings,
    session_context: dict[str, Any] | None = None,
) -> VoiceCommandResult:
    kitchen_speech = try_kitchen_voice_answer(
        recipe, transcript, servings=servings, unit_system=unit_system
    )
    if kitchen_speech:
        return VoiceCommandResult(action="answer", speech=kitchen_speech)

    if not transcript_needs_llm(transcript):
        return VoiceCommandResult(action="noop", speech="")

    client = _client()
    payload = _recipe_payload(recipe, servings, unit_system)
    session = build_session_context(
        recipe, phase=phase, index=index, servings=servings, unit_system=unit_system, payload=payload
    )
    if session_context:
        session.update(session_context)

    prefs = {
        "verbosity": settings.verbosity,
        "assistant_name": settings.assistant_name,
        "custom_commands": [c.model_dump() for c in settings.custom_commands],
    }

    system = f"""{SKILLS_PROMPT}

Personality: {settings.personality}
Verbosity: {settings.verbosity} (minimal = no "say next" reminders).
{f'User calls you: {settings.assistant_name}' if settings.assistant_name else ''}

Return JSON. Actions: next, back, repeat, stop, pause, resume, help, goto_ingredients, goto_steps,
read_remaining_ingredients, read_remaining_steps, read_all_ingredients, read_all_steps,
print_recipe, answer, noop.
Set index (0-based) when jumping. Set servings/unit_system when changing scale or units.
Custom phrase overrides: {json.dumps(prefs['custom_commands'], ensure_ascii=False)}"""

    user = json.dumps(
        {
            "transcript": transcript,
            "session": session,
            "recipe": payload,
        },
        ensure_ascii=False,
    )

    completion = client.chat.completions.create(
        model=_voice_model(),
        temperature=0.25,
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "voice_command",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "next",
                                "back",
                                "repeat",
                                "stop",
                                "pause",
                                "resume",
                                "help",
                                "goto_ingredients",
                                "goto_steps",
                                "read_remaining_ingredients",
                                "read_remaining_steps",
                                "read_all_ingredients",
                                "read_all_steps",
                                "print_recipe",
                                "answer",
                                "noop",
                            ],
                        },
                        "speech": {"type": "string"},
                        "servings": {"type": ["integer", "null"]},
                        "unit_system": {"type": ["string", "null"]},
                        "phase": {"type": ["string", "null"]},
                        "index": {"type": ["integer", "null"]},
                    },
                    "required": [
                        "action",
                        "speech",
                        "servings",
                        "unit_system",
                        "phase",
                        "index",
                    ],
                    "additionalProperties": False,
                },
            },
        },
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )

    raw = completion.choices[0].message.content or "{}"
    data = json.loads(raw)
    return VoiceCommandResult.model_validate(data)
