// Shared domain types — mirrors CONTRACT.md "Shared domain types".
// camelCase over the Tauri bridge.

export type Backend = "auto" | "v21" | "mv2";
export type StageKey = "multiview" | "model3d" | "export";
export type StageStatus = "pending" | "queued" | "running" | "done" | "error";

export interface Asset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  backend: Backend;
  source: "openai" | "manual";
  createdAt: string; // disk: created_at
  /** Per-asset 3D generation override (partial). Absent → uses global defaults. */
  gen3d?: Partial<Gen3d>;
}

export interface StageState {
  status: StageStatus;
  updatedAt: string | null; // disk: updated_at
  error: string | null;
  meta: Record<string, unknown>;
}

export interface Project {
  name: string;
  createdAt: string; // disk: created_at
  /** Free-text style applied to every asset's image prompt. */
  style: string;
  assets: Asset[];
}

export interface ProjectState {
  version: number;
  estimatedSpendUsd: number; // disk: estimated_spend_usd
  assets: Record<string, Record<StageKey, StageState>>;
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

export interface HunyuanBackendConfig {
  dir: string;
  python: string;
  port: number;
  modelPath: string;
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
  estimatedCostPerImage: number;
  budgetUsd: number;
  defaultBackend: "v21" | "mv2";
  workspaceDir: string;
  multiviewPromptTemplate: string;
  openaiKeySet: boolean;
  elevenlabsKeySet: boolean;
  audio: AudioConfig;
  gen3d: Gen3d;
  hunyuan: {
    v21: HunyuanBackendConfig;
    mv2: HunyuanBackendConfig;
  };
}

export interface ConfigPatch {
  openaiApiKey?: string;
  openaiModel?: string;
  openaiQuality?: string;
  openaiTimeout?: number;
  estimatedCostPerImage?: number;
  budgetUsd?: number;
  defaultBackend?: "v21" | "mv2";
  workspaceDir?: string;
  multiviewPromptTemplate?: string;
  elevenlabsApiKey?: string;
  audio?: Partial<AudioConfig>;
  gen3d?: Partial<Gen3d>;
  hunyuan?: {
    v21?: HunyuanEntryPatch;
    mv2?: HunyuanEntryPatch;
  };
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
