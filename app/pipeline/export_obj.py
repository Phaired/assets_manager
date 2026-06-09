"""Export GLB -> OBJ (+ MTL + texture). Porte depuis tools/export_obj.py (roblox)."""
from __future__ import annotations

from pathlib import Path


def export_one(glb: Path, destination: Path) -> tuple[int, int]:
    """Charge un GLB texture et ecrit <stem>.obj (+ .mtl + texture) dans son propre dossier.

    trimesh ecrit un material.mtl / material_0.png nomme generiquement a cote de
    chaque .obj, donc chaque modele doit vivre dans son propre dossier.
    """
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
