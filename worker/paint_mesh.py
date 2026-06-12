"""Standalone Hunyuan3D texture-paint pass (assets_gen).

Run by the mv2 venv python with the gradio server STOPPED so neither HunyuanDiT
(t23d) nor the shapegen DiT is resident — leaving the full GPU for the paint
pipeline (delight SD-IP2P + hunyuanpaint multiview UNet, both fp16, cpu-offload).

Loads an untextured GLB + a reference image, bakes a texture, exports a GLB.
HF_HOME / HF_HUB_OFFLINE are set by the spawner so 'tencent/Hunyuan3D-2' resolves
from the centralised cache instead of re-downloading. The reference image must be
background-removed RGBA for a correct texture: recenter_image() passes RGB through
unchanged (no rembg), so an opaque RGB reference bleeds background onto the mesh.
We therefore rembg any non-RGBA / fully-opaque reference here before painting.
"""
import argparse
import os
import sys

import numpy as np
import trimesh
from PIL import Image


def _ensure_rgba_cutout(image: "Image.Image") -> "Image.Image":
    """Return an RGBA image with a real alpha cutout.

    The paint pipeline's recenter_image() only alpha-crops RGBA inputs and passes
    RGB through untouched -> a background-bearing RGB reference produces a bad
    texture. If the image has no usable alpha, run rembg (same lib gradio uses).
    """
    if image.mode == "RGBA":
        alpha = np.array(image)[:, :, 3]
        if alpha.min() < 250:  # already has a cutout
            return image
    try:
        from rembg import remove  # bundled in the mv2 venv (gradio uses it)
        return remove(image.convert("RGBA"))
    except Exception:
        # No rembg available -> best effort: feed RGB through (degraded texture).
        return image.convert("RGB")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--mesh", required=True)          # untextured GLB
    p.add_argument("--image", required=True)         # reference PNG
    p.add_argument("--out", required=True)           # destination textured GLB
    p.add_argument("--texgen-model", default="tencent/Hunyuan3D-2")
    p.add_argument("--backend-dir", default=None)    # mv2 backend dir (hy3dgen lives here)
    p.add_argument("--no-offload", action="store_true")
    a = p.parse_args()

    if a.backend_dir:
        sys.path.insert(0, a.backend_dir)
        # Multiview_Diffusion_Net resolves custom_pipeline relative to the package
        # dir; gradio always runs from the backend dir — match it.
        os.chdir(a.backend_dir)

    # Import AFTER sys.path/chdir so hy3dgen resolves from the backend dir.
    from hy3dgen.texgen import Hunyuan3DPaintPipeline

    paint = Hunyuan3DPaintPipeline.from_pretrained(a.texgen_model)  # turbo subfolder
    if not a.no_offload:
        paint.enable_model_cpu_offload()

    mesh = trimesh.load(a.mesh, force="mesh")    # collapse Scene -> single Trimesh
    image = _ensure_rgba_cutout(Image.open(a.image))

    textured = paint(mesh, image)                # -> NEW trimesh.Trimesh, baked texture
    textured.export(a.out)                        # GLB embeds the TextureVisuals
    print("PAINT_OK " + a.out, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
