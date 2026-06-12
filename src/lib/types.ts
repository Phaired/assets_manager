// Shared domain types — mirrors CONTRACT.md "Shared domain types".
// camelCase over the Tauri bridge.

export type Backend = "auto" | "v21" | "mv2";
export type StageKey = "multiview" | "model3d" | "export" | "texture";
/** Pipeline stages plus on-demand state keys persisted in state.json
 *  ("decimate" is not a pipeline stage — no StageCard — but survives restarts). */
export type ExtraStageKey = StageKey | "decimate" | "paint3d";
export type StageStatus = "pending" | "queued" | "running" | "done" | "error";
/** "model" = image → multivue → 3D ; "texture" = image seamless tileable. */
export type AssetKind = "model" | "texture";

export interface Asset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Defaults to "model" on legacy assets. */
  kind: AssetKind;
  backend: Backend;
  /** "openai" = generated multiview, "manual" = uploaded image,
   *  "text" = native text-to-3D (mv2 + HunyuanDiT, no image). */
  source: "openai" | "manual" | "text";
  createdAt: string; // disk: created_at
  /** Per-asset 3D generation override (partial). Absent → uses global defaults. */
  gen3d?: Partial<Gen3d>;
  /** Per-asset decimation override (partial). Absent → uses global defaults. */
  decimate?: Partial<DecimateParams>;
  /** Per-asset 3D seed override. Absent → derived from the asset id. */
  seed?: number;
  /** Per-asset multiview prompt override. Absent → uses the global template. */
  promptOverride?: string;
}

export interface StageState {
  status: StageStatus;
  updatedAt: string | null; // disk: updated_at
  error: string | null;
  meta: Record<string, unknown>;
}

/** Project identity sheet ("DNA") injected into every generation pipeline. */
export interface ProjectDna {
  /** What the game / experience is about (used by the LLM director). */
  gameDescription: string;
  /** Visual style (e.g. "low-poly, couleurs plates"). */
  artStyle: string;
  /** Color palette. */
  palette: string;
  /** Visual mood / ambiance. */
  ambiance: string;
  /** Audio tone. */
  audioTone: string;
  /** Instrumentation. */
  audioInstrumentation: string;
  /** Audio mood. */
  audioMood: string;
}

export interface Project {
  name: string;
  createdAt: string; // disk: created_at
  /** Free-text style applied to every asset's image prompt. Legacy fallback /
   *  mirror of `dna.artStyle`. */
  style: string;
  /** Rich project identity (absent on legacy projects). */
  dna?: ProjectDna;
  assets: Asset[];
}

export interface ProjectState {
  version: number;
  estimatedSpendUsd: number; // disk: estimated_spend_usd
  assets: Record<string, Partial<Record<ExtraStageKey, StageState>>>;
}

export interface JobCurrent {
  id: number;
  project: string;
  assetId: string;
  stages: StageKey[];
  state: string;
}

export interface JobSnapshot {
  current: JobCurrent | null;
  queueSize: number;
}

export interface ProjectBundle {
  project: Project;
  state: ProjectState;
  jobs: JobSnapshot;
}

export interface ServerStatus {
  backend: Backend | null; // "v21" | "mv2" | null
  status: "stopped" | "starting" | "healthy" | "error";
  baseUrl: string | null;
  error: string | null;
  logTail: string;
  managed: boolean; // true if our spawned subprocess is alive
}

/** Phase keys emitted by the guided Hunyuan installer (Rust `installer.rs`). */
export type InstallPhase =
  | "idle"
  | "preflight"
  | "python"
  | "code"
  | "venv"
  | "torch"
  | "deps"
  | "extensions"
  | "weights"
  | "config"
  | "start"
  | "done";

export interface InstallProgress {
  backend: "v21" | "mv2" | null;
  running: boolean;
  phase: InstallPhase;
  pct: number; // 0..100
  message: string;
  logTail: string;
  done: boolean;
  error: string | null;
}

export interface Gen3d {
  targetFaceNum: number;
  octreeResolution: number;
  numChunks: number;
  guidanceScale: number;
  texture: boolean;
  stepsV21: number;
  stepsMv2: number;
  faceCountV21: number;
}

/** Méthode de réduction : auto = pool de candidats départagés par fidélité. */
export type DecimateMode = "auto" | "preserve" | "rebake";

export interface DecimateParams {
  targetFaceNum: number;
  mode: DecimateMode;
  qualityThr: number;
  boundaryWeight: number;
  preserveBoundary: boolean;
  preserveNormal: boolean;
  optimalPlacement: boolean;
  planarQuadric: boolean;
  bakeNormalMap: boolean;
  normalMapResolution: number; // 1024 | 2048
}

/** One candidate tried by the auto mode (for the result details). */
export interface DecimateCandidate {
  method: "preserve" | "rebake" | "meshopt";
  fidelity?: number;
  faces?: number;
  error?: string;
}

