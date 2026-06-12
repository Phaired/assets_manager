// TanStack Query hooks + mutations. Tauri events invalidate queries — no polling.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import * as api from "./api";
import type {
  AssetKind,
  AudioBundle,
  AudioKind,
  Backend,
  ConfigPatch,
  ConfigPublic,
  DecimateParams,
  Gen3d,
  InstallProgress,
  ProjectBundle,
  ProjectDna,
  ServerStatus,
  StageKey,
  SuggestTarget,
  Voice,
} from "./types";

export const qk = {
  projects: ["projects"] as const,
  project: (name: string) => ["project", name] as const,
  config: ["config"] as const,
  server: ["server"] as const,
  install: ["install"] as const,
  voices: ["voices"] as const,
  audio: (name: string) => ["audio", name] as const,
};

// --- queries -------------------------------------------------------------

export function useProjects() {
  return useQuery({
    queryKey: qk.projects,
    queryFn: api.listProjects,
  });
}

export function useProject(name: string | null) {
  return useQuery<ProjectBundle>({
    queryKey: qk.project(name ?? "__none__"),
    queryFn: () => api.getProject(name as string),
    enabled: !!name,
  });
}

export function useConfig() {
  return useQuery<ConfigPublic>({
    queryKey: qk.config,
    queryFn: api.getConfig,
  });
}

export function useServer() {
  return useQuery<ServerStatus>({
    queryKey: qk.server,
    queryFn: api.serverStatus,
  });
}

// --- mutations -----------------------------------------------------------

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createProject(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects }),
  });
}

export function useSetProjectStyle(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (style: string) =>
      api.setProjectStyle(project as string, style),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useSetProjectDna(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dna: ProjectDna) => api.setProjectDna(project as string, dna),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useCreateAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      description: string;
      tags: string[];
      backend: Backend;
      kind?: AssetKind;
      source?: "openai" | "manual" | "text";
    }) => api.createAsset({ project: project as string, ...vars }),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useUpdateAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; backend: Backend }) =>
      api.updateAsset(project as string, vars.assetId, vars.backend),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useRenameAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; name: string }) =>
      api.renameAsset(project as string, vars.assetId, vars.name),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useSetAssetTags(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; tags: string[] }) =>
      api.setAssetTags(project as string, vars.assetId, vars.tags),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useSetAssetSeed(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; seed: number | null }) =>
      api.setAssetSeed(project as string, vars.assetId, vars.seed),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useSetAssetPrompt(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; prompt: string }) =>
      api.setAssetPrompt(project as string, vars.assetId, vars.prompt),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useDuplicateAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) =>
      api.duplicateAsset(project as string, assetId),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useDeleteAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) =>
      api.deleteAsset(project as string, assetId),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useResetAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => api.resetAsset(project as string, assetId),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useGenerate(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; stages: StageKey[] }) =>
      api.generate(project as string, vars.assetId, vars.stages),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useCancelGeneration(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelGeneration(),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useSetAssetGen3d(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; gen3d: Partial<Gen3d> }) =>
      api.setAssetGen3d(project as string, vars.assetId, vars.gen3d),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useSetAssetDecimate(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; decimate: Partial<DecimateParams> }) =>
      api.setAssetDecimate(project as string, vars.assetId, vars.decimate),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useDecimateModel(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      assetId: string;
      params?: Partial<DecimateParams>;
    }) => api.decimateModel(project as string, vars.assetId, vars.params),
    onSettled: () => {
      // The "decimate" stage state changed whether it succeeded or failed.
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

/** Standalone texture-paint pass on an untextured model (texture later). */
export function usePaintModel(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string }) =>
      api.paintModel(project as string, vars.assetId),
    onSettled: () => {
      // The "paint3d" stage state changed whether it succeeded or failed.
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useEditImage(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      assetId: string;
      prompt: string;
      maskBytes: number[] | null;
    }) =>
      api.editImage(project as string, vars.assetId, vars.prompt, vars.maskBytes),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useEditMultiview(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      assetId: string;
      prompt: string;
      maskBytes: number[] | null;
    }) =>
      api.editMultiview(
        project as string,
        vars.assetId,
        vars.prompt,
        vars.maskBytes,
      ),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useDeriveAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      assetId: string;
      prompt: string;
      maskBytes: number[] | null;
    }) =>
      api.deriveAsset(
        project as string,
        vars.assetId,
        vars.prompt,
        vars.maskBytes,
      ),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useUploadSource(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { assetId: string; bytes: number[] }) =>
      api.uploadSource(project as string, vars.assetId, vars.bytes),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.project(project) });
    },
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ConfigPatch) => api.updateConfig(patch),
    onSuccess: (data) => {
      qc.setQueryData(qk.config, data);
      qc.invalidateQueries({ queryKey: qk.config });
    },
  });
}

export function useServerStart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backend: "v21" | "mv2") => api.serverStart(backend),
    onSuccess: (data) => qc.setQueryData(qk.server, data),
  });
}

