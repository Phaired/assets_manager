import { useEffect, useMemo, useState } from "react";

import {
  useConfig,
  useProject,
  useProjects,
  useServer,
} from "../lib/queries";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { AssetDetail } from "./AssetDetail";
import { ActivityBanner } from "./ActivityBanner";
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

  // Pick a sensible default project once the list arrives.
  useEffect(() => {
    if (!projects.length) {
      setProject(null);
      return;
    }
    setProject((cur) => (cur && projects.includes(cur) ? cur : projects[0]));
  }, [projects]);

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
    <div className="app-shell">
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

      <main className="main">
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

        <section className="detail-pane">
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
