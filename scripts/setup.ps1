$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host "Creating virtual environment (Python 3.12)..." -ForegroundColor Cyan
if (-not (Test-Path ".venv")) {
    py -3.12 -m venv .venv
}

Write-Host "Installing Python dependencies..." -ForegroundColor Cyan
& .\.venv\Scripts\python -m pip install --upgrade pip
& .\.venv\Scripts\pip install -r requirements.txt

if (-not (Test-Path ".env")) {
    Write-Host "Creating .env from .env.example..." -ForegroundColor Cyan
    Copy-Item .env.example .env
}

Write-Host "Starting Postgres (requires Docker Desktop)..." -ForegroundColor Cyan
docker compose up -d

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "  Activate venv:  .\.venv\Scripts\Activate.ps1"
Write-Host "  Run app:        uvicorn main:app --reload --host 127.0.0.1 --port 8000"
Write-Host "  Open:           http://127.0.0.1:8000"
