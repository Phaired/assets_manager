"""Persistance JSON sur disque : projets, assets et etat de pipeline.

Layout dans le workspace :

    <workspace>/<project>/project.json        # metadonnees + liste d'assets
    <workspace>/<project>/state.json           # etat par asset/etape + budget
    <workspace>/<project>/<asset-id>/multiview/{sheet,front,back,left,right}.png
    <workspace>/<project>/<asset-id>/source.png    # image source manuelle (option)
    <workspace>/<project>/<asset-id>/model.glb
    <workspace>/<project>/<asset-id>/obj/<asset-id>.obj (+ .mtl + texture)

Ecritures atomiques (tmp + replace) reprises des scripts d'origine, protegees par
un verrou re-entrant global (app mono-utilisateur, suffisant ici).
"""
from __future__ import annotations

import json
import re
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from . import config

_LOCK = threading.RLock()

STAGES = ("multiview", "model3d", "export")
VIEW_FILES = ("front.png", "back.png", "left.png", "right.png")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or "item"


# --- chemins -------------------------------------------------------------

def project_dir(name: str) -> Path:
    return config.workspace_dir() / name


def asset_dir(project: str, asset_id: str) -> Path:
    return project_dir(project) / asset_id


def multiview_dir(project: str, asset_id: str) -> Path:
    return asset_dir(project, asset_id) / "multiview"


def model_path(project: str, asset_id: str) -> Path:
    return asset_dir(project, asset_id) / "model.glb"


def source_image_path(project: str, asset_id: str) -> Path:
    return asset_dir(project, asset_id) / "source.png"


def obj_path(project: str, asset_id: str) -> Path:
    return asset_dir(project, asset_id) / "obj" / f"{asset_id}.obj"


# --- io atomique ---------------------------------------------------------

def _read_json(path: Path, default):
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# --- projets -------------------------------------------------------------

def list_projects() -> list[str]:
    root = config.workspace_dir()
    return sorted(p.name for p in root.iterdir() if p.is_dir() and (p / "project.json").is_file())


def create_project(name: str) -> dict:
    name = slugify(name)
    with _LOCK:
        path = project_dir(name) / "project.json"
        if path.is_file():
            return _read_json(path, {})
        data = {"name": name, "created_at": now(), "assets": []}
        _write_json(path, data)
        _write_json(project_dir(name) / "state.json",
                    {"version": 1, "estimated_spend_usd": 0.0, "assets": {}})
        return data


def get_project(name: str) -> dict:
    data = _read_json(project_dir(name) / "project.json", None)
    if data is None:
        raise KeyError(f"projet introuvable: {name}")
    return data


def _save_project(name: str, data: dict) -> None:
    _write_json(project_dir(name) / "project.json", data)


def get_asset(project: str, asset_id: str) -> dict:
    for asset in get_project(project)["assets"]:
        if asset["id"] == asset_id:
            return asset
    raise KeyError(f"asset introuvable: {project}/{asset_id}")


def add_asset(project: str, name: str, description: str, tags: list[str], backend: str) -> dict:
    with _LOCK:
        data = get_project(project)
        base = slugify(name)
        existing = {a["id"] for a in data["assets"]}
        asset_id = base
        i = 2
        while asset_id in existing:
            asset_id = f"{base}-{i}"
            i += 1
        asset = {
            "id": asset_id,
            "name": name,
            "description": description,
            "tags": tags,
            "backend": backend,
            "source": "openai",  # devient "manual" si une image est uploadee
            "created_at": now(),
        }
        data["assets"].append(asset)
        _save_project(project, data)
        # initialise l'etat
        state = load_state(project)
        state["assets"][asset_id] = {s: _blank_stage() for s in STAGES}
        save_state(project, state)
        return asset


def delete_asset(project: str, asset_id: str) -> None:
    import shutil
    with _LOCK:
        data = get_project(project)
        data["assets"] = [a for a in data["assets"] if a["id"] != asset_id]
        _save_project(project, data)
        state = load_state(project)
        state["assets"].pop(asset_id, None)
        save_state(project, state)
        adir = asset_dir(project, asset_id)
        if adir.is_dir():
            shutil.rmtree(adir, ignore_errors=True)


def set_asset_source(project: str, asset_id: str, source: str) -> None:
    with _LOCK:
        data = get_project(project)
        for asset in data["assets"]:
            if asset["id"] == asset_id:
                asset["source"] = source
                break
        _save_project(project, data)


# --- etat ----------------------------------------------------------------

def _blank_stage() -> dict:
    return {"status": "pending", "updated_at": None, "error": None, "meta": {}}


def load_state(project: str) -> dict:
    return _read_json(project_dir(project) / "state.json",
                      {"version": 1, "estimated_spend_usd": 0.0, "assets": {}})


def save_state(project: str, state: dict) -> None:
    _write_json(project_dir(project) / "state.json", state)


def update_stage(project: str, asset_id: str, stage: str, *, status: str,
                 error: str | None = None, meta: dict | None = None) -> None:
    with _LOCK:
        state = load_state(project)
        assets = state.setdefault("assets", {})
        stages = assets.setdefault(asset_id, {s: _blank_stage() for s in STAGES})
        entry = stages.setdefault(stage, _blank_stage())
        entry["status"] = status
        entry["updated_at"] = now()
        entry["error"] = error
        if meta is not None:
            entry["meta"] = meta
        save_state(project, state)


def reset_stale_stages() -> int:
    """Au demarrage : un job 'running'/'queued' ne peut pas survivre a un redemarrage
    (le worker est en memoire). On les marque 'error' pour debloquer l'UI."""
    count = 0
    with _LOCK:
        for project in list_projects():
            state = load_state(project)
            changed = False
            for stages in state.get("assets", {}).values():
                for entry in stages.values():
                    if entry.get("status") in ("running", "queued"):
                        entry.update({"status": "error", "updated_at": now(),
                                      "error": "interrompu (redemarrage de l'app)"})
                        changed = True
                        count += 1
            if changed:
                save_state(project, state)
    return count


def reset_asset(project: str, asset_id: str) -> None:
    """Remet a 'pending' les etapes bloquees (running/queued/error) d'un asset."""
    with _LOCK:
        state = load_state(project)
        stages = state.get("assets", {}).get(asset_id)
        if not stages:
            return
        for entry in stages.values():
            if entry.get("status") in ("running", "queued", "error"):
                entry.update({"status": "pending", "updated_at": now(), "error": None})
        save_state(project, state)


def add_spend(project: str, amount: float) -> float:
    with _LOCK:
        state = load_state(project)
        state["estimated_spend_usd"] = round(float(state.get("estimated_spend_usd", 0.0)) + amount, 6)
        save_state(project, state)
        return state["estimated_spend_usd"]
