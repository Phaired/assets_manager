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
  source: "openai" | "manual" | "text"; // "text" = native text-to-3D (mv2, no image)
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

interface DecimateParams {     // on-demand mesh reduction (config "decimate")
  targetFaceNum: number;
  mode: "auto" | "preserve" | "rebake";  // auto = candidate pool, best Hausdorff wins
  qualityThr: number; boundaryWeight: number;
  preserveBoundary: boolean; preserveNormal: boolean;
  optimalPlacement: boolean; planarQuadric: boolean;
  bakeNormalMap: boolean; normalMapResolution: number;  // 1024 | 2048
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
| `create_asset` | `{ project, name, description, tags, backend, kind?, source? }` | `Asset` | unique id via slugify. `source:"text"` → native text-to-3D (forces `kind:"model"`, `backend:"mv2"`). |
| `install_text3d` | `–` | `InstallProgress` | optional add-on: download HunyuanDiT into the HF cache + set `hunyuan.mv2.text3d_enabled`. Needs mv2 installed. |
| `delete_asset` | `{ project, assetId }` | – | also rm asset dir |
| `upload_source` | `{ project, assetId, bytes:number[] }` | `{ source:"manual" }` | normalize→source.png; set asset.source=manual |
| `reset_asset` | `{ project, assetId }` | – | running/queued/error → pending |
| `generate` | `{ project, assetId, stages }` | `JobSnapshot["current"]` | enqueue; marks stages queued |
| `set_asset_decimate` | `{ project, assetId, decimate: Partial<DecimateParams> }` | – | per-asset override (snake_case on disk); empty = clear |
| `decimate_model` | `{ project, assetId, params?: Partial<DecimateParams> }` | `DecimateResult` | direct call (NOT a queue job): re-reduce `model_raw.glb`→`model.glb` via worker `/decimate`. Refused while model3d/export/decimate is queued/running; per-asset lock. Persists result under the `"decimate"` stage key in state.json (not a pipeline stage) and resets `export` to pending. |
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
| `POST /gen3d` | `{ backend:"v21"\|"mv2", baseUrl, seed, gen3d:Gen3d, dest, imagePath?, viewDir?, rawDest?, caption? }` | `{ faces?, textures?, reduced, backend, seed, output, rawOutput?, rawBytes?, note? }` | v21: base64 POST `{baseUrl}/generate`; mv2: gradio_client on `{baseUrl}`. **Inputs (mv2):** `viewDir` (4 views) OR `caption` (native text-to-3D — HunyuanDiT, needs the mv2 server launched with `--enable_t23d`; v21 rejects `caption`). **Texture:** `gen3d.texture=false` → mv2 calls `/shape_generation` (geometry only) instead of `/generation_all`, and the reduction is geometry-only. When `rawDest` is set, the untouched raw GLB is persisted there first. Then mesh-reduce (pymeshlab/trimesh) to `dest`. On reduce failure, copy raw glb and set `reduced:false,note`. |
| `POST /decimate` | `{ raw, dest, params: DecimateParams }` | `{ facesBefore, facesAfter, verticesBefore, verticesAfter, fileSizeBefore, fileSizeAfter, fidelity, hausdorffRmsPct, hausdorffMaxPct, baked, normalMapResolution, uvOverlapPct, method, paramsUsed, candidatesTried, output, note? }` | Re-decimate the raw GLB. `mode:"auto"` runs a candidate pool (texture-preserving variants, free-decimation + xatlas re-unwrap + albedo re-bake, meshoptimizer) and keeps the best one-sided Hausdorff fidelity (reduced→raw, % of bbox diag). `bakeNormalMap`: bakes the raw mesh's normals into a glTF tangent-space normal map laid out in the reduced mesh's atlas (skipped with a `note` when UV overlap > 1%). |
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
  `(caption, None, front, back, left, right, stepsMv2, guidanceScale, seed, octreeResolution, True, numChunks, False)`.
  `caption` (text-to-3D) and the 4 views are mutually exclusive (views are `None`
  in text mode). api_name = `/generation_all` when textured, `/shape_generation`
  when `texture=false`; the mesh path is extracted from the result robustly
  (different tuple positions per endpoint).
- `mesh.py`: `finalize_glb(texture)` → `reduce_textured_glb` (pymeshlab quadric
  edge-collapse with texture, wedge UV corner-duplication for trimesh export) when
  textured, else `reduce_untextured_glb` (geometry-only quadric collapse, no UV);
  fallback = copy raw.
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

## Coherence layer (v0.5) — Project DNA · liens audio · textures · directeur créatif

Added after the audio contract. Four features sharing one goal: every generated
asset (image, 3D, texture, son) stays coherent with the project identity.

### Project DNA
`project.json` gains an optional `dna` object (snake_case on disk):
`{game_description, art_style, palette, ambiance, audio_tone, audio_instrumentation, audio_mood}`.
Bridge type `ProjectDna` (camelCase); `Project` gains `dna?`. Legacy projects
without `dna` keep working — the free-text `style` field remains the fallback, and
`set_project_dna` mirrors `art_style` back into `style` for old builds.

Injection points (all in Rust):
- multiview + texture prompts: `{style}` placeholder receives
  `store.project_style_block()` — "Art direction: … Color palette: … Mood: …"
  composed from the DNA (fallback: legacy `style`).
- `edit_image`: prompt suffixed with `\nStyle: <style_block>`.
- sfx/music generation (`audio_jobs.rs`): text suffixed with
  `. Style: <audio_context>` ("Tone/Instrumentation/Mood" from the DNA). Per-item
  opt-out: `params.useDna == false`. Voice text is NEVER altered.

Command: `set_project_dna {project, dna}`. UI: `ProjectDnaPanel` (sidebar).

### Liens assets ↔ audio
`AudioItem` gains optional `asset_id` (disk snake_case, bridge `assetId`) — n:1,
one source of truth in audio.json. `create_audio_item` accepts `assetId`;
new command `set_audio_item_asset {project, itemId, assetId|null}` links/unlinks.
`delete_asset` unlinks (does not delete) the items pointing at the asset.
UI: `LinkedAudioSection` in AssetDetail (liste + « Générer un son pour cet
asset » + lier un son existant), badge + délier dans AudioItemDetail.

### Textures tileables
`Asset` gains `kind: "model" | "texture"` (disk default "model"). Texture assets
have a SINGLE stage `texture` (state.json key `texture`; `blank_stages_for(kind)`)
that calls OpenAI generations (1024², template `texture_prompt_template`,
placeholders `{subject}`/`{style}`, default `DEFAULT_TEXTURE_TEMPLATE`) and writes
`<asset>/texture.png`. Same budget gate/accounting as multiview;
`prompt_override` applies. `create_asset` accepts `kind` (optional).
UI: kind toggle in NewAssetForm, kind filter chips + kind-aware status dots in the
sidebar (`stagesForKind`), `TexturePreview` (tiling CSS repeat + échelle + export
PNG) in AssetDetail.

### Coût réel OpenAI (usage-based)
Every OpenAI call (images generations/edits + chat completions) now reads the
`usage` block of the response and debits the REAL cost via `add_spend`:
- price table in config `pricing.{text,image}.<model>` (USD per 1M tokens,
  prefix-matched against versioned model names; defaults: gpt-image-2 5/8/30,
  gpt-image-1 5/10/40, gpt-4.1-mini 0.40/1.60).
- helpers `config::image_cost_from_usage` / `config::text_cost_from_usage`;
  unknown model or missing usage → fallback to the flat estimates
  (`estimated_cost_per_image` / `estimated_cost_per_text`), which also remain
  the basis of the PRE-call budget gate.
- stage meta gains `usage`, `cost` (real when possible) and
  `cost_source: "api" | "estimate"`; the StageCard shows the cost of the last
  run, the header keeps showing the cumulated `estimated_spend_usd`.

### Directeur créatif (OpenAI texte)
Module `src-tauri/src/openai_text.rs`: `chat_json` = `/v1/chat/completions` with
strict `json_schema` response format. Config: `openai_text_model`
(default "gpt-4.1-mini"), `estimated_cost_per_text` (default 0.005, debited via
`add_spend` with the same budget gate).

Commands:
- `suggest_prompts {project, assetId?, target:"multiview"|"texture"|"sfx"|"music"}`
  → `string[]` (3 propositions cohérentes avec le DNA).
- `ideate_pack {project, brief}` → `PackAssetIdea[]`
  `{name, description, tags, kind, sounds:[{name,prompt}]}` — the frontend creates
  the checked assets/sounds itself (`createAsset` + `createAudioItem{assetId}`).

UI: `SuggestButton` (NewAssetForm description, LinkedAudioSection, NewAudioForm),
`PackIdeationDialog` (sidebar « Idéation IA », création en masse, option
« lancer la génération »).

## Capabilities / security
- Enable `core:event`, `core:window`, dialog/fs/opener as needed.
- Asset protocol: allow reading from `workspace_dir` so `convertFileSrc` can load
  images and GLB. Scope it to the workspace.
```
