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
import os
import shutil
import tempfile
import threading
from pathlib import Path

# pymeshlab is not formally thread-safe and the texture bake relies on a
# process-global chdir; FastAPI runs sync endpoints in a threadpool so /gen3d
# and /decimate can overlap. RLock because helpers nest (decimate_glb ->
# _export_glb -> face_and_texture_count).
_PYMESHLAB_LOCK = threading.RLock()

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


_MESH_EXTS = {".glb", ".gltf", ".obj", ".ply"}


def _extract_mesh_path(result) -> Path:
    """Gradio returns the mesh at different tuple positions depending on the
    endpoint (/generation_all -> result[1]; /shape_generation differs). Scan for
    the first element that resolves to an existing mesh file."""
    candidates = list(result) if isinstance(result, (list, tuple)) else [result]
    for item in candidates:
        try:
            path = _output_path(item)
        except ValueError:
            continue
        if path.suffix.lower() in _MESH_EXTS and path.is_file():
            return path
    # Fallback: best effort on the documented /generation_all position.
    if isinstance(result, (list, tuple)) and len(result) > 1:
        return _output_path(result[1])
    return _output_path(result)


def generate_mv2(base_url: str, view_dir: Path | None, *, seed: int, gen3d: dict,
                 texture: bool = True, caption: str | None = None,
                 timeout: float = 3600.0) -> Path:
    """submit the Hunyuan3D-2mv Gradio endpoint. Returns the GLB path.

    Three modes share the same argument ORDER (verbatim signature:
    ``caption, image, front, back, left, right, steps, guidance_scale, seed,
    octree_resolution, check_box_rembg, num_chunks, randomize_seed``):

    - multivue (``caption is None``): the 4 views condition the shape.
    - text-to-3D (``caption`` set): native HunyuanDiT t2i then shape; needs the
      mv2 server launched with ``--enable_t23d``. The views are omitted.
    - ``texture`` toggles the endpoint: ``/generation_all`` (shape+texture) vs
      ``/shape_generation`` (geometry only, untextured).
    """
    from gradio_client import Client, handle_file

    text_mode = bool(caption and caption.strip())
    if text_mode:
        front = back = left = right = None
    else:
        if view_dir is None:
            raise RuntimeError("view_dir requis pour le mode multivue (sans caption)")
        front = handle_file(str(view_dir / "front.png"))
        back = handle_file(str(view_dir / "back.png"))
        left = handle_file(str(view_dir / "left.png"))
        right = handle_file(str(view_dir / "right.png"))
    args = (
        caption,         # caption (text-to-3D) or None
        None,            # image unique (non utilise ici)
        front, back, left, right,
        gen3d.get("steps_mv2", 50),
        gen3d.get("guidance_scale", 7.5),
        seed,
        gen3d.get("octree_resolution", 256),
        True,            # check_box_rembg
        gen3d.get("num_chunks", 200000),
        False,           # randomize_seed
    )
    client = Client(base_url, verbose=False)
    job = client.submit(*args, api_name="/generation_all" if texture else "/shape_generation")
    result = job.result(timeout=timeout)
    # /generation_all puts the GLB at result[1] (proven). /shape_generation returns
    # a different tuple shape, so scan it for the mesh file.
    if texture:
        return _output_path(result[1])
    return _extract_mesh_path(result)


# --------------------------------------------------------------------------- #
# Mesh reduction (port of app/pipeline/mesh.py)
# --------------------------------------------------------------------------- #

def face_and_texture_count(path: Path) -> tuple[int, int]:
    import pymeshlab
    with _PYMESHLAB_LOCK:
        mesh_set = pymeshlab.MeshSet()
        mesh_set.load_new_mesh(str(path))
        mesh = mesh_set.current_mesh()
        return mesh.face_number(), mesh.texture_number()


def _export_glb(mesh, albedo, destination: Path, temp_dir: Path, normal_map=None) -> tuple[int, int]:
    """Rebuild a GLB from a pymeshlab mesh + PIL albedo (+ optional normal map).

    Single GLB-rebuild path shared by the gen3d reduction and /decimate.
    """
    import numpy as np
    import trimesh
    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    reduced_path = temp_dir / "reduced.glb"
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
        baseColorTexture=albedo,
        baseColorFactor=[255, 255, 255, 255],
        metallicFactor=0.0,
        roughnessFactor=1.0,
        normalTexture=normal_map,
    )
    visual = TextureVisuals(uv=uv, image=albedo, material=material)
    reduced = trimesh.Trimesh(vertices=vertices, faces=faces, visual=visual, process=False)
    reduced.export(reduced_path)
    faces_n, textures_n = face_and_texture_count(reduced_path)
    if faces_n <= 0:
        raise RuntimeError("Reduced GLB contains no faces")
    if textures_n <= 0:
        raise RuntimeError("Reduced GLB lost its texture")
    shutil.copy2(reduced_path, destination)
    return faces_n, textures_n


