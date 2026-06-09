"""Configuration de l'app : valeurs par defaut + config.json + .env.

La config vit dans ``config.json`` a la racine du projet et est fusionnee par-dessus
les defauts ci-dessous. La cle OpenAI peut venir de la config OU de l'environnement
(.env charge via python-dotenv).
"""
from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path

from dotenv import load_dotenv

# Racine du projet = parent du dossier app/
ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"

load_dotenv(ROOT / ".env")

DEFAULTS: dict = {
    # Ou sont stockes les projets/assets generes.
    "workspace_dir": str(ROOT / "workspace"),
    # OpenAI multivue
    "openai_api_key": "",  # vide => fallback sur $OPENAI_API_KEY
    "openai_model": "gpt-image-2",
    "openai_quality": "medium",  # low | medium | high
    "openai_timeout": 300,
    "openai_max_retries": 2,
    "budget_usd": 5.0,
    "estimated_cost_per_image": 0.063,
    # Backend 3D par defaut quand un asset est en "auto" et qu'aucun serveur ne tourne.
    "default_backend": "v21",  # v21 | mv2
    # Parametres de generation 3D
    "gen3d": {
        "target_face_num": 20000,
        "octree_resolution": 256,
        "num_chunks": 200000,
        "guidance_scale": 7.5,
        "texture": True,
        # Le modele de forme 2.1 (FastAPI) est rapide : peu de steps suffisent.
        "steps_v21": 30,
        # Le serveur 2mv (Gradio) suit la recette historique a 50 steps.
        "steps_mv2": 50,
        "face_count_v21": 40000,  # plafond cote serveur 2.1 avant reduction locale
    },
    # Installs Hunyuan locales : commandes de lancement des serveurs.
    "hunyuan": {
        "v21": {
            "dir": r"C:\dev\3dmodel\Hunyuan3D-2.1",
            "python": r"C:\dev\3dmodel\Hunyuan3D-2.1\.venv\Scripts\python.exe",
            "script": "api_server.py",
            "host": "127.0.0.1",
            "port": 8081,
            "model_path": "tencent/Hunyuan3D-2.1",
            "subfolder": "hunyuan3d-dit-v2-1",
            "extra_args": ["--low_vram_mode", "--enable_flashvdm"],
        },
        "mv2": {
            "dir": r"C:\dev\3dmodel\Hunyuan3D-2",
            "python": r"C:\dev\3dmodel\Hunyuan3D-2\.venv\Scripts\python.exe",
            "script": "gradio_app.py",
            "host": "127.0.0.1",
            "port": 8080,
            "model_path": "tencent/Hunyuan3D-2mv",
            "subfolder": "hunyuan3d-dit-v2-mv",
            "texgen_model_path": "tencent/Hunyuan3D-2",
            # flashvdm accelere ENORMEMENT l'etape "Volume Decoding" (sinon ~30 min) ;
            # low_vram_mode evite l'OOM sur 16 Go. Mêmes flags que lancer_hunyuan3d.bat.
            "extra_args": ["--low_vram_mode", "--enable_flashvdm"],
        },
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    on_disk = {}
    if CONFIG_PATH.is_file():
        try:
            on_disk = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            on_disk = {}
    return _deep_merge(DEFAULTS, on_disk)


def save_config(config: dict) -> dict:
    """Sauve uniquement le merge complet (atomique)."""
    merged = _deep_merge(DEFAULTS, config)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CONFIG_PATH)
    return merged


def openai_key(config: dict | None = None) -> str:
    config = config or load_config()
    return (config.get("openai_api_key") or "").strip() or os.environ.get("OPENAI_API_KEY", "").strip()


def workspace_dir(config: dict | None = None) -> Path:
    config = config or load_config()
    path = Path(config["workspace_dir"])
    path.mkdir(parents=True, exist_ok=True)
    return path


def logs_dir() -> Path:
    path = ROOT / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path
