"""Store and serve user-uploaded recipe photos."""

from __future__ import annotations

import re
import secrets
from pathlib import Path

UPLOAD_DIR = Path(__file__).parent / "data" / "recipe-images"
ALLOWED_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
MAX_BYTES = 8 * 1024 * 1024
_FILENAME_RE = re.compile(r"^(\d+)-[a-f0-9]+\.(jpg|jpeg|png|webp|gif)$", re.I)


def ensure_upload_dir() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def is_uploaded_url(url: str | None) -> bool:
    return bool(url and url.startswith("/api/recipe-images/"))


def parse_filename(name: str) -> int | None:
    m = _FILENAME_RE.match(name)
    return int(m.group(1)) if m else None


def delete_files_for_recipe(recipe_id: int) -> None:
    ensure_upload_dir()
    for path in UPLOAD_DIR.glob(f"{recipe_id}-*"):
        if path.is_file():
            path.unlink(missing_ok=True)


def save_recipe_image(recipe_id: int, content: bytes, content_type: str | None) -> str:
    ext = ALLOWED_TYPES.get((content_type or "").lower())
    if not ext:
        raise ValueError("Use JPEG, PNG, WebP, or GIF")
    if len(content) > MAX_BYTES:
        raise ValueError("Image must be 8 MB or smaller")
    ensure_upload_dir()
    delete_files_for_recipe(recipe_id)
    filename = f"{recipe_id}-{secrets.token_hex(8)}{ext}"
    (UPLOAD_DIR / filename).write_bytes(content)
    return f"/api/recipe-images/{filename}"


def resolve_image_path(filename: str) -> Path | None:
    if not _FILENAME_RE.match(filename):
        return None
    path = (UPLOAD_DIR / filename).resolve()
    try:
        path.relative_to(UPLOAD_DIR.resolve())
    except ValueError:
        return None
    return path if path.is_file() else None
