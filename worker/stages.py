"""Heavy ML stage implementations for the worker sidecar.

The logic here is ported VERBATIM (same parameters, same order) from the
original ``app/pipeline/`` modules:

- ``hunyuan_client.py`` : seed_from_id, generate_v21 payload, generate_mv2 gradio arg order.
- ``mesh.py``       : finalize_glb / reduce_textured_glb.
- ``export_obj.py`` : export_one.

The OpenAI image stages (multiview sheet + edit) moved to Rust
(src-tauri/src/openai.rs). All heavy third-party imports (gradio_client,
pymeshlab, trimesh, numpy) are kept LAZY inside the functions so that importing
this module — and therefore ``GET /health`` — stays instant.
"""
from __future__ import annotations

import base64
import hashlib
import shutil
import tempfile
from pathlib import Path

# --------------------------------------------------------------------------- #
# Constants (verbatim from the originals)
# --------------------------------------------------------------------------- #

VIEW_FILES = ("front.png", "back.png", "left.png", "right.png")


# --------------------------------------------------------------------------- #
# Hunyuan clients (port of app/pipeline/hunyuan_client.py)
# --------------------------------------------------------------------------- #

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
    """POST /generate (Hunyuan3D-2.1 FastAPI). Returns the textured GLB bytes.

    Payload keys are EXACTLY those of the original ``generate_v21``.
    """
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
    """submit /generation_all (Hunyuan3D-2mv Gradio). Returns the GLB path.

    Argument ORDER is EXACTLY that of the original ``generate_mv2``.
    """
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


# --------------------------------------------------------------------------- #
# Mesh reduction (port of app/pipeline/mesh.py)
# --------------------------------------------------------------------------- #

def face_and_texture_count(path: Path) -> tuple[int, int]:
    import pymeshlab
    mesh_set = pymeshlab.MeshSet()
    mesh_set.load_new_mesh(str(path))
    mesh = mesh_set.current_mesh()
    return mesh.face_number(), mesh.texture_number()


def reduce_textured_glb(source: Path, destination: Path, target_faces: int) -> tuple[int, int]:
    import numpy as np
    import pymeshlab
    import trimesh
    from PIL import Image
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temp_dir:
        reduced_path = Path(temp_dir) / "reduced.glb"
        mesh_set = pymeshlab.MeshSet()
        mesh_set.load_new_mesh(str(source))
        mesh = mesh_set.current_mesh()
        if mesh.texture_number() <= 0 or not mesh.has_wedge_tex_coord():
            raise RuntimeError("Source GLB has no usable texture or wedge UV coordinates")
        if mesh.face_number() > target_faces:
            mesh_set.apply_filter(
                "meshing_decimation_quadric_edge_collapse_with_texture",
                targetfacenum=target_faces,
                qualitythr=1.0,
                preserveboundary=True,
                boundaryweight=3,
                preservenormal=True,
            )
        mesh = mesh_set.current_mesh()
        texture_path = Path(temp_dir) / "texture.png"
        mesh.texture(0).save(str(texture_path))
        texture = Image.open(texture_path).convert("RGBA")

        # GLB = UV par sommet, PyMeshLab = UV par coin : on duplique les sommets
        # de coin pour preserver les coutures de texture a l'export.
        source_vertices = mesh.vertex_matrix()
        source_faces = mesh.face_matrix()
        corner_indices = source_faces.reshape(-1)
        vertices = source_vertices[corner_indices]
        faces = np.arange(len(corner_indices), dtype=np.int64).reshape(-1, 3)
        uv = mesh.wedge_tex_coord_matrix().reshape(-1, 2).copy()
        # Explicit PBR material with WHITE baseColorFactor. Without a material,
        # trimesh assigns its default gray (baseColorFactor=[102,102,102,255]=0.4),
        # which multiplies the albedo by 0.4 in every viewer/Roblox -> assets render
        # at 40% brightness. White factor shows the full baked texture.
        material = PBRMaterial(
            baseColorTexture=texture,
            baseColorFactor=[255, 255, 255, 255],
            metallicFactor=0.0,
            roughnessFactor=1.0,
        )
        visual = TextureVisuals(uv=uv, image=texture, material=material)
        reduced = trimesh.Trimesh(vertices=vertices, faces=faces, visual=visual, process=False)
        reduced.export(reduced_path)
        faces_n, textures_n = face_and_texture_count(reduced_path)
        if faces_n <= 0:
            raise RuntimeError("Reduced GLB contains no faces")
        if textures_n <= 0:
            raise RuntimeError("Reduced GLB lost its texture")
        shutil.copy2(reduced_path, destination)
    return faces_n, textures_n


def finalize_glb(source: Path, destination: Path, target_faces: int) -> dict:
    """Try texture-preserving reduction; otherwise copy the raw GLB as-is.

    Returns a meta dict ``{faces, textures, reduced, note?}``.
    """
    try:
        faces, textures = reduce_textured_glb(source, destination, target_faces)
        return {"faces": faces, "textures": textures, "reduced": True}
    except Exception as error:  # noqa: BLE001 - fallback robuste
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        meta = {"reduced": False, "note": f"reduction ignoree: {error!r}"}
        try:
            meta["faces"], meta["textures"] = face_and_texture_count(destination)
        except Exception:  # noqa: BLE001
            pass
        return meta


# --------------------------------------------------------------------------- #
# OBJ export (port of app/pipeline/export_obj.py)
# --------------------------------------------------------------------------- #

def export_one(glb: Path, destination: Path) -> tuple[int, int]:
    """Load a textured GLB and write <stem>.obj (+ .mtl + texture) in its own dir."""
    import trimesh

    destination.parent.mkdir(parents=True, exist_ok=True)
    scene = trimesh.load(str(glb), force="scene")
    mesh = scene.to_geometry() if hasattr(scene, "to_geometry") else scene
    if isinstance(mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate(tuple(mesh.geometry.values()))
    faces = int(len(mesh.faces))
    if faces <= 0:
        raise RuntimeError(f"{glb} produced an empty mesh")
    has_texture = int(getattr(getattr(mesh, "visual", None), "uv", None) is not None)
    mesh.export(str(destination))
    return faces, has_texture
