import { useEffect, useMemo, useState } from "react";

import {
  useConfig,
  useProject,
  useProjects,
  useServer,
} from "../lib/queries";
import { getLastProject, setLastProject } from "../lib/prefs";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { AssetDetail } from "./AssetDetail";
import { ActivityBanner } from "./ActivityBanner";
import { OnboardingBanner } from "./OnboardingBanner";
import { SettingsDialog } from "./SettingsDialog";
import { ViewerDialog } from "./ViewerDialog";

export function Workspace() {
  const projectsQ = useProjects();
  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);

  const [project, setProject] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  // Pick a sensible default project once the list arrives: keep the current
  // one if still valid, else restore the last-used project from prefs, else the
  // first available.
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

  // If the selected asset disappears (deleted / project switch), clear it.
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

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <Header
        server={serverQ.data ?? null}
        spendUsd={bundleQ.data?.state.estimatedSpendUsd ?? null}
        budgetUsd={configQ.data?.budgetUsd ?? null}
        onOpenViewer={() => openViewer(null)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <ActivityBanner
        server={serverQ.data ?? null}
        bundle={bundleQ.data ?? null}
      />

      <OnboardingBanner />

      <main className="flex min-h-0 flex-1">
        <Sidebar
          projects={projects}
          project={project}
          bundle={bundleQ.data ?? null}
          loading={projectsQ.isLoading || bundleQ.isLoading}
          assetId={assetId}
          onSelectProject={(p) => {
            setProject(p);
            setAssetId(null);
          }}
          onSelectAsset={setAssetId}
          onCreatedAsset={setAssetId}
        />

        <section className="min-w-0 flex-1 overflow-y-auto">
          <AssetDetail
            project={project}
            assetId={assetId}
            bundle={bundleQ.data ?? null}
            onDeleted={() => setAssetId(null)}
            onEnlarge={openViewer}
          />
        </section>
      </main>

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      {viewerOpen && (
        <ViewerDialog
          initialSrc={viewerSrc}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}