def reduce_textured_glb(source: Path, destination: Path, target_faces: int) -> tuple[int, int]:
    import pymeshlab
    from PIL import Image

    destination.parent.mkdir(parents=True, exist_ok=True)
    with _PYMESHLAB_LOCK, tempfile.TemporaryDirectory(dir=destination.parent) as temp_dir:
        mesh_set = pymeshlab.MeshSet()
        mesh_set.load_new_mesh(str(source))
        mesh = mesh_set.current_mesh()
        if mesh.texture_number() <= 0 or not mesh.has_wedge_tex_coord():
            raise RuntimeError("Source GLB has no usable texture or wedge UV coordinates")
        # Weld duplicated corner vertices (a no-op on properly indexed meshes):
        # on corner-duplicated GLBs every edge is a topological boundary and the
        # decimation below silently does nothing.
        mesh_set.apply_filter("meshing_remove_duplicate_vertices")
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
        return _export_glb(mesh, texture, destination, Path(temp_dir))


def reduce_untextured_glb(source: Path, destination: Path, target_faces: int) -> tuple[int, int]:
    """Geometry-only quadric decimation for untextured meshes (no UV/material).

    The textured path (``reduce_textured_glb``) requires wedge UVs and a texture;
    on an untextured GLB it would raise and fall back to an undecimated copy.
    This reducer collapses faces without touching texture coordinates and
    re-exports a geometry-only GLB. Returns ``(faces, 0)``.
    """
    import numpy as np
    import pymeshlab
    import trimesh

    destination.parent.mkdir(parents=True, exist_ok=True)
    with _PYMESHLAB_LOCK, tempfile.TemporaryDirectory(dir=destination.parent) as temp_dir:
        mesh_set = pymeshlab.MeshSet()
        mesh_set.load_new_mesh(str(source))
        mesh_set.apply_filter("meshing_remove_duplicate_vertices")
        if mesh_set.current_mesh().face_number() > target_faces:
            mesh_set.apply_filter(
                "meshing_decimation_quadric_edge_collapse",
                targetfacenum=target_faces,
                qualitythr=1.0,
                preserveboundary=True,
                boundaryweight=3,
                preservenormal=True,
            )
        mesh = mesh_set.current_mesh()
        reduced_path = Path(temp_dir) / "reduced.glb"
        reduced = trimesh.Trimesh(
            vertices=np.asarray(mesh.vertex_matrix()),
            faces=np.asarray(mesh.face_matrix()),
            process=False,
        )
        reduced.export(reduced_path)
        faces_n, textures_n = face_and_texture_count(reduced_path)
        if faces_n <= 0:
            raise RuntimeError("Reduced GLB contains no faces")
        shutil.copy2(reduced_path, destination)
        return faces_n, textures_n


def finalize_glb(source: Path, destination: Path, target_faces: int,
                 raw_destination: Path | None = None, *, texture: bool = True) -> dict:
    """Reduce the raw GLB to ``target_faces``; otherwise copy it as-is.

    ``texture=True`` uses texture-preserving reduction; ``texture=False`` uses a
    geometry-only reducer (untextured meshes have no usable wedge UVs).

    When ``raw_destination`` is set, the untouched raw GLB is persisted there
    first so /decimate can re-reduce later without re-generating.

    Returns a meta dict ``{faces, textures, reduced, rawOutput?, rawBytes?, note?}``.
    """
    meta_raw: dict = {}
    if raw_destination is not None:
        raw_destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, raw_destination)
        meta_raw = {
            "rawOutput": str(raw_destination),
            "rawBytes": raw_destination.stat().st_size,
        }
    try:
        if texture:
            faces, textures = reduce_textured_glb(source, destination, target_faces)
        else:
            faces, textures = reduce_untextured_glb(source, destination, target_faces)
        return {"faces": faces, "textures": textures, "reduced": True, **meta_raw}
    except Exception as error:  # noqa: BLE001 - fallback robuste
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        meta = {"reduced": False, "note": f"reduction ignoree: {error!r}", **meta_raw}
        try:
            meta["faces"], meta["textures"] = face_and_texture_count(destination)
        except Exception:  # noqa: BLE001
            pass
        return meta


