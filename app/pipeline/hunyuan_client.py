"""Clients pour les deux backends Hunyuan3D.

- v21 : serveur FastAPI (api_server.py) /generate, image unique base64 -> bytes GLB.
- mv2 : serveur Gradio (gradio_app.py modele 2mv) /generation_all, 4 vues -> chemin GLB.

Ordre exact des arguments /generation_all repris de tools/generate_hunyuan_models.py.
"""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path


def seed_from_id(asset_id: str) -> int:
    digest = hashlib.sha256(asset_id.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % 10_000_000


def _output_path(value) -> Path:
    if isinstance(value, (str, Path)):
        return Path(value)
    if isinstance(value, dict):
        for key in ("path", "name"):
            if value.get(key):
                return Path(value[key])
        if isinstance(value.get("value"), (str, Path)):
            return Path(value["value"])
        if isinstance(value.get("value"), dict):
            return _output_path(value["value"])
    raise ValueError(f"Cannot find file path in Gradio output: {value!r}")


def generate_v21(base_url: str, image_path: Path, *, seed: int, gen3d: dict,
                 timeout: float = 1800.0) -> bytes:
    """POST /generate (Hunyuan3D-2.1 FastAPI). Renvoie les bytes du GLB texture."""
    import httpx

    payload = {
        "image": base64.b64encode(Path(image_path).read_bytes()).decode("ascii"),
        "remove_background": True,
        "texture": bool(gen3d.get("texture", True)),
        "seed": seed,
        "octree_resolution": gen3d.get("octree_resolution", 256),
        "num_inference_steps": gen3d.get("steps_v21", 30),
        "guidance_scale": gen3d.get("guidance_scale", 7.5),
        "num_chunks": gen3d.get("num_chunks", 200000),
        "face_count": gen3d.get("face_count_v21", 40000),
        "type": "glb",
    }
    with httpx.Client(timeout=timeout) as client:
        response = client.post(f"{base_url.rstrip('/')}/generate", json=payload)
    if response.status_code != 200:
        detail = response.text[:500]
        raise RuntimeError(f"/generate HTTP {response.status_code}: {detail}")
    return response.content


def generate_mv2(base_url: str, view_dir: Path, *, seed: int, gen3d: dict,
                 timeout: float = 3600.0) -> Path:
    """submit /generation_all (Hunyuan3D-2mv Gradio) avec les 4 vues. Renvoie le chemin du GLB."""
    from gradio_client import Client, handle_file

    front = handle_file(str(view_dir / "front.png"))
    back = handle_file(str(view_dir / "back.png"))
    left = handle_file(str(view_dir / "left.png"))
    right = handle_file(str(view_dir / "right.png"))
    args = (
        None,            # caption
        None,            # image unique (non utilise en multivue)
        front, back, left, right,
        gen3d.get("steps_mv2", 50),
        gen3d.get("guidance_scale", 7.5),
        seed,
        gen3d.get("octree_resolution", 256),
        True,
        gen3d.get("num_chunks", 200000),
        False,
    )
    client = Client(base_url, verbose=False)
    job = client.submit(*args, api_name="/generation_all")
    result = job.result(timeout=timeout)
    return _output_path(result[1])
