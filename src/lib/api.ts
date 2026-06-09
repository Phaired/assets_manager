// Typed wrappers over the Tauri bridge: invoke() for every command and
// listen() helpers for the three events. No HTTP polling anywhere.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Asset,
  Backend,
  ConfigPatch,
  ConfigPublic,
  Gen3d,
  JobCurrent,
  JobSnapshot,
  Project,
  ProjectBundle,
  ServerStatus,
  StageKey,
} from "./types";

// --- commands ------------------------------------------------------------

export function listProjects(): Promise<string[]> {
  return invoke<string[]>("list_projects");
}

export function createProject(name: string): Promise<Project> {
  return invoke<Project>("create_project", { name });
}

export function getProject(name: string): Promise<ProjectBundle> {
  return invoke<ProjectBundle>("get_project", { name });
}

export function setProjectStyle(project: string, style: string): Promise<void> {
  return invoke<void>("set_project_style", { project, style });
}

export function createAsset(args: {
  project: string;
  name: string;
  description: string;
  tags: string[];
  backend: Backend;
}): Promise<Asset> {
  return invoke<Asset>("create_asset", args);
}

export function deleteAsset(project: string, assetId: string): Promise<void> {
  return invoke<void>("delete_asset", { project, assetId });
}

export function uploadSource(
  project: string,
  assetId: string,
  bytes: number[],
): Promise<{ source: "manual" }> {
  return invoke<{ source: "manual" }>("upload_source", {
    project,
    assetId,
    bytes,
  });
}

export function resetAsset(project: string, assetId: string): Promise<void> {
  return invoke<void>("reset_asset", { project, assetId });
}

/** Set (or clear, when `gen3d` is empty) the per-asset 3D generation override. */
export function setAssetGen3d(
  project: string,
  assetId: string,
  gen3d: Partial<Gen3d>,
): Promise<void> {
  return invoke<void>("set_asset_gen3d", { project, assetId, gen3d });
}

/** Edit the asset's source image via OpenAI. `maskBytes` (optional) restricts the
 *  edit to the painted (transparent) region. Overwrites source.png. */
export function editImage(
  project: string,
  assetId: string,
  prompt: string,
  maskBytes: number[] | null,
): Promise<{ source: "manual" }> {
  return invoke<{ source: "manual" }>("edit_image", {
    project,
    assetId,
    prompt,
    maskBytes,
  });
}

export function generate(
  project: string,
  assetId: string,
  stages: StageKey[],
): Promise<JobCurrent | null> {
  return invoke<JobCurrent | null>("generate", { project, assetId, stages });
}

export function getConfig(): Promise<ConfigPublic> {
  return invoke<ConfigPublic>("get_config");
}

export function updateConfig(patch: ConfigPatch): Promise<ConfigPublic> {
  return invoke<ConfigPublic>("update_config", { patch });
}

export function serverStatus(): Promise<ServerStatus> {
  return invoke<ServerStatus>("server_status");
}

export function serverStart(backend: "v21" | "mv2"): Promise<ServerStatus> {
  return invoke<ServerStatus>("server_start", { backend });
}

export function serverStop(): Promise<ServerStatus> {
  return invoke<ServerStatus>("server_stop");
}

export function assetFileSrc(
  project: string,
  assetId: string,
  rel: string,
): Promise<string> {
  return invoke<string>("asset_file_src", { project, assetId, rel });
}

/** Copy a workspace-relative asset file to a user-chosen absolute destination. */
export function saveAssetFile(
  project: string,
  assetId: string,
  rel: string,
  dest: string,
): Promise<void> {
  return invoke<void>("save_asset_file", { project, assetId, rel, dest });
}

/** Resolve a workspace-relative asset file to a webview-loadable URL. */
export async function assetFileUrl(
  project: string,
  assetId: string,
  rel: string,
): Promise<string> {
  const abs = await assetFileSrc(project, assetId, rel);
  return convertFileSrc(abs);
}

// --- events --------------------------------------------------------------

export function onServerStatus(
  handler: (s: ServerStatus) => void,
): Promise<UnlistenFn> {
  return listen<ServerStatus>("server-status", (e) => handler(e.payload));
}

export function onProjectChanged(
  handler: (name: string) => void,
): Promise<UnlistenFn> {
  return listen<{ name: string }>("project-changed", (e) =>
    handler(e.payload.name),
  );
}

export function onJobChanged(
  handler: (snap: JobSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<JobSnapshot>("job-changed", (e) => handler(e.payload));
}
