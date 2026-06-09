"""Reduction de faces d'un GLB texture (decimation quadric preservant la texture).

Porte depuis tools/generate_hunyuan_models.py (roblox). Les imports lourds
(pymeshlab/trimesh) sont differes pour ne pas ralentir le demarrage de l'app.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path


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
        visual = TextureVisuals(uv=uv, image=texture)
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
    """Tente la reduction preservant la texture ; sinon copie le GLB brut tel quel.

    Renvoie un meta dict {faces, textures, reduced, note?}.
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
