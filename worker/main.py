"""FastAPI worker sidecar — stateless ML compute for the Tauri Rust core.

Importable as ``worker.main:app``. Launched by Rust from the project venv:

    python -m uvicorn worker.main:app --host 127.0.0.1 --port <port>

Endpoints (see CONTRACT.md "Python worker sidecar — HTTP API"):
    GET  /health     -> {"ok": true}
    POST /gen3d      -> {faces?, textures?, reduced, backend, seed, output, rawOutput?, note?}
    POST /decimate   -> {facesBefore, facesAfter, fidelity, baked, method, ...}
    POST /export     -> {faces, textured}

The OpenAI image stages (multiview sheet, image edit) live in Rust
(src-tauri/src/openai.rs) — the worker only does the Python-bound 3D work.
Request bodies arrive as camelCase JSON from Rust. Heavy imports
(pymeshlab/trimesh/gradio_client) are kept lazy inside the stage functions so
``/health`` responds instantly. The worker persists nothing and enforces no
budget (Rust does that before calling).

On any failure we respond with HTTP 4xx/5xx and JSON ``{"detail": "<message>"}``.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import stages

app = FastAPI(title="assets_gen worker", version="1.0.0")


# --------------------------------------------------------------------------- #
# Request / response models (camelCase fields — bytes-identical to Rust JSON)
# --------------------------------------------------------------------------- #

class Gen3d(BaseModel):
    """Generation parameters as sent by Rust (camelCase).

    Mirrors the CONTRACT ``Gen3d`` interface. ``to_snake`` converts to the
    snake_case dict that the verbatim-ported stage functions consume.
    """
    targetFaceNum: int = 20000
    octreeResolution: int = 256
    numChunks: int = 200000
    guidanceScale: float = 7.5
    texture: bool = True
    stepsV21: int = 30
    stepsMv2: int = 50
    faceCountV21: int = 40000

    def to_snake(self) -> dict:
        return {
            "target_face_num": self.targetFaceNum,
            "octree_resolution": self.octreeResolution,
            "num_chunks": self.numChunks,
            "guidance_scale": self.guidanceScale,
            "texture": self.texture,
            "steps_v21": self.stepsV21,
            "steps_mv2": self.stepsMv2,
            "face_count_v21": self.faceCountV21,
        }


class Gen3dRequest(BaseModel):
    backend: Literal["v21", "mv2"]
    baseUrl: str
    seed: int
    gen3d: Gen3d = Field(default_factory=Gen3d)
    dest: str
    imagePath: Optional[str] = None
    viewDir: Optional[str] = None
    rawDest: Optional[str] = None
    # Native text-to-3D (mv2 only): when set, HunyuanDiT generates the image from
    # this prompt server-side (no views/image needed). Requires the mv2 server
    # launched with --enable_t23d.
    caption: Optional[str] = None


class ExportRequest(BaseModel):
    glb: str
    dest: str


class DecimateParams(BaseModel):
    """Decimation parameters as sent by Rust (camelCase)."""
    targetFaceNum: int = 20000
    mode: Literal["auto", "preserve", "rebake"] = "auto"
    qualityThr: float = 1.0
    boundaryWeight: float = 3.0
    preserveBoundary: bool = True
    preserveNormal: bool = True
    optimalPlacement: bool = True
    planarQuadric: bool = False
    bakeNormalMap: bool = True
    normalMapResolution: int = 1024

    def to_snake(self) -> dict:
        return {
            "target_face_num": self.targetFaceNum,
            "mode": self.mode,
            "quality_thr": self.qualityThr,
            "boundary_weight": self.boundaryWeight,
            "preserve_boundary": self.preserveBoundary,
            "preserve_normal": self.preserveNormal,
            "optimal_placement": self.optimalPlacement,
            "planar_quadric": self.planarQuadric,
            "bake_normal_map": self.bakeNormalMap,
            "normal_map_resolution": self.normalMapResolution,
        }


class DecimateRequest(BaseModel):
    raw: str
    dest: str
    params: DecimateParams = Field(default_factory=DecimateParams)


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/gen3d")
def gen3d(req: Gen3dRequest) -> dict:
    """v21: base64 POST {baseUrl}/generate; mv2: gradio /generation_all. Then mesh-reduce."""
    gen3d_dict = req.gen3d.to_snake()
    dest = Path(req.dest)
    seed = req.seed

    try:
        texture = bool(gen3d_dict["texture"])
        if req.backend == "v21":
            if req.caption and req.caption.strip():
                raise HTTPException(
                    status_code=422,
                    detail="text-to-3D (caption) non supporte par v21 : utiliser le backend mv2")
            if not req.imagePath:
                raise HTTPException(status_code=422, detail="imagePath requis pour le backend v21")
            image = Path(req.imagePath)
            if not image.is_file():
                raise HTTPException(status_code=422, detail=f"image introuvable: {image}")
            glb_bytes = stages.generate_v21(req.baseUrl, image, seed=seed, gen3d=gen3d_dict)
            meta = _finalize_from_bytes(glb_bytes, dest, gen3d_dict["target_face_num"],
                                        raw_dest=req.rawDest, texture=texture)
        else:  # mv2
            text_mode = bool(req.caption and req.caption.strip())
            view_dir = None
            if not text_mode:
                if not req.viewDir:
                    raise HTTPException(
                        status_code=422,
                        detail="viewDir (ou caption) requis pour le backend mv2")
                view_dir = Path(req.viewDir)
                for name in stages.VIEW_FILES:
                    if not (view_dir / name).is_file():
                        raise HTTPException(
                            status_code=422,
                            detail=f"vue manquante pour mv2: {view_dir / name}")
            raw = stages.generate_mv2(
                req.baseUrl, view_dir, seed=seed, gen3d=gen3d_dict,
                texture=texture, caption=req.caption if text_mode else None)
            meta = stages.finalize_glb(
                Path(raw), dest, gen3d_dict["target_face_num"],
                raw_destination=Path(req.rawDest) if req.rawDest else None,
                texture=texture)
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=_msg(error))

    return {**meta, "backend": req.backend, "seed": seed, "output": str(dest)}


@app.post("/decimate")
def decimate(req: DecimateRequest) -> dict:
    """Re-decimate a persisted raw GLB with tunable quality parameters,
    Hausdorff fidelity scoring and optional tangent-space normal-map bake."""
    raw = Path(req.raw)
    if not raw.is_file():
        raise HTTPException(status_code=422, detail=f"GLB brut introuvable: {raw}")
    try:
        return stages.decimate_glb(raw, Path(req.dest), req.params.to_snake())
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=_msg(error))


@app.post("/export")
def export(req: ExportRequest) -> dict:
    """trimesh GLB -> OBJ (+ mtl + texture) in dest's own dir."""
    glb = Path(req.glb)
    dest = Path(req.dest)
    if not glb.is_file():
        raise HTTPException(status_code=422, detail=f"GLB introuvable: {glb}")
    try:
        faces, textured = stages.export_one(glb, dest)
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=_msg(error))
    return {"faces": faces, "textured": textured}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _finalize_from_bytes(glb_bytes: bytes, dest: Path, target_faces: int,
                         raw_dest: Optional[str] = None, *, texture: bool = True) -> dict:
    """v21 returns GLB bytes; persist to a temp file then finalize (reduce/copy)."""
    import tempfile

    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest.parent) as temp_dir:
        raw = Path(temp_dir) / "raw.glb"
        raw.write_bytes(glb_bytes)
        return stages.finalize_glb(raw, dest, target_faces,
                                   raw_destination=Path(raw_dest) if raw_dest else None,
                                   texture=texture)


def _msg(error: Exception) -> str:
    text = str(error).strip()
    return text if text else f"{type(error).__name__}"


# Ensure HTTPException always renders as {"detail": ...} JSON (FastAPI default,
# made explicit here so accidental string responses never leak through).
@app.exception_handler(HTTPException)
def _http_exception_handler(_request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