/** /decimate response — also persisted as the "decimate" stage meta. */
export interface DecimateResult {
  facesBefore: number;
  facesAfter: number;
  verticesBefore: number;
  verticesAfter: number;
  fileSizeBefore: number;
  fileSizeAfter: number;
  /** 100 − RMS Hausdorff (% de la diagonale bbox du brut). */
  fidelity: number;
  hausdorffRmsPct: number;
  hausdorffMaxPct: number;
  baked: boolean;
  normalMapResolution: number;
  uvOverlapPct: number;
  method: "preserve" | "rebake" | "meshopt";
  paramsUsed: Record<string, unknown>;
  candidatesTried: DecimateCandidate[];
  output: string;
  note?: string;
}

export interface HunyuanBackendConfig {
  dir: string;
  python: string;
  port: number;
  modelPath: string;
  /** mv2 only: native text-to-3D (HunyuanDiT) installed & enabled. */
  text3dEnabled: boolean;
}

export interface HunyuanEntryPatch {
  dir?: string;
  python?: string;
  port?: number;
  modelPath?: string;
  subfolder?: string;
  texgenModelPath?: string;
  extraArgs?: string[];
}

export interface AudioConfig {
  ttsModel: string;
  ttvModel: string;
  sfxModel: string;
  musicModel: string;
  outputFormat: string;
}

export interface ConfigPublic {
  openaiModel: string;
  openaiQuality: string;
  openaiTimeout: number;
  openaiTextModel: string;
  estimatedCostPerImage: number;
  estimatedCostPerText: number;
  budgetUsd: number;
  defaultBackend: "v21" | "mv2";
  workspaceDir: string;
  multiviewPromptTemplate: string;
  texturePromptTemplate: string;
  openaiKeySet: boolean;
  openaiAdminKeySet: boolean;
  elevenlabsKeySet: boolean;
  audio: AudioConfig;
  gen3d: Gen3d;
  decimate: DecimateParams;
  hunyuan: {
    v21: HunyuanBackendConfig;
    mv2: HunyuanBackendConfig;
  };
}

export interface ConfigPatch {
  openaiApiKey?: string;
  openaiAdminApiKey?: string;
  openaiModel?: string;
  openaiQuality?: string;
  openaiTimeout?: number;
  openaiTextModel?: string;
  estimatedCostPerImage?: number;
  estimatedCostPerText?: number;
  budgetUsd?: number;
  defaultBackend?: "v21" | "mv2";
  workspaceDir?: string;
  multiviewPromptTemplate?: string;
  texturePromptTemplate?: string;
  elevenlabsApiKey?: string;
  audio?: Partial<AudioConfig>;
  gen3d?: Partial<Gen3d>;
  decimate?: Partial<DecimateParams>;
  hunyuan?: {
    v21?: HunyuanEntryPatch;
    mv2?: HunyuanEntryPatch;
  };
}

// --- OpenAI org costs (admin key) ------------------------------------------

/** One daily billed-cost bucket (Unix seconds, USD). */
export interface CostDay {
  startTime: number;
  endTime: number;
  amountUsd: number;
}

/** Real billed costs of the whole OpenAI organization. */
export interface CostsSummary {
  totalUsd: number;
  days: CostDay[];
}

// --- Creative director (OpenAI text) --------------------------------------

/** Modalities the director can write prompts for. */
export type SuggestTarget = "multiview" | "texture" | "sfx" | "music";

/** Suggested sound of a pack idea. */
export interface PackSoundIdea {
  name: string;
  prompt: string;
}

/** One asset proposed by the pack ideation. */
export interface PackAssetIdea {
  name: string;
  description: string;
  tags: string[];
  kind: AssetKind;
  sounds: PackSoundIdea[];
}

// --- Audio domain (ElevenLabs) ------------------------------------------

export type AudioKind = "voice" | "sfx" | "music";
export type AudioStatus = "pending" | "queued" | "running" | "done" | "error";

/** A reusable designed voice (global catalog). */
export interface Voice {
  voiceId: string;
  name: string;
  description: string;
  voiceSettings: Record<string, number>;
  createdAt: string;
}

/** A Voice Design preview (played via a base64 data URL). */
export interface VoicePreview {
  generatedVoiceId: string;
  audioBase64: string;
}

/** A per-project audio item. */
export interface AudioItem {
  id: string;
  kind: AudioKind;
  name: string;
  text: string;
  voiceId?: string;
  /** Id of the 3D/texture asset this item is linked to (absent when standalone). */
  assetId?: string;
  params: Record<string, unknown>;
  status: AudioStatus;
  error: string | null;
  /** Project-relative mp3 path (e.g. "audio/sfx/<id>.mp3"). */
  file: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface AudioJobCurrent {
  project: string;
  itemId: string;
}

export interface AudioJobSnapshot {
  current: AudioJobCurrent | null;
  queueSize: number;
}

export interface AudioBundle {
  items: AudioItem[];
  jobs: AudioJobSnapshot;
}
