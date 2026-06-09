"""Modeles Pydantic pour les corps de requete de l'API.

Les donnees persistees (projets/assets/etat) sont des dicts JSON geres par store.py ;
ces modeles ne servent qu'a valider/documenter les entrees HTTP.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Backend = Literal["auto", "v21", "mv2"]
Stage = Literal["multiview", "model3d", "export"]


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1)


class AssetCreate(BaseModel):
    name: str = Field(..., min_length=1)
    description: str = ""
    tags: list[str] = []
    backend: Backend = "auto"


class GenerateRequest(BaseModel):
    stages: list[Stage] = ["multiview", "model3d", "export"]


class ServerStartRequest(BaseModel):
    backend: Literal["v21", "mv2"] = "v21"


class ConfigUpdate(BaseModel):
    """Champs editables depuis l'UI Reglages (tous optionnels).

    gen3d est un dict partiel fusionne en profondeur (les cles absentes sont conservees).
    """

    openai_api_key: str | None = None
    openai_model: str | None = None
    openai_quality: str | None = None
    openai_timeout: int | None = None
    estimated_cost_per_image: float | None = None
    budget_usd: float | None = None
    default_backend: Literal["v21", "mv2"] | None = None
    workspace_dir: str | None = None
    gen3d: dict | None = None
