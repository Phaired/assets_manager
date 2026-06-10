# assets_gen — Tauri migration contract

This is the single source of truth for the Tauri rewrite. Three independent subtrees
implement against it: **Rust core** (`src-tauri/`), **Python worker** (`worker/`),
**React frontend** (`src/`). Keep names/shapes byte-identical to what is written here.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Tauri desktop app                                            │
│                                                              │
│  React + TanStack Router + TanStack Query   (src/)           │
│        │  @tauri-apps/api  invoke() / listen()               │
│        ▼                                                     │
│  Rust core  (src-tauri/)                                     │
│    config · store · jobs(queue) · hunyuan supervisor         │
│    openai (multiview sheet + image edit, pure Rust)          │
│        │  HTTP (reqwest) to 127.0.0.1:<worker_port>          │
│        ▼                                                     │
│  Python worker sidecar (worker/)  — stateless ML ops         │
│    gen3d(Hunyuan v21/mv2 + mesh reduce) · export(OBJ)        │
│                                                              │
│  Rust ALSO spawns the Hunyuan model servers directly         │
│  (separate venvs from config.hunyuan[backend]) and probes    │
│  their /health — the worker only *calls* an already-running  │
│  Hunyuan base_url that Rust passes in.                       │
└────────────────────────────────────────────────────────────┘
```

Rust owns ALL state and orchestration (config, projects/assets/state JSON on disk,
job queue, budget accounting, Hunyuan server lifecycle) AND the OpenAI image calls
(`src-tauri/src/openai.rs`: multiview sheet generation + split, image edits — the
prompt is rendered in Rust from the configurable `multiview_prompt_template`,
placeholders `{subject}`/`{style}`). Python is a pure, stateless compute worker for
the 3D-bound stages only: it receives paths + params, does the heavy ML, writes
output files, returns a small JSON meta. The worker persists nothing.

Workspace layout on disk is UNCHANGED from the original app:
```
<workspace>/<project>/project.json        # {name, created_at, assets:[Asset]}
<workspace>/<project>/state.json          # {version, estimated_spend_usd, assets:{<id>:{<stage>:StageState}}}
<workspace>/<project>/<asset-id>/source.png            # optional manual source
<workspace>/<project>/<asset-id>/multiview/{sheet,front,back,left,right}.png
<workspace>/<project>/<asset-id>/model.glb
<workspace>/<project>/<asset-id>/obj/<asset-id>.obj (+ .mtl + texture)
```
Existing `config.json` and `workspace/` MUST keep working as-is.

## Shared domain types (camelCase over the Tauri bridge)

Rust structs use `#[serde(rename_all = "camelCase")]`. TS mirrors live in
`src/lib/types.ts`. JSON on disk keeps its ORIGINAL snake_case keys (project.json /
state.json / config.json are read/written verbatim for backward compat) — only the
*bridge* payloads are camelCase. Where a disk field is snake_case but the bridge type
is camelCase, Rust maps between them.

