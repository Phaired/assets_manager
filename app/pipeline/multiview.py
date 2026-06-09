"""Generation de la planche multivue via l'API images d'OpenAI.

Porte depuis tools/generate_openai_multiview.py (roblox), generalise : le prompt
prend (nom, description) au lieu de dependre du manifest brainrot.
"""
from __future__ import annotations

import base64
import json
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image

API_URL = "https://api.openai.com/v1/images/generations"
VIEW_FILES = ("front.png", "back.png", "left.png", "right.png")


class BudgetExceeded(RuntimeError):
    pass


def prompt_for(name: str, description: str, extra: str = "") -> str:
    """Gabarit de planche multivue (turnaround 2x2) éprouvé pour la reco image->3D.

    Fidèle à tools/generate_openai_multiview.py. `description` est inséré tel quel ;
    `extra` permet d'ajouter une contrainte de forme ponctuelle (ex. l'ancien cas
    spécial codé en dur), vide par défaut.
    """
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


def pad_square(image: Image.Image, background=(235, 237, 240)) -> Image.Image:
    image = image.convert("RGB")
    side = max(image.size)
    canvas = Image.new("RGB", (side, side), background)
    canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas.resize((1024, 1024), Image.Resampling.LANCZOS)


def split_sheet(sheet_bytes: bytes, output_dir: Path) -> None:
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


def generate_multiview(*, name: str, description: str, output_dir: Path, api_key: str,
                       model: str, quality: str, timeout: int,
                       current_spend: float, budget_usd: float, est_cost: float) -> dict:
    """Genere et decoupe la planche. Leve BudgetExceeded si le budget serait depasse.

    Renvoie un meta dict ; le suivi de depense est gere par l'appelant (store.add_spend).
    """
    projected = current_spend + est_cost
    if projected > budget_usd + 1e-9:
        raise BudgetExceeded(
            f"budget atteint: projete ${projected:.3f} > ${budget_usd:.2f}")
    prompt = prompt_for(name, description)
    image_bytes = request_image(api_key, prompt, model, quality, timeout)
    split_sheet(image_bytes, output_dir)
    return {"cost": est_cost, "model": model, "quality": quality,
            "files": ["sheet.png", *VIEW_FILES]}


# re-exporte pour le bloc except de l'appelant
NETWORK_ERRORS = (HTTPError, URLError, TimeoutError, RuntimeError, ValueError, OSError)
