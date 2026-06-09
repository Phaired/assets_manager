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

## Distribution (installeur autonome, sans Python côté utilisateur)

L'installeur **embarque le worker Python gelé** : le PC cible n'a besoin ni de
Python, ni de venv, ni de `run.bat`. Deux étapes :

```bat
build-worker.bat        REM gèle le worker -> worker_dist\worker\worker.exe (PyInstaller)
pnpm tauri build        REM construit l'app + embarque worker_dist\worker comme ressource
```

`build-worker.bat` doit être relancé quand le code du `worker/` change. L'app
installée résout ses chemins au runtime :

- **données inscriptibles** (`config.json`, `workspace/`, `logs/`) → dossier
  utilisateur `%APPDATA%\com.assetsgen.app\` (et non le dossier d'install).
- **worker gelé** → ressources de l'app, à côté de l'exécutable.

En dev (`pnpm tauri dev`), rien ne change : `config.json`/`workspace`/`logs`
restent dans le repo et le worker tourne depuis `.venv` (fallback automatique si
le worker gelé est absent).

> ⚠️ Le `config.json` du repo (qui peut contenir ta clé OpenAI) n'est **jamais**
> embarqué : il est git-ignoré et l'app installée part d'une config propre.

## Prérequis Hunyuan (génération 3D locale)

Les serveurs Hunyuan3D sont des projets **PyTorch + CUDA externes** (multi-Go) —
ils ne sont pas embarqués. Sur la machine de génération :

1. Cloner les repos Hunyuan3D (2.1 et/ou 2mv) et créer leur venv respectif.
2. Dans **Réglages → Backends 3D (Hunyuan)**, pointer chaque backend vers son
   **dossier de repo** et le **python de son venv** (boutons *Parcourir*), régler
   le port.
3. Démarrer le serveur depuis **Réglages → Serveur Hunyuan**.

Si un chemin manque ou est invalide, l'app affiche un message clair plutôt que
d'échouer silencieusement.

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
