"""Routes HTTP de l'API (prefixe /api)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from . import config, store
from .jobs import jobs
from .models import (AssetCreate, ConfigUpdate, GenerateRequest, ProjectCreate,
                     ServerStartRequest)
from .pipeline.server_manager import manager

router = APIRouter()


# --- config --------------------------------------------------------------

@router.get("/config")
def get_config() -> dict:
    cfg = config.load_config()
    return {
        "openai_model": cfg["openai_model"],
        "openai_quality": cfg["openai_quality"],
        "openai_timeout": cfg["openai_timeout"],
        "estimated_cost_per_image": cfg["estimated_cost_per_image"],
        "budget_usd": cfg["budget_usd"],
        "default_backend": cfg["default_backend"],
        "workspace_dir": cfg["workspace_dir"],
        "openai_key_set": bool(config.openai_key(cfg)),
        "gen3d": cfg["gen3d"],
        "hunyuan": {b: {k: cfg["hunyuan"][b][k] for k in ("dir", "port", "model_path")}
                    for b in ("v21", "mv2")},
    }


@router.put("/config")
def update_config(payload: ConfigUpdate) -> dict:
    cfg = config.load_config()
    # fusion profonde : gen3d partiel ne doit pas ecraser les autres cles
    merged = config._deep_merge(cfg, payload.model_dump(exclude_none=True))
    config.save_config(merged)
    return get_config()


# --- projets -------------------------------------------------------------

@router.get("/projects")
def list_projects() -> dict:
    return {"projects": store.list_projects()}


@router.post("/projects")
def create_project(payload: ProjectCreate) -> dict:
    return store.create_project(payload.name)


@router.get("/projects/{name}")
def get_project(name: str) -> dict:
    try:
        project = store.get_project(name)
    except KeyError:
        raise HTTPException(404, "projet introuvable")
    return {"project": project, "state": store.load_state(name), "jobs": jobs.snapshot()}


# --- assets --------------------------------------------------------------

@router.post("/projects/{name}/assets")
def create_asset(name: str, payload: AssetCreate) -> dict:
    try:
        return store.add_asset(name, payload.name, payload.description,
                               payload.tags, payload.backend)
    except KeyError:
        raise HTTPException(404, "projet introuvable")


@router.delete("/projects/{name}/assets/{asset_id}")
def delete_asset(name: str, asset_id: str) -> dict:
    store.delete_asset(name, asset_id)
    return {"ok": True}


@router.post("/projects/{name}/assets/{asset_id}/source")
async def upload_source(name: str, asset_id: str, file: UploadFile) -> dict:
    from PIL import Image
    from io import BytesIO

    try:
        store.get_asset(name, asset_id)
    except KeyError:
        raise HTTPException(404, "asset introuvable")
    data = await file.read()
    dest = store.source_image_path(name, asset_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # normalise en PNG
    Image.open(BytesIO(data)).convert("RGBA").save(dest)
    store.set_asset_source(name, asset_id, "manual")
    return {"ok": True, "source": "manual"}


@router.post("/projects/{name}/assets/{asset_id}/reset")
def reset_asset(name: str, asset_id: str) -> dict:
    store.reset_asset(name, asset_id)
    return {"ok": True}


@router.post("/projects/{name}/assets/{asset_id}/generate")
def generate(name: str, asset_id: str, payload: GenerateRequest) -> dict:
    try:
        store.get_asset(name, asset_id)
    except KeyError:
        raise HTTPException(404, "asset introuvable")
    return jobs.enqueue(name, asset_id, payload.stages)


# --- serveur Hunyuan -----------------------------------------------------

@router.get("/server")
def server_status() -> dict:
    return manager.status()


@router.post("/server/start")
def server_start(payload: ServerStartRequest) -> dict:
    manager.start(payload.backend)
    return manager.status()


@router.post("/server/stop")
def server_stop() -> dict:
    manager.stop()
    return manager.status()
