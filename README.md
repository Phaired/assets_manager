# assets_gen

App desktop locale (**Tauri + React + TanStack**) qui orchestre une pipeline de génération 3D :

**Description texte → planche multivue (OpenAI gpt-image) → modèle 3D texturé (Hunyuan3D) → export OBJ.**

Tout tourne en local : l'orchestration native (Rust), un worker Python d'inférence
(multivue OpenAI, clients Hunyuan, réduction/export mesh), et les modèles Hunyuan3D
sur ton GPU.

## Démarrage

```bat
run.bat
```

Au premier lancement, `run.bat` crée le venv worker (`.venv`, Python 3.11), installe les
dépendances Python (`worker/requirements.txt`) et JS (`pnpm install`), puis ouvre l'app.

Renseigne ta clé OpenAI dans **Réglages** (ou via `$OPENAI_API_KEY` / `.env`).

Pour un exécutable autonome (installeur) : `pnpm tauri build`.

## Architecture

```
React + TanStack Router/Query  (src/)          UI desktop, 3D via React-Three-Fiber
        │  invoke() / listen()  (pont Tauri)
Rust core  (src-tauri/src/)                     état + orchestration (zéro polling HTTP)
  config · store · jobs(file GPU série) · supervisor Hunyuan · client worker
        │  HTTP localhost
Worker Python  (worker/)                        calcul ML sans état
  multivue(OpenAI) · gen3d(Hunyuan v21/mv2 + réduction mesh) · export(OBJ)
```

- **Rust** possède toute la persistance (config.json, `workspace/<projet>/{project,state}.json`),
  la file de jobs (GPU série), le budget OpenAI, et démarre/surveille/arrête les serveurs
  Hunyuan **et** le worker Python. Les changements d'état sont *poussés* à l'UI par events Tauri.
- **Worker Python** est sans état : il reçoit des chemins + paramètres, fait le calcul lourd,
  écrit les fichiers de sortie, renvoie un petit JSON. Lancé en sidecar par Rust.
- Le contrat complet (types, commandes, events, API worker) est dans [`CONTRACT.md`](CONTRACT.md).

## Concepts

- **Projet** : un dossier de travail dans `workspace/` contenant une liste d'assets.
- **Asset** : `{ nom, description, backend }`. Trois étapes : `multivue`, `model3d`, `export`.
- **Backend 3D** :
  - `v21` — Hunyuan3D-2.1 (FastAPI, port 8081), **image unique** (vue *front* ou source manuelle).
  - `mv2` — Hunyuan3D-2mv (Gradio, port 8080), **4 vues** front/back/left/right.
  - `auto` — utilise le serveur déjà lancé, sinon démarre `default_backend` (config).

Configurable dans `config.json` (chemins venv/repo Hunyuan, ports, paramètres modèle).

## Layout des fichiers générés (inchangé)

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

## Migration

Cette app remplace l'ancienne version FastAPI + JS vanilla (préservée dans `legacy/`).
La logique métier (pipeline OpenAI/Hunyuan/mesh) est portée à l'identique ; l'orchestration
et l'UI ont été réécrites en Rust + React.
```
