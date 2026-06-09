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

export interface ConfigPublic {
  openaiModel: string;
  openaiQuality: string;
  openaiTimeout: number;
  estimatedCostPerImage: number;
  budgetUsd: number;
  defaultBackend: "v21" | "mv2";
  workspaceDir: string;
  openaiKeySet: boolean;
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
  gen3d?: Partial<Gen3d>;
  hunyuan?: {
    v21?: HunyuanEntryPatch;
    mv2?: HunyuanEntryPatch;
  };
}
