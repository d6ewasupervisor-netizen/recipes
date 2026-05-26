import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from dotenv import load_dotenv
from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Response, UploadFile
from fastapi.responses import Response as RawResponse
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field

import parser as recipe_parser
from auth import (
    SESSION_COOKIE,
    SESSION_MAX_AGE,
    allowed_emails,
    auth_enabled,
    cookie_secure,
    create_session_token,
    require_auth,
    verify_session_token,
)
from db import close_pool, get_conn, init_db, open_pool
from cook_voice import SpeakRequest, VoiceCommandResult, interpret_command, synthesize_speech, transcribe_audio, voice_enabled
from voice_settings import (
    OPENAI_TTS_VOICES,
    VoiceSettings,
    load_voice_settings,
    save_voice_settings,
)
from parser import ParseError
from recipe_images import (
    delete_files_for_recipe,
    ensure_upload_dir,
    is_uploaded_url,
    resolve_image_path,
    save_recipe_image,
)

load_dotenv()

BASE_DIR = Path(__file__).parent


# --- Pydantic models ---


class Ingredient(BaseModel):
    id: str
    raw: str
    quantity: float | None = None
    unit: str | None = None
    item: str
    density_key: str | None = None
    group: str | None = None


class Instruction(BaseModel):
    step: int
    text: str


class Layout(BaseModel):
    ingredient_groups: list[str] = Field(default_factory=list)
    hidden_ingredient_ids: list[str] = Field(default_factory=list)
    step_order: list[int] | None = None


class Recipe(BaseModel):
    id: int | None = None
    title: str
    source_url: str | None = None
    image_url: str | None = None
    base_servings: int = 4
    prep_time: int | None = None
    cook_time: int | None = None
    total_time: int | None = None
    unit_system: str = "imperial"
    notes: str | None = None
    ingredients: list[Ingredient]
    instructions: list[Instruction]
    layout: Layout = Field(default_factory=Layout)


class RecipeSummary(BaseModel):
    id: int
    title: str
    image_url: str | None = None
    total_time: int | None = None


class ParseUrlRequest(BaseModel):
    url: str


class ManualParseRequest(BaseModel):
    title: str = ""
    ingredients_raw: str
    steps_raw: str


class DeleteResponse(BaseModel):
    deleted: bool = True


class LoginRequest(BaseModel):
    email: EmailStr


class AuthStatus(BaseModel):
    auth_required: bool
    authenticated: bool
    email: str | None = None


class VoiceStatus(BaseModel):
    enabled: bool


class CookVoiceRequest(BaseModel):
    recipe_id: int
    transcript: str
    phase: str = "ingredients"
    index: int = 0
    servings: int = 4
    unit_system: str = "imperial"
    session_context: dict[str, Any] | None = None


class VoiceOptionsResponse(BaseModel):
    voices: list[str]


SiteAuth = Annotated[str | None, Depends(require_auth)]


