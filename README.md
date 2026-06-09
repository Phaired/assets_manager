# assets_gen

App web locale qui orchestre une pipeline de génération 3D :

**Description texte → planche multivue (OpenAI gpt-image) → modèle 3D texturé (Hunyuan3D) → export OBJ.**

Tout tourne en local : les modèles Hunyuan3D sur ton GPU, la multivue via l'API OpenAI (clé requise).

## Démarrage

```bat
run.bat
```

Au premier lancement, `run.bat` crée un venv (`.venv`, Python 3.11 via `uv` si dispo), installe les
dépendances et ouvre http://localhost:8799.

Renseigne ta clé OpenAI dans **Réglages** (ou copie `.env.example` → `.env`).

## Concepts

- **Projet** : un dossier de travail dans `workspace/` contenant une liste d'assets.
- **Asset** : `{ nom, description, backend }`. Trois étapes : `multivue`, `3d`, `export`.
- **Backend 3D** :
  - `v21` — Hunyuan3D-2.1 via son serveur FastAPI (`api_server.py`, port 8081), **image unique**
    (utilise la vue *front* ou une image source manuelle).
  - `mv2` — Hunyuan3D-2mv via le serveur Gradio (`gradio_app.py`, port 8080), **4 vues** front/back/left/right.
  - `auto` — utilise le serveur déjà lancé, sinon démarre `default_backend` (config).

L'app **démarre et surveille** elle-même le serveur Hunyuan (sous-process du venv configuré), poll `/health`,
et l'arrête. Configurable dans `config.json` (chemins venv/repo, ports, args modèle).

## Layout des fichiers générés

```
workspace/<projet>/
  project.json                 # assets + métadonnées
  state.json                   # état par asset/étape + budget OpenAI estimé
  <asset-id>/
    source.png                 # image source manuelle (optionnelle)
    multiview/{sheet,front,back,left,right}.png
    model.glb
    obj/<asset-id>.obj (+ .mtl + texture)
```

## Origine

Refactor propre des scripts CLI `C:\dev\roblox\tools\` (`generate_openai_multiview.py`,
`generate_hunyuan_models.py`, `export_obj.py`), décerclé du manifest brainrot et habillé d'une UI.
Voir `config.json` pour pointer vers tes installs Hunyuan (`C:\dev\3dmodel\Hunyuan3D-2.1` / `Hunyuan3D-2`).
