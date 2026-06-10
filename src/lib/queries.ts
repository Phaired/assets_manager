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
  Backend,
  ConfigPatch,
  ConfigPublic,
  Gen3d,
  InstallProgress,
  ProjectBundle,
  ServerStatus,
  StageKey,
} from "./types";

export const qk = {
  projects: ["projects"] as const,
  project: (name: string) => ["project", name] as const,
  config: ["config"] as const,
  server: ["server"] as const,
  install: ["install"] as const,
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

export function useCreateAsset(project: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      description: string;
      tags: string[];
      backend: Backend;
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