```ts
type Backend = "auto" | "v21" | "mv2";
type StageKey = "multiview" | "model3d" | "export";
type StageStatus = "pending" | "queued" | "running" | "done" | "error";

interface Asset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  backend: Backend;
  source: "openai" | "manual";
  createdAt: string;        // disk: created_at
}

interface StageState {
  status: StageStatus;
  updatedAt: string | null; // disk: updated_at
  error: string | null;
  meta: Record<string, unknown>;
}

interface Project {
  name: string;
  createdAt: string;        // disk: created_at
  assets: Asset[];
}

interface ProjectState {
  version: number;
  estimatedSpendUsd: number;                       // disk: estimated_spend_usd
  assets: Record<string, Record<StageKey, StageState>>;
}

interface JobSnapshot {
  current: { id: number; project: string; assetId: string; stages: StageKey[]; state: string } | null;
  queueSize: number;
}

interface ProjectBundle { project: Project; state: ProjectState; jobs: JobSnapshot; }

interface ServerStatus {
  backend: Backend | null;     // "v21" | "mv2" | null
  status: "stopped" | "starting" | "healthy" | "error";
  baseUrl: string | null;
  error: string | null;
  logTail: string;
  managed: boolean;            // true if our spawned subprocess is alive
}

interface Gen3d {
  targetFaceNum: number; octreeResolution: number; numChunks: number;
  guidanceScale: number; texture: boolean;
  stepsV21: number; stepsMv2: number; faceCountV21: number;
}

interface ConfigPublic {       // what get_config returns (no raw key)
  openaiModel: string; openaiQuality: string; openaiTimeout: number;
  estimatedCostPerImage: number; budgetUsd: number;
  defaultBackend: "v21" | "mv2"; workspaceDir: string;
  openaiKeySet: boolean; gen3d: Gen3d;
  hunyuan: { v21: { dir: string; port: number; modelPath: string };
             mv2: { dir: string; port: number; modelPath: string } };
}

interface ConfigPatch {        // update_config input, all optional
  openaiApiKey?: string; openaiModel?: string; openaiQuality?: string;
  openaiTimeout?: number; estimatedCostPerImage?: number; budgetUsd?: number;
  defaultBackend?: "v21" | "mv2"; workspaceDir?: string; gen3d?: Partial<Gen3d>;
}
```

## Tauri commands (Rust `#[tauri::command]`, called via `invoke`)

| command | args | returns | notes |
|---|---|---|---|
| `list_projects` | – | `string[]` | dirs in workspace with project.json |
| `create_project` | `{ name }` | `Project` | slugify name; idempotent |
| `get_project` | `{ name }` | `ProjectBundle` | 404→Err |
| `create_asset` | `{ project, name, description, tags, backend }` | `Asset` | unique id via slugify |
| `delete_asset` | `{ project, assetId }` | – | also rm asset dir |
| `upload_source` | `{ project, assetId, bytes:number[] }` | `{ source:"manual" }` | normalize→source.png; set asset.source=manual |
| `reset_asset` | `{ project, assetId }` | – | running/queued/error → pending |
| `generate` | `{ project, assetId, stages }` | `JobSnapshot["current"]` | enqueue; marks stages queued |
| `get_config` | – | `ConfigPublic` | |
| `update_config` | `{ patch: ConfigPatch }` | `ConfigPublic` | deep-merge gen3d |
| `server_status` | – | `ServerStatus` | |
| `server_start` | `{ backend:"v21"\|"mv2" }` | `ServerStatus` | |
| `server_stop` | – | `ServerStatus` | |
| `asset_file_src` | `{ project, assetId, rel }` | `string` | returns a `convertFileSrc`-ready absolute path for the frontend to load (e.g. `multiview/front.png`, `model.glb`). Frontend wraps with `convertFileSrc`. |

Errors: commands return `Result<T, String>`; the string is a human message (FR ok).

## Tauri events (emitted by Rust, `listen`ed by frontend)

| event | payload | when |
|---|---|---|
| `server-status` | `ServerStatus` | supervisor state changes / poll tick |
| `project-changed` | `{ name: string }` | any stage/asset/state mutation for that project |
| `job-changed` | `JobSnapshot` | enqueue / start / finish |

Frontend reacts by invalidating the matching TanStack Query (no HTTP polling).
Rust SHOULD still emit `server-status` on a low-frequency internal tick so external
Hunyuan starts are noticed.

## Python worker sidecar — HTTP API (FastAPI, 127.0.0.1)

Launched by Rust as a child process:
`<.venv python> -m uvicorn worker.main:app --host 127.0.0.1 --port <port>`.
Rust picks a free port and passes it; worker also accepts `--port`. Rust waits for
`GET /health` → 200 before dispatching jobs. The worker is stateless.