# --------------------------------------------------------------------------- #
# On-demand decimation (/decimate) — preserve / rebake / meshopt candidates,
# Hausdorff fidelity scoring, tangent-space normal-map baking.
# --------------------------------------------------------------------------- #

# Baked albedo resolution is matched to the source texture, capped here.
_MAX_ALBEDO_RES = 2048
# Texels written by a 2nd triangle with barycentrics above this margin count
# as UV overlap (the margin excludes legitimate shared-edge texels).
_OVERLAP_EPS = 0.02


def _texture_image(mesh, temp_dir: Path, name: str):
    """Extract a pymeshlab mesh texture to a PIL RGBA image (textures only
    exist in-memory on the mesh; the bake filter does NOT write its PNG)."""
    from PIL import Image

    path = temp_dir / name
    mesh.texture(0).save(str(path))
    return Image.open(path).convert("RGBA")


def _weld_copy(ms, raw_idx: int, name: str) -> int:
    """Append a welded copy of mesh ``raw_idx``; returns the new mesh id.

    Our GLB exports duplicate every corner vertex (UV seams), which makes every
    edge a topological boundary and silently disables decimation — welding
    exact-duplicate positions restores connectivity (wedge UVs are preserved).
    """
    ms.add_mesh(ms.mesh(raw_idx), name)
    idx = ms.mesh_number() - 1
    ms.set_current_mesh(idx)
    ms.apply_filter("meshing_remove_duplicate_vertices")
    return idx


def _decimate_preserve(ms, raw_idx: int, target_faces: int, p: dict, quality_thr: float) -> int:
    """Track A: texture-preserving quadric collapse, keeps the Hunyuan atlas."""
    idx = _weld_copy(ms, raw_idx, f"preserve_q{quality_thr}")
    if ms.current_mesh().face_number() > target_faces:
        ms.apply_filter(
            "meshing_decimation_quadric_edge_collapse_with_texture",
            targetfacenum=target_faces,
            qualitythr=quality_thr,
            preserveboundary=bool(p["preserve_boundary"]),
            boundaryweight=float(p["boundary_weight"]),
            optimalplacement=bool(p["optimal_placement"]),
            preservenormal=bool(p["preserve_normal"]),
        )
    return idx


def _decimate_rebake(ms, raw_idx: int, target_faces: int, p: dict, quality_thr: float,
                     temp_dir: Path, albedo_size: tuple[int, int]) -> tuple[int, object]:
    """Track B: UNCONSTRAINED quadric collapse (geometric optimum), then a fresh
    overlap-free xatlas UV atlas and the albedo re-baked from the raw mesh."""
    import numpy as np
    import pymeshlab
    import xatlas

    idx = _weld_copy(ms, raw_idx, f"rebake_q{quality_thr}")
    if ms.current_mesh().face_number() > target_faces:
        ms.apply_filter(
            "meshing_decimation_quadric_edge_collapse",
            targetfacenum=target_faces,
            qualitythr=quality_thr,
            planarquadric=bool(p["planar_quadric"]),
            preserveboundary=bool(p["preserve_boundary"]),
            optimalplacement=bool(p["optimal_placement"]),
            preservenormal=bool(p["preserve_normal"]),
        )
    low = ms.current_mesh()
    vertices = low.vertex_matrix().astype(np.float32)
    faces = low.face_matrix().astype(np.uint32)
    vmapping, indices, uvs = xatlas.parametrize(vertices, faces)
    rebuilt = pymeshlab.Mesh(
        vertex_matrix=vertices[vmapping].astype(np.float64),
        face_matrix=indices.astype(np.int32),
        v_tex_coords_matrix=uvs.astype(np.float64),
    )
    ms.add_mesh(rebuilt, f"rebake_q{quality_thr}_uv")
    new_idx = ms.mesh_number() - 1
    ms.set_current_mesh(new_idx)
    ms.apply_filter("compute_texcoord_transfer_vertex_to_wedge")
    width = min(albedo_size[0], _MAX_ALBEDO_RES)
    height = min(albedo_size[1], _MAX_ALBEDO_RES)
    albedo = _bake_attribute(ms, raw_idx, new_idx, "Texture Color",
                             width, height, temp_dir).convert("RGBA")
    return new_idx, albedo


