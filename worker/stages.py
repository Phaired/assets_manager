"""Heavy ML stage implementations for the worker sidecar.

The logic here is ported VERBATIM (same parameters, same order) from the
original ``app/pipeline/`` modules:

- ``multiview.py``  : OpenAI 2x2 sheet generation + split/pad.
- ``hunyuan_client.py`` : seed_from_id, generate_v21 payload, generate_mv2 gradio arg order.
- ``mesh.py``       : finalize_glb / reduce_textured_glb.
- ``export_obj.py`` : export_one.

All heavy third-party imports (PIL, httpx, gradio_client, pymeshlab, trimesh,
numpy) are kept LAZY inside the functions so that importing this module — and
therefore ``GET /health`` — stays instant.
"""
from __future__ import annotations

import base64
import hashlib
import json
import shutil
import tempfile
from io import BytesIO
from pathlib import Path

# --------------------------------------------------------------------------- #
# Constants (verbatim from the originals)
# --------------------------------------------------------------------------- #

API_URL = "https://api.openai.com/v1/images/generations"
EDIT_URL = "https://api.openai.com/v1/images/edits"
VIEW_FILES = ("front.png", "back.png", "left.png", "right.png")


# --------------------------------------------------------------------------- #
# Multiview (port of app/pipeline/multiview.py)
# --------------------------------------------------------------------------- #

def prompt_for(name: str, description: str, extra: str = "") -> str:
    """Gabarit de planche multivue (turnaround 2x2). Fidele a l'original."""
    character = description.strip() or name.strip() or "an original stylized game character"
    special = f"\n{extra.strip()}" if extra.strip() else ""
    return f"""Create one production-ready 2x2 orthographic character turnaround sheet for multi-view image-to-3D reconstruction.
CHARACTER: {character}.
{special}
PANEL ORDER: top-left exact front view; top-right exact back view; bottom-left exact left profile; bottom-right exact right profile.
CONSISTENCY: depict the exact same single character in all four panels. Lock identical body proportions, colors, matte materials, accessories and neutral relaxed A-pose. Front and back must match. Left and right profiles must be true mirrored orthographic profiles, not three-quarter views.
FRAMING: show the complete character from highest point to soles in every panel. The character must occupy only about 60 percent of each panel height, centered horizontally and vertically, with at least 15 percent empty background above, below, left and right. Keep a clearly visible gap below the feet. Nothing may touch or cross a panel edge or the sheet midpoint.
STYLE: appealing original stylized game character, simple polished low-poly 3D render, broad readable volumes, a few large flat color regions, very simple matte textures, no tiny details. Keep arms, legs and accessories clearly separated from the torso.
BACKGROUND: perfectly uniform solid light gray in all panels. No floor, horizon, cast shadow, ambient shadow, reflection, gradient, scenery or props.
STRICTLY AVOID: cropping, labels, letters, text, panel borders, extra objects, extra characters, perspective view, three-quarter view, dynamic pose or inconsistent design."""


def request_image(api_key: str, prompt: str, model: str, quality: str, timeout: int) -> bytes:
    """POST /v1/images/generations. Returns the raw PNG bytes of the 2x2 sheet."""
    from urllib.request import Request, urlopen

    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1536x1024",
        "quality": quality,
        "output_format": "png",
    }).encode("utf-8")
    request = Request(
        API_URL,
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        result = json.loads(response.read().decode("utf-8"))
    image = result["data"][0]
    if image.get("b64_json"):
        return base64.b64decode(image["b64_json"])
    if image.get("url"):
        with urlopen(image["url"], timeout=timeout) as response:
            return response.read()
    raise RuntimeError("OpenAI response did not contain b64_json or url")


def edit_image(api_key: str, image_path: Path, prompt: str, model: str, size: str,
               quality: str, timeout: int, mask_path: "Path | None" = None) -> bytes:
    """POST /v1/images/edits (multipart). Returns the edited PNG bytes.

    When ``mask_path`` is given, only its transparent pixels are edited (OpenAI
    inpainting semantics). Used to retouch an asset's source image precisely
    (e.g. recolor one object) before 3D reconstruction.
    """
    import httpx

    files = {"image": ("image.png", Path(image_path).read_bytes(), "image/png")}
    if mask_path is not None:
        files["mask"] = ("mask.png", Path(mask_path).read_bytes(), "image/png")
    data = {
        "model": model,
        "prompt": prompt,
        "n": "1",
        "quality": quality,
    }
    # /images/edits does NOT accept size="auto" (unlike generations). Only send an
    # explicit resolution; otherwise omit it so the API matches the input image.
    if size and size != "auto":
        data["size"] = size
    headers = {"Authorization": f"Bearer {api_key}"}
    with httpx.Client(timeout=timeout) as client:
        response = client.post(EDIT_URL, headers=headers, data=data, files=files)
    if response.status_code != 200:
        raise RuntimeError(f"/images/edits HTTP {response.status_code}: {response.text[:500]}")
    result = response.json()
    image = result["data"][0]
    if image.get("b64_json"):
        return base64.b64decode(image["b64_json"])
    if image.get("url"):
        with httpx.Client(timeout=timeout) as client:
            return client.get(image["url"]).content
    raise RuntimeError("OpenAI edit response did not contain b64_json or url")


def pad_square(image, background=(235, 237, 240)):
    from PIL import Image

    image = image.convert("RGB")
    side = max(image.size)
    canvas = Image.new("RGB", (side, side), background)
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas.resize((1024, 1024), Image.Resampling.LANCZOS)


def split_sheet(sheet_bytes: bytes, output_dir: Path) -> None:
    from PIL import Image

    with Image.open(BytesIO(sheet_bytes)) as source:
        sheet = source.convert("RGB")
    width, height = sheet.size
    mid_x, mid_y = width // 2, height // 2
    boxes = (
        (0, 0, mid_x, mid_y),
        (mid_x, 0, width, mid_y),
        (0, mid_y, mid_x, height),
        (mid_x, mid_y, width, height),
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    sheet.save(output_dir / "sheet.png")
    for filename, box in zip(VIEW_FILES, boxes):
        pad_square(sheet.crop(box)).save(output_dir / filename)


def run_multiview(*, name: str, description: str, output_dir: Path, api_key: str,
                  model: str, quality: str, timeout: int, style: str = "") -> dict:
    """Generate and split the multiview sheet.

    Budget is enforced in Rust BEFORE this is called — the worker just generates.
    Returns the meta dict ``{cost, model, quality, files}``. ``cost`` is computed
    by Rust from config; here we echo back the per-image cost passed implicitly
    through Rust's accounting, so we report nothing about spend and let Rust add
    it. The original returned ``est_cost`` as ``cost`` — Rust supplies that via
    config, so we surface a deterministic ``files`` list.
    """
    prompt = prompt_for(name, description, extra=style)
    image_bytes = request_image(api_key, prompt, model, quality, timeout)
    split_sheet(image_bytes, output_dir)
    return {"model": model, "quality": quality, "files": ["sheet.png", *VIEW_FILES]}


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
