import { useEffect, useMemo, useState } from "react";
import { Outlet } from "@tanstack/react-router";

import { useConfig, useProject, useProjects, useServer } from "../lib/queries";
import { getLastProject, setLastProject } from "../lib/prefs";
import { AppStateContext } from "../lib/appState";
import { Header } from "./Header";
import { ActivityRail } from "./ActivityRail";
import { AppSidebar } from "./AppSidebar";
import { ActivityBanner } from "./ActivityBanner";
import { OnboardingBanner } from "./OnboardingBanner";
import { SettingsDialog } from "./SettingsDialog";
import { ViewerDialog } from "./ViewerDialog";

/**
 * Application shell shared by the two sections (3D assets `/` and audio
 * `/audio`): top header, banners, the left sidebar (project selector + section
 * nav + contextual list) and the routed detail pane. Owns the cross-section
 * state (selected project / asset / audio item) via `AppStateContext`.
 */
export function AppShell() {
  const projectsQ = useProjects();
  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);

  const [project, setProject] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  // Pick a sensible default project once the list arrives.
  useEffect(() => {
    if (!projects.length) {
      setProject(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const last = await getLastProject();
      if (cancelled) return;
      setProject((cur) => {
        if (cur && projects.includes(cur)) return cur;
        if (last && projects.includes(last)) return last;
        return projects[0];
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  // Persist the selected project so the app reopens on it.
  useEffect(() => {
    if (project) void setLastProject(project);
  }, [project]);

  const bundleQ = useProject(project);
  const serverQ = useServer();
  const configQ = useConfig();

  // If the selected 3D asset disappears (deleted / project switch), clear it.
  useEffect(() => {
    const assets = bundleQ.data?.project.assets ?? [];
    if (assetId && !assets.some((a) => a.id === assetId)) {
      setAssetId(null);
    }
  }, [bundleQ.data, assetId]);

  function openViewer(src: string | null) {
    setViewerSrc(src);
    setViewerOpen(true);
  }

  const ctx = {
    project,
    setProject: (p: string) => {
      setProject(p);
      setAssetId(null);
      setAudioId(null);
    },
    assetId,
    setAssetId,
    audioId,
    setAudioId,
    openViewer,
    openSettings: () => setSettingsOpen(true),
  };

  return (
    <AppStateContext.Provider value={ctx}>
      <div className="app-chrome flex h-screen flex-col bg-transparent text-foreground">
        <Header
          projects={projects}
          server={serverQ.data ?? null}
          spendUsd={bundleQ.data?.state.estimatedSpendUsd ?? null}
          budgetUsd={configQ.data?.budgetUsd ?? null}
        />

        <ActivityBanner
          server={serverQ.data ?? null}
          bundle={bundleQ.data ?? null}
        />

        <OnboardingBanner />

        <main className="flex min-h-0 flex-1">
          <ActivityRail />
          <AppSidebar bundle={bundleQ.data ?? null} loading={projectsQ.isLoading || bundleQ.isLoading} />
          <section className="min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </section>
        </main>

        {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
        {viewerOpen && (
          <ViewerDialog
            initialSrc={viewerSrc}
            onClose={() => setViewerOpen(false)}
          />
        )}
      </div>
    </AppStateContext.Provider>
  );
}