| endpoint | body | returns | does |
|---|---|---|---|
| `GET /health` | – | `{ ok: true }` | readiness |
| `POST /gen3d` | `{ backend:"v21"\|"mv2", baseUrl, seed, gen3d:Gen3d, dest, imagePath?, viewDir? }` | `{ faces?, textures?, reduced, backend, seed, output, note? }` | v21: base64 POST `{baseUrl}/generate`; mv2: gradio_client `/generation_all` on `{baseUrl}`. Then mesh-reduce (pymeshlab/trimesh) to `dest`. On reduce failure, copy raw glb and set `reduced:false,note`. |
| `POST /export` | `{ glb, dest }` | `{ faces, textured }` | trimesh GLB→OBJ(+mtl+texture) in dest's own dir. |

Worker errors: respond with HTTP 4xx/5xx and JSON `{ detail: "<message>" }`; Rust
surfaces `detail` into the stage `error`.

### ML logic to port verbatim from the original `app/pipeline/`
- `multiview.py`: MOVED TO RUST (`src-tauri/src/openai.rs`) — configurable prompt
  template (config `multiview_prompt_template`, `{subject}`/`{style}`), OpenAI
  `/v1/images/generations` (size 1536x1024, output_format png, n=1), `split_sheet`
  (2x2 crop), `pad_square` (center on (235,237,240), 1024² Lanczos).
  VIEW_FILES = front/back/left/right.
- `hunyuan_client.py`: `seed_from_id` (sha256→int%10_000_000), `generate_v21`
  payload keys EXACTLY: image(b64), remove_background, texture, seed, octree_resolution,
  num_inference_steps(=stepsV21), guidance_scale, num_chunks, face_count(=faceCountV21),
  type:"glb"; `generate_mv2` gradio arg ORDER EXACTLY:
  `(None, None, front, back, left, right, stepsMv2, guidanceScale, seed, octreeResolution, True, numChunks, False)` api_name `/generation_all`, result `[1]` is the glb path.
- `mesh.py`: `finalize_glb` → `reduce_textured_glb` (pymeshlab quadric edge-collapse
  with texture, wedge UV corner-duplication for trimesh export); fallback = copy raw.
- `export_obj.py`: `export_one`.

## Stage pipeline orchestration (Rust `jobs`)

Single worker (serial GPU). For each requested stage in order; a failed stage marks
itself `error` and ABORTS the remaining stages of that job.

1. **multiview**: if `asset.source=="manual"` and source.png exists → mark done
   `{source:"manual"}`, skip OpenAI. Else: require OpenAI key (else error). Budget gate:
   `projected = state.estimated_spend_usd + estimatedCostPerImage`; if
   `projected > budgetUsd + 1e-9` → error "budget atteint…". Render the prompt from
   `multiview_prompt_template` (`{subject}` = description|name, `{style}` = project
   style) then call `openai::run_multiview` in-process (outputDir = `<asset>/multiview`).
   On success: `add_spend(est_cost)`, stage done with meta incl. `estimatedSpendUsd`.
2. **model3d**: resolve backend (`auto`→running server else `default_backend`).
   `ensure(backend)` via supervisor (spawn Hunyuan if needed, wait healthy, returns
   base_url). Inputs: v21 → source.png if present else multiview/front.png (error if
   neither); mv2 → require all 4 view files. Call worker `/gen3d` with base_url/seed/
   gen3d/dest=`<asset>/model.glb`. Stage done with returned meta.
3. **export**: require model.glb. Call worker `/export` (dest=`<asset>/obj/<id>.obj`).
   Stage done with meta `{faces, textured, output}`.

State transitions persist to state.json AND emit `project-changed`.

## Hunyuan supervisor (Rust) — port of `server_manager.py`

- One backend at a time (single GPU): starting one stops the other.
- `probe(v21)`: GET `{base}/health`==200. `probe(mv2)`: GET `{base}/gradio_api/info`
  200 AND `/generation_all` in `named_endpoints`.
- `start`: if already probing healthy → adopt; else stop other, spawn
  `[python, script, --host, --port, --model_path, --subfolder, (--texgen_model_path?), *extra_args]`
  with `cwd=dir`, stdout/stderr → `logs/hunyuan_<backend>.log`,
  CREATE_NEW_PROCESS_GROUP on Windows. Monitor thread polls probe until healthy or
  timeout(900s) or process exits → status error.