def _decimate_meshopt(ms, raw_idx: int, target_faces: int) -> int | None:
    """Bonus candidate: meshoptimizer's attribute-aware simplifier (the one in
    gltfpack), seam vertices locked to avoid cracks. Optional — returns None
    if the package is missing."""
    import numpy as np
    import pymeshlab
    try:
        import meshoptimizer
    except ImportError:
        return None

    # The package ships meshopt_simplifyWithAttributes without ctypes argtypes,
    # which breaks float conversion — declare them ourselves (idempotent).
    import ctypes
    from meshoptimizer._loader import lib as _molib
    if getattr(_molib.meshopt_simplifyWithAttributes, "argtypes", None) is None:
        _molib.meshopt_simplifyWithAttributes.argtypes = [
            ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_float), ctypes.c_size_t, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_float), ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_float), ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_ubyte), ctypes.c_size_t, ctypes.c_float,
            ctypes.c_uint, ctypes.POINTER(ctypes.c_float),
        ]
        _molib.meshopt_simplifyWithAttributes.restype = ctypes.c_size_t

    raw = ms.mesh(raw_idx)
    corner_pos = raw.vertex_matrix()[raw.face_matrix().reshape(-1)]
    corner_uv = raw.wedge_tex_coord_matrix().reshape(-1, 2)
    # Weld corners by exact (position, uv) so UVs become per-vertex.
    keyed = np.hstack([corner_pos, corner_uv])
    unique, inverse = np.unique(keyed, axis=0, return_inverse=True)
    positions = np.ascontiguousarray(unique[:, :3], dtype=np.float32)
    uvs = np.ascontiguousarray(unique[:, 3:], dtype=np.float32)
    indices = inverse.astype(np.uint32)

    out = np.zeros(len(indices), dtype=np.uint32)
    count = meshoptimizer.simplify_with_attributes(
        out, indices, positions,
        vertex_attributes=uvs,
        attribute_weights=np.array([0.5, 0.5], dtype=np.float32),
        target_index_count=target_faces * 3,
        target_error=1.0,
        options=meshoptimizer.SIMPLIFY_LOCK_BORDER,
    )
    if count < 9:
        return None
    kept = out[:count]
    used, remapped = np.unique(kept, return_inverse=True)
    mesh = pymeshlab.Mesh(
        vertex_matrix=positions[used].astype(np.float64),
        face_matrix=remapped.reshape(-1, 3).astype(np.int32),
        v_tex_coords_matrix=uvs[used].astype(np.float64),
    )
    ms.add_mesh(mesh, "meshopt")
    idx = ms.mesh_number() - 1
    ms.set_current_mesh(idx)
    ms.apply_filter("compute_texcoord_transfer_vertex_to_wedge")
    return idx


def _fidelity(ms, raw_idx: int, candidate_idx: int, samplenum: int) -> dict:
    """One-sided Hausdorff (reduced -> raw): how far the reduced surface
    strays from the raw one, normalised by the raw bbox diagonal."""
    import pymeshlab

    res = ms.apply_filter(
        "get_hausdorff_distance",
        sampledmesh=candidate_idx,
        targetmesh=raw_idx,
        samplevert=True,
        sampleface=True,
        samplenum=samplenum,
        maxdist=pymeshlab.PercentageValue(10),
    )
    diag = max(res["diag_mesh_0"], res["diag_mesh_1"], 1e-12)
    rms_pct = 100.0 * res["RMS"] / diag
    return {
        "fidelity": round(max(0.0, 100.0 - rms_pct), 2),
        "hausdorffRmsPct": round(rms_pct, 4),
        "hausdorffMaxPct": round(100.0 * res["max"] / diag, 4),
    }


