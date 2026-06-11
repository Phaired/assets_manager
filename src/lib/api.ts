// Typed wrappers over the Tauri bridge: invoke() for every command and
// listen() helpers for the three events. No HTTP polling anywhere.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Asset,
  AssetKind,
  AudioBundle,
  AudioItem,
  AudioKind,
  Backend,
  ConfigPatch,
  ConfigPublic,
  CostsSummary,
  Gen3d,
  InstallProgress,
  JobCurrent,
  JobSnapshot,
  PackAssetIdea,
  Project,
  ProjectBundle,
  ProjectDna,
  ServerStatus,
  StageKey,
  SuggestTarget,
  Voice,
  VoicePreview,
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

/** Persist the project DNA (identity sheet injected into every pipeline). */
export function setProjectDna(
  project: string,
  dna: ProjectDna,
): Promise<void> {
  return invoke<void>("set_project_dna", { project, dna });
}

export function createAsset(args: {
  project: string;
  name: string;
  description: string;
  tags: string[];
  backend: Backend;
  kind?: AssetKind;
}): Promise<Asset> {
  return invoke<Asset>("create_asset", args);
}

/** Update mutable asset fields after creation (currently the 3D backend). */
export function updateAsset(
  project: string,
  assetId: string,
  backend: Backend,
): Promise<void> {
  return invoke<void>("update_asset", { project, assetId, backend });
}

/** Rename an asset's display name (id/slug and disk paths stay unchanged). */
export function renameAsset(
  project: string,
  assetId: string,
  name: string,
): Promise<void> {
  return invoke<void>("rename_asset", { project, assetId, name });
}

/** Replace an asset's tags. */
export function setAssetTags(
  project: string,
  assetId: string,
  tags: string[],
): Promise<void> {
  return invoke<void>("set_asset_tags", { project, assetId, tags });
}

/** Set (or clear, when `seed` is null) the per-asset 3D seed override. */
export function setAssetSeed(
  project: string,
  assetId: string,
  seed: number | null,
): Promise<void> {
  return invoke<void>("set_asset_seed", { project, assetId, seed });
}

/** Set (or clear, when empty) the per-asset multiview prompt override. */
export function setAssetPrompt(
  project: string,
  assetId: string,
  prompt: string,
): Promise<void> {
  return invoke<void>("set_asset_prompt", { project, assetId, prompt });
}

/** Duplicate an asset's configuration (no generated files copied). */
export function duplicateAsset(
  project: string,
  assetId: string,
): Promise<Asset> {
  return invoke<Asset>("duplicate_asset", { project, assetId });
}

export function deleteAsset(project: string, assetId: string): Promise<void> {
  return invoke<void>("delete_asset", { project, assetId });
}

/** Write raw bytes (e.g. a viewer screenshot) to a user-chosen absolute path. */
export function saveRender(dest: string, bytes: number[]): Promise<void> {
  return invoke<void>("save_render", { dest, bytes });
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

/** Creative director: 3 suggested prompts for one modality, from the DNA. */
export function suggestPrompts(
  project: string,
  assetId: string | null,
  target: SuggestTarget,
): Promise<string[]> {
  return invoke<string[]>("suggest_prompts", { project, assetId, target });
}

/** Creative director: ideate a whole asset pack from the DNA + a brief. */
export function ideatePack(
  project: string,
  brief: string,
): Promise<PackAssetIdea[]> {
  return invoke<PackAssetIdea[]>("ideate_pack", { project, brief });
}

export function getConfig(): Promise<ConfigPublic> {
  return invoke<ConfigPublic>("get_config");
}

/** Real billed costs of the OpenAI org over the last `days` days (admin key). */
export function openaiCosts(days?: number): Promise<CostsSummary> {
  return invoke<CostsSummary>("openai_costs", { days });
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

/** Start the guided install of a heavy Hunyuan backend (currently `mv2`). Runs in
 *  the background; progress streams via the `install-progress` event. */
export function installBackend(
  backend: "v21" | "mv2",
): Promise<InstallProgress> {
  return invoke<InstallProgress>("install_backend", { backend });
}

export function installStatus(): Promise<InstallProgress> {
  return invoke<InstallProgress>("install_status");
}

export function cancelInstall(): Promise<InstallProgress> {
  return invoke<InstallProgress>("cancel_install");
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

// --- audio: voices (global catalog) --------------------------------------

/** Voice Design: returns preview voices to listen to and pick from. */
export function designVoice(args: {
  description: string;
  previewText: string;
  seed?: number;
  guidanceScale?: number;
}): Promise<VoicePreview[]> {
  return invoke<VoicePreview[]>("design_voice", args);
}

/** Save a chosen design preview as a reusable voice. */
export function createVoice(args: {
  name: string;
  description: string;
  generatedVoiceId: string;
  voiceSettings?: Record<string, number>;
}): Promise<Voice> {
  return invoke<Voice>("create_voice", args);
}

export function listVoices(): Promise<Voice[]> {
  return invoke<Voice[]>("list_voices");
}

export function deleteVoice(voiceId: string): Promise<void> {
  return invoke<void>("delete_voice", { voiceId });
}

// --- audio: items (per project) ------------------------------------------

export function listAudio(project: string): Promise<AudioBundle> {
  return invoke<AudioBundle>("list_audio", { project });
}

export function createAudioItem(args: {
  project: string;
  kind: AudioKind;
  name: string;
  text: string;
  voiceId?: string | null;
  assetId?: string | null;
  params?: Record<string, unknown>;
}): Promise<AudioItem> {
  return invoke<AudioItem>("create_audio_item", args);
}

/** Link (or unlink, when `assetId` is null) an audio item to an asset. */
export function setAudioItemAsset(
  project: string,
  itemId: string,
  assetId: string | null,
): Promise<void> {
  return invoke<void>("set_audio_item_asset", { project, itemId, assetId });
}

export function generateAudioItem(
  project: string,
  itemId: string,
): Promise<void> {
  return invoke<void>("generate_audio_item", { project, itemId });
}

export function deleteAudioItem(
  project: string,
  itemId: string,
): Promise<void> {
  return invoke<void>("delete_audio_item", { project, itemId });
}

/** Resolve a project-relative file to an absolute (confined) path. */
export function projectFileSrc(
  project: string,
  rel: string,
): Promise<string> {
  return invoke<string>("project_file_src", { project, rel });
}

/** Copy a project-relative file to a user-chosen absolute destination. */
export function saveProjectFile(
  project: string,
  rel: string,
  dest: string,
): Promise<void> {
  return invoke<void>("save_project_file", { project, rel, dest });
}

/** Resolve a project-relative file to a webview-loadable URL. */
export async function projectFileUrl(
  project: string,
  rel: string,
): Promise<string> {
  const abs = await projectFileSrc(project, rel);
  return convertFileSrc(abs);
}

// --- events --------------------------------------------------------------

export function onServerStatus(
  handler: (s: ServerStatus) => void,
): Promise<UnlistenFn> {
  return listen<ServerStatus>("server-status", (e) => handler(e.payload));
}

export function onInstallProgress(
  handler: (p: InstallProgress) => void,
): Promise<UnlistenFn> {
  return listen<InstallProgress>("install-progress", (e) =>
    handler(e.payload),
  );
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