def _row_to_recipe(row: tuple) -> dict[str, Any]:
    (
        rid,
        title,
        source_url,
        image_url,
        base_servings,
        total_time,
        prep_time,
        cook_time,
        ingredients,
        instructions,
        notes,
        unit_system,
        layout,
    ) = row
    return {
        "id": rid,
        "title": title,
        "source_url": source_url,
        "image_url": image_url,
        "base_servings": base_servings,
        "total_time": total_time,
        "prep_time": prep_time,
        "cook_time": cook_time,
        "ingredients": ingredients if isinstance(ingredients, list) else json.loads(ingredients),
        "instructions": instructions if isinstance(instructions, list) else json.loads(instructions),
        "notes": notes,
        "unit_system": unit_system or "imperial",
        "layout": layout if isinstance(layout, dict) else json.loads(layout or "{}"),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    open_pool()
    init_db()
    ensure_upload_dir()
    yield
    close_pool()


app = FastAPI(title="Recipes", lifespan=lifespan)


@app.get("/api/auth/me")
def auth_me(
    recipes_session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> AuthStatus:
    if not auth_enabled():
        return AuthStatus(auth_required=False, authenticated=True)
    email = verify_session_token(recipes_session)
    if email:
        return AuthStatus(auth_required=True, authenticated=True, email=email)
    return AuthStatus(auth_required=True, authenticated=False)


@app.post("/api/auth/login")
def auth_login(body: LoginRequest, response: Response) -> AuthStatus:
    if not auth_enabled():
        return AuthStatus(auth_required=False, authenticated=True)

    email = body.email.strip().lower()
    if email not in allowed_emails():
        raise HTTPException(status_code=403, detail="This email is not authorized")

    token = create_session_token(email)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=cookie_secure(),
        samesite="lax",
        max_age=SESSION_MAX_AGE,
    )
    return AuthStatus(auth_required=True, authenticated=True, email=email)


@app.post("/api/auth/logout")
def auth_logout(response: Response) -> AuthStatus:
    response.delete_cookie(key=SESSION_COOKIE, httponly=True, secure=cookie_secure(), samesite="lax")
    return AuthStatus(auth_required=auth_enabled(), authenticated=False)


@app.post("/api/recipes/parse")
def parse_recipe_url(body: ParseUrlRequest, _auth: SiteAuth) -> Recipe:
    try:
        data = recipe_parser.parse_url(body.url)
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Recipe(**data)


@app.post("/api/recipes/manual")
def parse_recipe_manual(body: ManualParseRequest, _auth: SiteAuth) -> Recipe:
    try:
        data = recipe_parser.parse_manual(body.model_dump())
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Recipe(**data)


@app.post("/api/recipes")
def create_recipe(recipe: Recipe, _auth: SiteAuth) -> Recipe:
    payload = recipe.model_dump(exclude={"id"})
    with get_conn() as conn:
        row = conn.execute(
            """
            INSERT INTO recipes (
                title, source_url, image_url, base_servings, total_time, prep_time,
                cook_time, ingredients, instructions, notes, unit_system, layout
            ) VALUES (
                %(title)s, %(source_url)s, %(image_url)s, %(base_servings)s, %(total_time)s,
                %(prep_time)s, %(cook_time)s, %(ingredients)s, %(instructions)s, %(notes)s,
                %(unit_system)s, %(layout)s
            )
            RETURNING id, title, source_url, image_url, base_servings, total_time, prep_time,
                      cook_time, ingredients, instructions, notes, unit_system, layout
            """,
            {
                **payload,
                "ingredients": json.dumps(payload["ingredients"]),
                "instructions": json.dumps(payload["instructions"]),
                "layout": json.dumps(payload["layout"]),
            },
        ).fetchone()
        conn.commit()
    return Recipe(**_row_to_recipe(row))


@app.get("/api/recipes")
def list_recipes(_auth: SiteAuth) -> list[RecipeSummary]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, title, image_url, total_time FROM recipes ORDER BY lower(title)"
        ).fetchall()
    return [RecipeSummary(id=r[0], title=r[1], image_url=r[2], total_time=r[3]) for r in rows]