export function useServerStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.serverStop(),
    onSuccess: (data) => qc.setQueryData(qk.server, data),
  });
}

// --- creative director (OpenAI text) --------------------------------------

export function useSuggestPrompts(project: string | null) {
  return useMutation({
    mutationFn: (vars: { assetId?: string | null; target: SuggestTarget }) =>
      api.suggestPrompts(project as string, vars.assetId ?? null, vars.target),
    // Spend refresh comes through the project-changed event.
  });
}

export function useIdeatePack(project: string | null) {
  return useMutation({
    mutationFn: (brief: string) => api.ideatePack(project as string, brief),
  });
}

// --- audio: voices (global catalog) -------------------------------------

export function useVoices() {
  return useQuery<Voice[]>({
    queryKey: qk.voices,
    queryFn: api.listVoices,
  });
}

export function useDesignVoice() {
  return useMutation({
    mutationFn: (vars: {
      description: string;
      previewText: string;
      seed?: number;
      guidanceScale?: number;
    }) => api.designVoice(vars),
  });
}

export function useCreateVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      description: string;
      generatedVoiceId: string;
      voiceSettings?: Record<string, number>;
    }) => api.createVoice(vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.voices }),
  });
}

export function useDeleteVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (voiceId: string) => api.deleteVoice(voiceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.voices }),
  });
}

// --- audio: items (per project) -----------------------------------------

export function useAudio(project: string | null) {
  return useQuery<AudioBundle>({
    queryKey: qk.audio(project ?? "__none__"),
    queryFn: () => api.listAudio(project as string),
    enabled: !!project,
  });
}

export function useCreateAudioItem(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      kind: AudioKind;
      name: string;
      text: string;
      voiceId?: string | null;
      assetId?: string | null;
      params?: Record<string, unknown>;
    }) => api.createAudioItem({ project: project as string, ...vars }),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.audio(project) });
    },
  });
}

export function useSetAudioItemAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { itemId: string; assetId: string | null }) =>
      api.setAudioItemAsset(project as string, vars.itemId, vars.assetId),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.audio(project) });
    },
  });
}

export function useGenerateAudioItem(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      api.generateAudioItem(project as string, itemId),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.audio(project) });
    },
  });
}

export function useDeleteAudioItem(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      api.deleteAudioItem(project as string, itemId),
    onSuccess: () => {
      if (project) qc.invalidateQueries({ queryKey: qk.audio(project) });
    },
  });
}

// --- guided Hunyuan installer -------------------------------------------

export function useInstallStatus() {
  return useQuery<InstallProgress>({
    queryKey: qk.install,
    queryFn: api.installStatus,
  });
}

export function useInstallBackend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backend: "v21" | "mv2") => api.installBackend(backend),
    onSuccess: (data) => qc.setQueryData(qk.install, data),
  });
}

export function useInstallText3d() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.installText3d(),
    onSuccess: (data) => qc.setQueryData(qk.install, data),
  });
}

export function useCancelInstall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelInstall(),
    onSuccess: (data) => qc.setQueryData(qk.install, data),
  });
}

// --- event wiring --------------------------------------------------------

/**
 * Subscribe once to the three Rust events and invalidate the matching queries.
 * Mount this near the app root. Returns nothing; cleans up on unmount.
 */
export function useEventBridge(qc: QueryClient) {
  useEffect(() => {
    let active = true;
    const unlistens: Array<() => void> = [];

    api
      .onServerStatus((s) => {
        qc.setQueryData(qk.server, s);
      })
      .then((u) => {
        if (active) unlistens.push(u);
        else u();
      });

    api
      .onInstallProgress((p) => {
        qc.setQueryData(qk.install, p);
        // When an install finishes, the backend paths + server state changed.
        if (p.done || p.error) {
          qc.invalidateQueries({ queryKey: qk.config });
          qc.invalidateQueries({ queryKey: qk.server });
        }
      })
      .then((u) => {
        if (active) unlistens.push(u);
        else u();
      });

    api
      .onProjectChanged((name) => {
        qc.invalidateQueries({ queryKey: qk.project(name) });
        qc.invalidateQueries({ queryKey: qk.projects });
        // Audio items live under a separate query key for the same project.
        qc.invalidateQueries({ queryKey: qk.audio(name) });
      })
      .then((u) => {
        if (active) unlistens.push(u);
        else u();
      });

    api
      .onJobChanged((snap) => {
        // A job change may touch a specific project; refresh that bundle and
        // the active project list. We invalidate broadly but cheaply.
        if (snap.current?.project) {
          qc.invalidateQueries({ queryKey: qk.project(snap.current.project) });
        }
        qc.invalidateQueries({ queryKey: ["project"] });
      })
      .then((u) => {
        if (active) unlistens.push(u);
        else u();
      });

    return () => {
      active = false;
      for (const u of unlistens) u();
    };
  }, [qc]);
}
