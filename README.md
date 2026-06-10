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
Python, ni de venv, ni de `run.bat`. En une commande :

```bat
build-release.bat           REM vendorise uv + gèle le worker + construit l'installeur
```

…ou les trois étapes à la main :

```bat
powershell -ExecutionPolicy Bypass -File scripts\fetch-uv.ps1   REM vendorise uv.exe (vendor\uv\uv.exe) — 1 fois par machine de build
build-worker.bat            REM gèle le worker -> worker_dist\worker\worker.exe (PyInstaller)
pnpm tauri build            REM construit l'app + embarque worker_dist\worker et uv.exe comme ressources
```

`vendor/` est git-ignoré (uv.exe ≈ 65 Mo) : `fetch-uv.ps1` le récupère depuis les
releases Astral. uv est embarqué pour l'**installeur Hunyuan guidé** (ci-dessous).

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

## Génération 3D locale (Hunyuan) — installeur guidé

Le moteur Hunyuan3D (PyTorch + CUDA, plusieurs Go) **s'installe depuis l'app**,
sans terminal. Au premier lancement, un bandeau propose **« Configurer la
génération 3D »** ; sinon **Réglages → Backends 3D → Installer automatiquement**.

**Seul prérequis utilisateur : un GPU NVIDIA + un driver récent.** Pas de Python,
pas de git, pas de CUDA Toolkit, pas de compilateur : l'installeur guidé
(`src-tauri/src/installer.rs`) orchestre tout via l'`uv` embarqué —

1. provisionne Python (uv), 2. télécharge le code Hunyuan (zipball épinglé),
3. crée le venv, 4. installe **torch CUDA** (wheels officiels, le runtime CUDA est
dans le wheel), 5. installe les dépendances, 6. installe les **2 wheels
d'extensions CUDA** pré-compilées, 7. télécharge les **poids** (HuggingFace),
8. écrit la config et **démarre le serveur**. Idempotent, annulable, avec barre
de progression et journal.

Backend cible actuel : **mv2** (Hunyuan3D-2mv, 4 vues). La saisie manuelle des
chemins reste possible sous **Réglages → Backends 3D → Avancé**.

**Tout est centralisé dans un seul dossier** (Python géré par uv, cache uv, poids
HuggingFace, venv + code Hunyuan) :
`%LOCALAPPDATA%\com.assetsgen.app\hunyuan\` en app installée
(`<repo>\hunyuan\` en dev). Désinstaller la partie 3D = supprimer ce dossier. Le
serveur est lancé avec `HF_HOME` sur ce dossier, donc il lit les poids au même
endroit que l'installeur les a écrits.

### Préparer les artefacts (dev, une fois par version)

Tout est tiré d'index publics SAUF les 2 extensions CUDA, introuvables ailleurs.
Tu les compiles **une fois** et les héberges sur les **GitHub Releases** de l'app :

```bat
pwsh scripts\build-extension-wheels.ps1 -RepoZipRef <commit-sha>
```

Prérequis de cette machine de build (pas des utilisateurs) : VS 2022 Build Tools
(MSVC C++) + CUDA Toolkit 12.4+ (12.6 OK). Le script sort 2 `.whl` + leur sha256 ;
uploade-les sur la Release, puis renseigne leurs URLs/sha dans `Recipe::ext_wheels`
(et le commit dans `Recipe.repo_zip_url`) — voir `src-tauri/src/installer.rs`. Le
tuple est figé : **Python 3.10 + torch 2.5.1 + cu124 + win-amd64** ; tout
changement de version ⇒ recompiler les wheels.

> Pour le tuple par défaut, les wheels sont **déjà publiées** sur la release
> [`hunyuan-mv2-cu124-py310-v1`](https://github.com/Phaired/assets_manager/releases/tag/hunyuan-mv2-cu124-py310-v1)
> et déjà câblées dans `RECIPE_MV2` — tu n'as rien à refaire sauf si tu changes
> de version torch/CUDA/Python.

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