@app.get("/api/recipes/{recipe_id}")
def get_recipe(recipe_id: int, _auth: SiteAuth) -> Recipe:
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT id, title, source_url, image_url, base_servings, total_time, prep_time,
                   cook_time, ingredients, instructions, notes, unit_system, layout
            FROM recipes WHERE id = %s
            """,
            (recipe_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return Recipe(**_row_to_recipe(row))


@app.put("/api/recipes/{recipe_id}")
def update_recipe(recipe_id: int, recipe: Recipe, _auth: SiteAuth) -> Recipe:
    payload = recipe.model_dump(exclude={"id"})
    with get_conn() as conn:
        row = conn.execute(
            """
            UPDATE recipes SET
                title = %(title)s, source_url = %(source_url)s, image_url = %(image_url)s,
                base_servings = %(base_servings)s, total_time = %(total_time)s,
                prep_time = %(prep_time)s, cook_time = %(cook_time)s,
                ingredients = %(ingredients)s, instructions = %(instructions)s,
                notes = %(notes)s, unit_system = %(unit_system)s, layout = %(layout)s,
                updated_at = now()
            WHERE id = %(id)s
            RETURNING id, title, source_url, image_url, base_servings, total_time, prep_time,
                      cook_time, ingredients, instructions, notes, unit_system, layout
            """,
            {
                **payload,
                "id": recipe_id,
                "ingredients": json.dumps(payload["ingredients"]),
                "instructions": json.dumps(payload["instructions"]),
                "layout": json.dumps(payload["layout"]),
            },
        ).fetchone()
        conn.commit()
    if not row:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return Recipe(**_row_to_recipe(row))


@app.delete("/api/recipes/{recipe_id}")
def delete_recipe(recipe_id: int, _auth: SiteAuth) -> DeleteResponse:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT image_url FROM recipes WHERE id = %s",
            (recipe_id,),
        ).fetchone()
        cur = conn.execute("DELETE FROM recipes WHERE id = %s RETURNING id", (recipe_id,))
        conn.commit()
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Recipe not found")
    if row and is_uploaded_url(row[0]):
        delete_files_for_recipe(recipe_id)
    return DeleteResponse()


class ImageUrlResponse(BaseModel):
    image_url: str | None


@app.post("/api/recipes/{recipe_id}/image")
async def upload_recipe_image(
    recipe_id: int,
    _auth: SiteAuth,
    file: UploadFile = File(...),
) -> ImageUrlResponse:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        image_url = save_recipe_image(recipe_id, data, file.content_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    with get_conn() as conn:
        row = conn.execute(
            "UPDATE recipes SET image_url = %s, updated_at = now() WHERE id = %s RETURNING id",
            (image_url, recipe_id),
        ).fetchone()
        conn.commit()
    if not row:
        delete_files_for_recipe(recipe_id)
        raise HTTPException(status_code=404, detail="Recipe not found")
    return ImageUrlResponse(image_url=image_url)


@app.delete("/api/recipes/{recipe_id}/image")
def remove_recipe_image(recipe_id: int, _auth: SiteAuth) -> ImageUrlResponse:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT image_url FROM recipes WHERE id = %s",
            (recipe_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recipe not found")
        if is_uploaded_url(row[0]):
            delete_files_for_recipe(recipe_id)
        conn.execute(
            "UPDATE recipes SET image_url = NULL, updated_at = now() WHERE id = %s",
            (recipe_id,),
        )
        conn.commit()
    return ImageUrlResponse(image_url=None)


@app.get("/api/recipe-images/{filename}")
def get_recipe_image(filename: str):
    path = resolve_image_path(filename)
    if not path:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/cook/voice/status")
def cook_voice_status(_auth: SiteAuth) -> VoiceStatus:
    return VoiceStatus(enabled=voice_enabled())


@app.get("/api/cook/voice/options")
def cook_voice_options(_auth: SiteAuth) -> VoiceOptionsResponse:
    return VoiceOptionsResponse(voices=list(OPENAI_TTS_VOICES))


@app.get("/api/cook/voice/settings")
def get_cook_voice_settings(auth: SiteAuth) -> VoiceSettings:
    with get_conn() as conn:
        return load_voice_settings(conn, auth)


@app.put("/api/cook/voice/settings")
def put_cook_voice_settings(settings: VoiceSettings, auth: SiteAuth) -> VoiceSettings:
    with get_conn() as conn:
        saved = save_voice_settings(conn, auth, settings)
        conn.commit()
    return saved


@app.post("/api/cook/speak")
def cook_speak(body: SpeakRequest, auth: SiteAuth) -> RawResponse:
    if not voice_enabled():
        raise HTTPException(status_code=503, detail="Voice assistant is not configured")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    with get_conn() as conn:
        settings = load_voice_settings(conn, auth)
    if not settings.use_cloud_tts:
        raise HTTPException(status_code=400, detail="Cloud TTS disabled in settings")
    try:
        audio = synthesize_speech(text, settings)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Speech synthesis failed") from exc
    return RawResponse(content=audio, media_type="audio/mpeg")


@app.post("/api/cook/voice")
def cook_voice_command(body: CookVoiceRequest, auth: SiteAuth) -> VoiceCommandResult:
    if not voice_enabled():
        raise HTTPException(status_code=503, detail="Voice assistant is not configured")
    transcript = body.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="Empty transcript")

    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT id, title, source_url, image_url, base_servings, total_time, prep_time,
                   cook_time, ingredients, instructions, notes, unit_system, layout
            FROM recipes WHERE id = %s
            """,
            (body.recipe_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Recipe not found")

    recipe = _row_to_recipe(row)
    with get_conn() as conn:
        settings = load_voice_settings(conn, auth)
    try:
        return interpret_command(
            recipe,
            transcript,
            phase=body.phase,
            index=body.index,
            servings=body.servings,
            unit_system=body.unit_system,
            settings=settings,
            session_context=body.session_context,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Voice interpretation failed") from exc


@app.post("/api/cook/transcribe")
async def cook_transcribe(
    _auth: SiteAuth,
    audio: UploadFile = File(...),
) -> dict[str, str]:
    if not voice_enabled():
        raise HTTPException(status_code=503, detail="Voice assistant is not configured")
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio")
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Audio too large")

    filename = audio.filename or "audio.webm"
    try:
        text = transcribe_audio(data, filename=filename)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Transcription failed") from exc
    return {"transcript": text}


@app.get("/data/densities.json")
def get_densities():
    return FileResponse(BASE_DIR / "data" / "densities.json", media_type="application/json")


static_dir = BASE_DIR / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
