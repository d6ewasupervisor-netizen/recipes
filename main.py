import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import parser as recipe_parser
from db import close_pool, get_conn, init_db, open_pool
from parser import ParseError

load_dotenv()

APP_PASSPHRASE = os.environ.get("APP_PASSPHRASE", "")
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


def require_passphrase(
    x_app_passphrase: Annotated[str | None, Header()] = None,
) -> None:
    if not APP_PASSPHRASE:
        return
    if x_app_passphrase != APP_PASSPHRASE:
        raise HTTPException(status_code=401, detail="Invalid passphrase")


WriteAuth = Annotated[None, Depends(require_passphrase)]


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
    yield
    close_pool()


app = FastAPI(title="Recipes", lifespan=lifespan)


@app.post("/api/recipes/parse")
def parse_recipe_url(body: ParseUrlRequest, _auth: WriteAuth) -> Recipe:
    try:
        data = recipe_parser.parse_url(body.url)
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Recipe(**data)


@app.post("/api/recipes/manual")
def parse_recipe_manual(body: ManualParseRequest, _auth: WriteAuth) -> Recipe:
    try:
        data = recipe_parser.parse_manual(body.model_dump())
    except ParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Recipe(**data)


@app.post("/api/recipes")
def create_recipe(recipe: Recipe, _auth: WriteAuth) -> Recipe:
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
def list_recipes() -> list[RecipeSummary]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, title, image_url, total_time FROM recipes ORDER BY lower(title)"
        ).fetchall()
    return [RecipeSummary(id=r[0], title=r[1], image_url=r[2], total_time=r[3]) for r in rows]


@app.get("/api/recipes/{recipe_id}")
def get_recipe(recipe_id: int) -> Recipe:
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
def update_recipe(recipe_id: int, recipe: Recipe, _auth: WriteAuth) -> Recipe:
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
def delete_recipe(recipe_id: int, _auth: WriteAuth) -> DeleteResponse:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM recipes WHERE id = %s RETURNING id", (recipe_id,))
        conn.commit()
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Recipe not found")
    return DeleteResponse()


@app.get("/data/densities.json")
def get_densities():
    return FileResponse(BASE_DIR / "data" / "densities.json", media_type="application/json")


static_dir = BASE_DIR / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
