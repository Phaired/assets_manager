"""Point d'entree FastAPI : sert l'UI (web/), expose l'API (/api) et les artefacts (/files)."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, store
from .routes import router

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="assets_gen", description="Pipeline GPT-image -> Hunyuan3D -> OBJ")

app.include_router(router, prefix="/api")

# Artefacts du workspace (images multivue, model.glb) accessibles au navigateur.
app.mount("/files", StaticFiles(directory=str(config.workspace_dir())), name="files")
# Statiques de l'UI.
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.on_event("startup")
def _reset_stale() -> None:
    try:
        n = store.reset_stale_stages()
        if n:
            print(f"[assets_gen] {n} etape(s) bloquee(s) reinitialisee(s) au demarrage.")
    except Exception as error:  # noqa: BLE001
        print(f"[assets_gen] reset stale ignore: {error!r}")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(str(WEB_DIR / "index.html"))
