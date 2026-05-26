# Recipes

Single-user recipe app (FastAPI + Postgres). See `BUILD_SPEC.md` for the full product spec.

## Prerequisites

- Python 3.12 (recommended; see `.python-version`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) for local Postgres (port **5433**)

## First-time setup

```powershell
.\scripts\setup.ps1
```

Or manually:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
docker compose up -d
```

## Run locally

```powershell
.\.venv\Scripts\Activate.ps1
docker compose up -d
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000

## Environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `AUTH_ALLOWED_EMAILS` | Comma-separated emails allowed to sign in. Leave empty to disable auth locally. |
| `AUTH_SECRET` | Secret for signing session cookies (required when allowlist is set). |
| `OPENAI_API_KEY` | Enables cook-mode cloud speech (STT + Q&A). **Required for iPhone.** |
| `OPENAI_VOICE_MODEL` | Optional; default `gpt-4o-mini` |
| `OPENAI_TRANSCRIBE_MODEL` | Optional; default `gpt-4o-mini-transcribe` |
| `PORT` | Set by Railway in production |

## Deploy (Railway)

Project: **adventurous-acceptance** → service **recipes**

```powershell
railway link -p adventurous-acceptance -s recipes
railway up          # when ready to deploy
railway variables   # set DATABASE_URL, AUTH_ALLOWED_EMAILS, AUTH_SECRET, OPENAI_API_KEY
```

Start command (also in `railway.json`):

```
uvicorn main:app --host 0.0.0.0 --port $PORT
```

**Do not deploy until the owner confirms** — config is deploy-ready per BUILD_SPEC.

## Useful commands

```powershell
docker compose ps
docker compose down
docker compose down -v && docker compose up -d   # reset DB

python convert.py    # ingredient parser self-test
python parser.py     # scraper smoke test
```