def _bake_attribute(ms, source_idx: int, target_idx: int, attribute: str,
                    width: int, height: int, temp_dir: Path):
    """Run the pymeshlab source->target texture bake and return the baked
    image as PIL. The baked texture only exists in-memory on the target mesh
    (the filter does NOT write its PNG); it is looked up by name because the
    filter may replace texture 0 or append, depending on the mesh's state.
    ``textname`` resolves against the process cwd, hence the chdir (serialised
    by _PYMESHLAB_LOCK, which every caller holds)."""
    import pymeshlab
    from PIL import Image

    bake_name = f"bake_{target_idx}_{attribute.replace(' ', '_').lower()}.png"
    previous = os.getcwd()
    os.chdir(temp_dir)
    try:
        ms.apply_filter(
            "transfer_attributes_to_texture_per_vertex",
            sourcemesh=source_idx,
            targetmesh=target_idx,
            attributeenum=attribute,
            upperbound=pymeshlab.PercentageValue(2),
            textname=bake_name,
            textw=width,
            texth=height,
            overwrite=False,
            pullpush=True,
        )
    finally:
        os.chdir(previous)
    mesh = ms.mesh(target_idx)
    baked = mesh.textures().get(bake_name)
    if baked is None:
        if mesh.texture_number() <= 0:
            raise RuntimeError(f"bake {attribute}: aucune texture produite")
        baked = mesh.texture(mesh.texture_number() - 1)
    out_path = temp_dir / bake_name
    baked.save(str(out_path))
    return Image.open(out_path)