- `status`: reconcile with reality (probe both even if we didn't spawn) → returns ServerStatus.
- `stop`: terminate (then kill) child; status stopped.
- `ensure(backend, timeout=900)`: healthy→base_url; else start+wait; error→Err.
- On app exit, stop managed child.

## Config (Rust) — port of `config.py`

Defaults identical to original `DEFAULTS`. `load_config` = deep-merge config.json over
defaults. `save_config` writes the full merge atomically. `openai_key` = config key or
`$OPENAI_API_KEY`. `workspace_dir` ensured to exist. config.json keys stay snake_case.

## Frontend (React + TanStack)

- **TanStack Query** for all command data (`projects`, `project/<name>`, `config`,
  `server`). Events invalidate queries — no polling loops.
- **TanStack Router** routes: `/` (project workspace), modal routes or state for
  settings + standalone viewer. Keep it simple — a single workspace screen with
  sidebar (project select + asset list + new-asset form), a detail pane (stage cards,
  multiview gallery, 3D viewer, export info), a Settings dialog, and a standalone 3D
  viewer dialog.
- **3D viewer**: React Three Fiber + drei (`@react-three/fiber`, `@react-three/drei`,
  `three`) GLTF loader with OrbitControls, environment lighting, auto-rotate toggle,
  wireframe toggle, face/vertex count readout, reset-camera, grid/ground. Polished.
  Load local files via `convertFileSrc(asset_file_src(...))`. Also support drag-drop
  of an arbitrary .glb/.gltf (URL.createObjectURL).
- Local image display (multiview thumbnails) also via `convertFileSrc`.
- Preserve original UX features: stage status dots, activity banner (server starting /
  job running / error), prompt presets, budget display, manual source upload, run-all,
  reset, delete, download glb.
- Design: dark, refined, "qualitatif". Use the frontend-design principles — distinctive
  but production-grade, not generic. Strong visual hierarchy, smooth state transitions,
  good empty/loading/error states, accessible.

## Audio domain (ElevenLabs) — added after the 3D contract

Audio generation (sons / voix / musiques) is **all-Rust** (no Python worker): Rust calls
`api.elevenlabs.io` directly via `reqwest::blocking` (`src-tauri/src/elevenlabs.rs`). Voices are
**sur-mesure only** (Voice Design → TTS). Audio lives in the **same projects** as 3D (different
UI tab), per-project on disk; designed voices are a **global** catalog.

Disk: `<workspace>/<project>/audio.json` (manifest) + `<workspace>/<project>/audio/{voice,sfx,music}/<id>.mp3`;
global `<data_root>/voices.json`. The 3D files (project.json/state.json/…) are untouched.

Bridge types (camelCase): `Voice {voiceId,name,description,voiceSettings,createdAt}`,
`VoicePreview {generatedVoiceId,audioBase64}`,
`AudioItem {id,kind:"voice"|"sfx"|"music",name,text,voiceId?,params,status,error,file,createdAt,updatedAt}`,
`AudioBundle {items,jobs:{current,queueSize}}`. Config gains `elevenlabsKeySet` + `audio`
(tts/ttv/sfx/music model + outputFormat); key from config or `$ELEVENLABS_API_KEY`.

Commands: `design_voice`, `create_voice`, `list_voices`, `delete_voice`; `list_audio`,
`create_audio_item`, `generate_audio_item`, `delete_audio_item`; `project_file_src` /
`save_project_file` (project-relative, workspace-confined — for mp3 playback/download).
Generation runs on a dedicated serial executor (`audio_jobs.rs`), independent of the GPU job
queue, and emits `project-changed` (the frontend also invalidates the `["audio", project]`
query). ElevenLabs endpoints: `/text-to-voice/design`, `/text-to-voice`,
`/text-to-speech/{voiceId}`, `/sound-generation`, `/music` (model `music_v1`).

## Capabilities / security
- Enable `core:event`, `core:window`, dialog/fs/opener as needed.
- Asset protocol: allow reading from `workspace_dir` so `convertFileSrc` can load
  images and GLB. Scope it to the workspace.
```
