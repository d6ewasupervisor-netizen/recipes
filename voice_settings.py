"""Per-user voice assistant preferences (Postgres)."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field

SETTINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS user_settings (
    email         TEXT PRIMARY KEY,
    voice_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

DEFAULT_EMAIL = "__default__"

OPENAI_TTS_VOICES = ("alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer")


class CustomCommand(BaseModel):
    phrases: list[str] = Field(default_factory=list)
    action: str = "next"
    speech: str = ""


class VoiceSettings(BaseModel):
    tts_voice: str = "nova"
    tts_model: Literal["tts-1", "tts-1-hd"] = "tts-1"
    speech_rate: float = Field(default=1.0, ge=0.75, le=1.5)
    listen_seconds: float = 3.2
    push_to_talk: bool = False
    use_cloud_tts: bool = True
    verbosity: Literal["minimal", "normal", "chatty"] = "minimal"
    prompt_once: bool = True
    personality: str = (
        "You are a warm, encouraging cooking companion. Keep replies short and natural."
    )
    assistant_name: str = ""
    custom_commands: list[CustomCommand] = Field(default_factory=list)


def settings_key(email: str | None) -> str:
    return (email or DEFAULT_EMAIL).strip().lower() or DEFAULT_EMAIL


def merge_settings(raw: dict[str, Any] | None) -> VoiceSettings:
    if not raw:
        return VoiceSettings()
    base = VoiceSettings().model_dump()
    base.update(raw)
    if "custom_commands" in raw:
        base["custom_commands"] = [
            c if isinstance(c, dict) else {"phrases": [], "action": "next", "speech": ""}
            for c in raw.get("custom_commands") or []
        ]
    return VoiceSettings.model_validate(base)


def load_voice_settings(conn, email: str | None) -> VoiceSettings:
    key = settings_key(email)
    row = conn.execute(
        "SELECT voice_settings FROM user_settings WHERE email = %s",
        (key,),
    ).fetchone()
    if not row:
        return VoiceSettings()
    data = row[0] if isinstance(row[0], dict) else json.loads(row[0] or "{}")
    return merge_settings(data)


def save_voice_settings(conn, email: str | None, settings: VoiceSettings) -> VoiceSettings:
    key = settings_key(email)
    payload = settings.model_dump()
    conn.execute(
        """
        INSERT INTO user_settings (email, voice_settings, updated_at)
        VALUES (%s, %s::jsonb, now())
        ON CONFLICT (email) DO UPDATE SET
            voice_settings = EXCLUDED.voice_settings,
            updated_at = now()
        """,
        (key, json.dumps(payload)),
    )
    return settings