def bake_tangent_normal_map(ms, raw_idx: int, low_idx: int, resolution: int,
                            temp_dir: Path) -> tuple[object, float]:
    """Bake the raw mesh's surface normals into a glTF tangent-space normal
    map laid out in the low mesh's UV atlas.

    pymeshlab can only bake OBJECT-space normals; the tangent-space conversion
    rasterises the low mesh's interpolated TBN frame per texel. Tangents are
    per-vertex Lengyel tangents computed in glTF UV convention (v flipped vs
    pymeshlab) so they match what three.js/Roblox derive at render time —
    trimesh cannot export a TANGENT accessor, so consumers always derive.

    Returns ``(PIL image, uv_overlap_pct)``.
    """
    import numpy as np
    from PIL import Image

    # 1. Object-space bake of the raw normals into the low mesh's atlas.
    ms.set_current_mesh(raw_idx)
    ms.apply_filter("compute_normal_per_vertex")
    os_img = _bake_attribute(ms, raw_idx, low_idx, "Vertex Normal",
                             resolution, resolution, temp_dir).convert("RGB")
    n_os = np.asarray(os_img, dtype=np.float32) / 255.0 * 2.0 - 1.0  # (H,W,3) in [-1,1]

    # 2. Low mesh corner arrays (the exact data _export_glb will ship).
    ms.set_current_mesh(low_idx)
    ms.apply_filter("compute_normal_per_vertex")
    low = ms.current_mesh()
    vertices = low.vertex_matrix()
    faces = low.face_matrix()
    normals = low.vertex_normal_matrix()
    norm_len = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = normals / np.maximum(norm_len, 1e-12)
    uv_pml = low.wedge_tex_coord_matrix().reshape(-1, 3, 2)
    # glTF convention: v flipped vs pymeshlab (trimesh flips on export).
    uv = uv_pml.copy()
    uv[:, :, 1] = 1.0 - uv[:, :, 1]

    # 3. Per-vertex Lengyel tangents (accumulated on shared vertex ids so
    #    island interiors stay smooth), Gram-Schmidt + handedness.
    edge1 = vertices[faces[:, 1]] - vertices[faces[:, 0]]
    edge2 = vertices[faces[:, 2]] - vertices[faces[:, 0]]
    duv1 = uv[:, 1] - uv[:, 0]
    duv2 = uv[:, 2] - uv[:, 0]
    det = duv1[:, 0] * duv2[:, 1] - duv1[:, 1] * duv2[:, 0]
    inv_det = np.where(np.abs(det) < 1e-12, 0.0, 1.0 / np.where(det == 0, 1.0, det))[:, None]
    face_tan = inv_det * (duv2[:, 1:2] * edge1 - duv1[:, 1:2] * edge2)
    face_bit = inv_det * (duv1[:, 0:1] * edge2 - duv2[:, 0:1] * edge1)
    tan_acc = np.zeros_like(vertices)
    bit_acc = np.zeros_like(vertices)
    np.add.at(tan_acc, faces.reshape(-1), np.repeat(face_tan, 3, axis=0))
    np.add.at(bit_acc, faces.reshape(-1), np.repeat(face_bit, 3, axis=0))
    tangents = tan_acc - normals * np.sum(normals * tan_acc, axis=1, keepdims=True)
    tan_len = np.linalg.norm(tangents, axis=1, keepdims=True)
    tangents = np.where(tan_len > 1e-12, tangents / np.maximum(tan_len, 1e-12),
                        _any_perpendicular(normals))
    handed = np.sign(np.sum(np.cross(normals, tangents) * bit_acc, axis=1))
    handed[handed == 0] = 1.0

    # 4. Rasterise the interpolated TBN into UV space (pml pixel convention:
    #    row = (1 - v_pml) * H, identical to the OS map's layout).
    size = resolution
    tan_map = np.zeros((size, size, 3), dtype=np.float64)
    nrm_map = np.zeros((size, size, 3), dtype=np.float64)
    w_map = np.ones((size, size), dtype=np.float64)
    cover = np.zeros((size, size), dtype=np.uint8)
    overlap = np.zeros((size, size), dtype=bool)

    px = uv[:, :, 0] * size - 0.5
    py = uv[:, :, 1] * size - 0.5  # v already flipped -> row from top
    for tri in range(len(faces)):
        xs, ys = px[tri], py[tri]
        x_min = max(int(np.floor(xs.min())), 0)
        x_max = min(int(np.ceil(xs.max())) + 1, size)
        y_min = max(int(np.floor(ys.min())), 0)
        y_max = min(int(np.ceil(ys.max())) + 1, size)
        if x_min >= x_max or y_min >= y_max:
            continue
        gx, gy = np.meshgrid(np.arange(x_min, x_max), np.arange(y_min, y_max))
        denom = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(denom) < 1e-12:
            continue
        b0 = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / denom
        b1 = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / denom
        b2 = 1.0 - b0 - b1
        inside = (b0 >= -1e-6) & (b1 >= -1e-6) & (b2 >= -1e-6)
        if not inside.any():
            continue
        ids = faces[tri]
        rows = gy[inside]
        cols = gx[inside]
        weights = np.stack([b0[inside], b1[inside], b2[inside]], axis=1)
        interior = (weights > _OVERLAP_EPS).all(axis=1)
        overlap[rows[interior], cols[interior]] |= cover[rows[interior], cols[interior]] > 0
        tan_map[rows, cols] = weights @ tangents[ids]
        nrm_map[rows, cols] = weights @ normals[ids]
        w_map[rows, cols] = np.where(weights @ handed[ids] >= 0, 1.0, -1.0)
        cover[rows, cols] = np.minimum(cover[rows, cols] + 1, 255)

    covered = cover > 0
    covered_count = int(covered.sum())
    if covered_count == 0:
        raise RuntimeError("normal-map bake: no texel covered (empty UV atlas?)")
    overlap_pct = round(100.0 * float(overlap.sum()) / covered_count, 3)

    # 5. Per-texel object-space -> tangent-space.
    n_px = nrm_map / np.maximum(np.linalg.norm(nrm_map, axis=2, keepdims=True), 1e-12)
    t_px = tan_map - n_px * np.sum(n_px * tan_map, axis=2, keepdims=True)
    t_px = t_px / np.maximum(np.linalg.norm(t_px, axis=2, keepdims=True), 1e-12)
    b_px = np.cross(n_px, t_px) * w_map[:, :, None]
    n_ts = np.stack([
        np.sum(n_os * t_px, axis=2),
        np.sum(n_os * b_px, axis=2),
        np.sum(n_os * n_px, axis=2),
    ], axis=2)
    # Consistency filter: a baked normal pointing against the low-poly surface
    # normal means the nearest-point search hit the far side of a thin feature
    # (e.g. a leaf) — legitimate detail never flips past 90deg, flatten it.
    n_ts[n_ts[:, :, 2] < 0.0] = (0.0, 0.0, 1.0)
    n_ts = n_ts / np.maximum(np.linalg.norm(n_ts, axis=2, keepdims=True), 1e-12)
    n_ts[:, :, 2] = np.clip(n_ts[:, :, 2], 0.05, 1.0)
    rgb = np.empty((size, size, 3), dtype=np.uint8)
    rgb[:] = (128, 128, 255)  # flat background
    encoded = np.clip((n_ts * 0.5 + 0.5) * 255.0, 0, 255).round().astype(np.uint8)
    rgb[covered] = encoded[covered]

    # 6. Edge padding: dilate valid texels into the background so bilinear
    #    sampling at island borders doesn't bleed flat normals.
    valid = covered.copy()
    for _ in range(8):
        grown = valid.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            shifted = np.roll(valid, (dy, dx), axis=(0, 1))
            src = np.roll(rgb, (dy, dx), axis=(0, 1))
            fill = shifted & ~grown
            rgb[fill] = src[fill]
            grown |= shifted
        if grown.all():
            break
        valid = grown

    return Image.fromarray(rgb, "RGB"), overlap_pct


