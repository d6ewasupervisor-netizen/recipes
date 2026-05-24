import os
from contextlib import contextmanager
from psycopg_pool import ConnectionPool

DATABASE_URL = os.environ.get("DATABASE_URL")
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

pool = ConnectionPool(conninfo=DATABASE_URL, min_size=1, max_size=5, open=False)


def open_pool():
    pool.open()


def close_pool():
    pool.close()


@contextmanager
def get_conn():
    with pool.connection() as conn:
        yield conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS recipes (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title         TEXT NOT NULL,
    source_url    TEXT,
    image_url     TEXT,
    base_servings INTEGER DEFAULT 4,
    total_time    INTEGER,
    prep_time     INTEGER,
    cook_time     INTEGER,
    ingredients   JSONB NOT NULL DEFAULT '[]'::jsonb,
    instructions  JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes         TEXT,
    unit_system   TEXT DEFAULT 'imperial',
    layout        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes (lower(title));
"""


def init_db():
    with get_conn() as conn:
        conn.execute(SCHEMA)
        conn.commit()