def _any_perpendicular(normals):
    """Fallback tangent for vertices with degenerate UVs."""
    import numpy as np

    helper = np.where(np.abs(normals[:, 0:1]) < 0.9,
                      np.array([[1.0, 0.0, 0.0]]),
                      np.array([[0.0, 1.0, 0.0]]))
    perp = np.cross(normals, helper)
    return perp / np.maximum(np.linalg.norm(perp, axis=1, keepdims=True), 1e-12)


def decimate_glb(raw: Path, destination: Path, params: dict) -> dict:
    """Re-decimate ``model_raw.glb`` -> ``model.glb`` with tunable parameters.

    ``mode``: ``preserve`` (texture-preserving collapse, Hunyuan atlas kept),
    ``rebake`` (free collapse + fresh xatlas atlas + albedo re-bake), or
    ``auto`` (try a pool of candidates from both tracks + meshoptimizer and
    keep the best Hausdorff fidelity at the target polycount).
    """
    import pymeshlab
    from PIL import Image

    target_faces = int(params["target_face_num"])
    mode = str(params.get("mode", "auto"))
    quality_thr = float(params.get("quality_thr", 1.0))

    destination.parent.mkdir(parents=True, exist_ok=True)
    size_before = raw.stat().st_size

    with _PYMESHLAB_LOCK, tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        temp_dir = Path(temp)
        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(str(raw))
        raw_mesh = ms.current_mesh()
        faces_before = raw_mesh.face_number()
        verts_before = raw_mesh.vertex_number()
        if raw_mesh.texture_number() <= 0 or not raw_mesh.has_wedge_tex_coord():
            # Geometry-only mesh (texture=false): quadric collapse, no UV / albedo /
            # rebake — those are impossible without a texture. Runs BEFORE the
            # candidate pool so a stale rebake override can never reach it.
            import numpy as np
            import trimesh
            ms.apply_filter("meshing_remove_duplicate_vertices")
            if ms.current_mesh().face_number() > target_faces:
                ms.apply_filter(
                    "meshing_decimation_quadric_edge_collapse",
                    targetfacenum=target_faces,
                    qualitythr=quality_thr,
                    preserveboundary=bool(params.get("preserve_boundary", True)),
                    boundaryweight=3,
                    preservenormal=bool(params.get("preserve_normal", True)),
                )
            out_mesh = ms.current_mesh()
            reduced_path = temp_dir / "reduced_geom.glb"
            trimesh.Trimesh(
                vertices=np.asarray(out_mesh.vertex_matrix()),
                faces=np.asarray(out_mesh.face_matrix()),
                process=False,
            ).export(reduced_path)
            faces_after, _tex = face_and_texture_count(reduced_path)
            if faces_after <= 0:
                raise RuntimeError("Reduced GLB contains no faces")
            shutil.copy2(reduced_path, destination)
            return {
                "facesBefore": faces_before,
                "facesAfter": faces_after,
                "verticesBefore": verts_before,
                "verticesAfter": int(out_mesh.vertex_number()),
                "fileSizeBefore": size_before,
                "fileSizeAfter": destination.stat().st_size,
                "fidelity": 100.0,
                "hausdorffRmsPct": 0.0,
                "hausdorffMaxPct": 0.0,
                "baked": False,
                "normalMapResolution": 0,
                "uvOverlapPct": 0.0,
                "method": "preserve",
                "paramsUsed": {"qualityThr": quality_thr, "geometryOnly": True},
                "candidatesTried": [],
                "output": str(destination),
                "note": "géométrie seule (modèle sans texture)",
            }
        # Weld the reference too: corner-duplicated vertices (our own GLB
        # export format) only belong to 1-2 faces, which makes their "vertex
        # normals" near-faceted and ruins the normal-map bake source.
        ms.apply_filter("meshing_remove_duplicate_vertices")
        raw_albedo = _texture_image(raw_mesh, temp_dir, "raw_albedo.png")

        # ---- candidate pool -------------------------------------------------
        candidates: list[dict] = []

        def _try(method: str, build) -> None:
            try:
                built = build()
            except Exception as error:  # noqa: BLE001 - candidate jetable
                candidates.append({"method": method, "error": _short(error)})
                return
            if built is None:
                return
            idx, albedo, used = built
            candidates.append({"method": method, "idx": idx, "albedo": albedo,
                               "paramsUsed": used})

        if mode == "preserve":
            quality_pool = [quality_thr]
        elif mode == "rebake":
            quality_pool = []
        else:
            quality_pool = [1.0, 0.6, 0.3]
        for qt in quality_pool:
            _try("preserve", lambda qt=qt: (
                _decimate_preserve(ms, 0, target_faces, params, qt),
                raw_albedo, {"qualityThr": qt}))

        if mode == "rebake":
            rebake_pool = [quality_thr]
        elif mode == "auto":
            rebake_pool = [0.7, 0.3]
        else:
            rebake_pool = []
        for qt in rebake_pool:
            _try("rebake", lambda qt=qt: (
                *_decimate_rebake(ms, 0, target_faces, params, qt, temp_dir,
                                  raw_albedo.size),
                {"qualityThr": qt}))

        if mode == "auto":
            _try("meshopt", lambda: _maybe_meshopt(ms, 0, target_faces, raw_albedo))

        scored = [c for c in candidates if "idx" in c]
        if not scored:
            details = "; ".join(f"{c['method']}: {c.get('error', '?')}" for c in candidates)
            raise RuntimeError(f"aucun candidat de reduction n'a abouti ({details})")

        # ---- scoring --------------------------------------------------------
        prescreen = 15_000 if len(scored) > 1 else 50_000
        for cand in scored:
            cand.update(_fidelity(ms, 0, cand["idx"], prescreen))
            cand["faces"] = ms.mesh(cand["idx"]).face_number()

        method_rank = {"preserve": 0, "meshopt": 1, "rebake": 2}
        winner = max(scored, key=lambda c: (
            c["fidelity"],
            -abs(c["faces"] - target_faces),
            -method_rank.get(c["method"], 9),
        ))
        if len(scored) > 1:
            winner.update(_fidelity(ms, 0, winner["idx"], 50_000))

        # ---- normal-map bake ------------------------------------------------
        normal_map = None
        baked = False
        overlap_pct = 0.0
        bake_note = None
        if bool(params.get("bake_normal_map", True)):
            resolution = min(int(params.get("normal_map_resolution", 1024)), 2048)
            normal_map, overlap_pct = bake_tangent_normal_map(
                ms, 0, winner["idx"], resolution, temp_dir)
            if overlap_pct > 1.0:
                bake_note = (f"normal map ignoree: {overlap_pct}% de texels UV "
                             "en chevauchement (atlas replie par la decimation)")
                normal_map = None
            else:
                baked = True

        # ---- export ---------------------------------------------------------
        win_mesh = ms.mesh(winner["idx"])
        faces_after, _textures = _export_glb(
            win_mesh, winner["albedo"], destination, temp_dir, normal_map)

        meta = {
            "facesBefore": faces_before,
            "facesAfter": faces_after,
            "verticesBefore": verts_before,
            "verticesAfter": win_mesh.vertex_number(),
            "fileSizeBefore": size_before,
            "fileSizeAfter": destination.stat().st_size,
            "fidelity": winner["fidelity"],
            "hausdorffRmsPct": winner["hausdorffRmsPct"],
            "hausdorffMaxPct": winner["hausdorffMaxPct"],
            "baked": baked,
            "normalMapResolution": int(params.get("normal_map_resolution", 1024)) if baked else 0,
            "uvOverlapPct": overlap_pct,
            "method": winner["method"],
            "paramsUsed": winner["paramsUsed"],
            "candidatesTried": [
                {key: c[key] for key in ("method", "fidelity", "faces", "error")
                 if key in c}
                for c in candidates
            ],
            "output": str(destination),
        }
        if bake_note:
            meta["note"] = bake_note
        return meta


def _maybe_meshopt(ms, raw_idx: int, target_faces: int, raw_albedo):
    idx = _decimate_meshopt(ms, raw_idx, target_faces)
    if idx is None:
        return None
    return idx, raw_albedo, {}


def _short(error: Exception) -> str:
    text = str(error).strip()
    return (text or type(error).__name__)[:200]


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
