import { useState } from "react";
import { Plus, FolderPlus, Loader2 } from "lucide-react";

import type { ProjectBundle, StageStatus } from "../lib/types";
import { STAGES } from "../lib/constants";
import { useCreateProject } from "../lib/queries";
import { NewAssetForm } from "./NewAssetForm";

function stageStatus(
  bundle: ProjectBundle | null,
  assetId: string,
  stage: string,
): StageStatus {
  return (
    (bundle?.state?.assets?.[assetId]?.[
      stage as keyof (typeof bundle.state.assets)[string]
    ]?.status as StageStatus) ?? "pending"
  );
}

export function Sidebar({
  projects,
  project,
  bundle,
  loading,
  assetId,
  onSelectProject,
  onSelectAsset,
  onCreatedAsset,
}: {
  projects: string[];
  project: string | null;
  bundle: ProjectBundle | null;
  loading: boolean;
  assetId: string | null;
  onSelectProject: (p: string) => void;
  onSelectAsset: (id: string) => void;
  onCreatedAsset: (id: string) => void;
}) {
  const createProject = useCreateProject();
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const assets = bundle?.project.assets ?? [];

  async function submitNewProject() {
    const name = newProjectName.trim();
    if (!name) return;
    const p = await createProject.mutateAsync(name);
    setNewProjectName("");
    setCreatingProject(false);
    onSelectProject(p.name);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <label className="field-label" htmlFor="project-select">
          Projet
        </label>
        <div className="row">
          <select
            id="project-select"
            className="input"
            value={project ?? ""}
            disabled={!projects.length}
            onChange={(e) => onSelectProject(e.target.value)}
          >
            {!projects.length && <option value="">Aucun projet</option>}
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            className="btn icon"
            title="Nouveau projet"
            onClick={() => setCreatingProject((v) => !v)}
            aria-expanded={creatingProject}
          >
            <FolderPlus size={16} />
          </button>
        </div>

        {creatingProject && (
          <form
            className="inline-create"
            onSubmit={(e) => {
              e.preventDefault();
              submitNewProject();
            }}
          >
            <input
              className="input"
              autoFocus
              placeholder="Nom du projet…"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
            />
            <button
              type="submit"
              className="btn"
              disabled={createProject.isPending || !newProjectName.trim()}
            >
              {createProject.isPending ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Plus size={14} />
              )}
            </button>
          </form>
        )}
      </div>

      <div className="sidebar-section grow">
        <div className="section-head">
          <span className="field-label">Assets</span>
          <span className="muted small">{assets.length}</span>
        </div>

        <div className="asset-list">
          {loading && !bundle && (
            <div className="list-skeleton">
              <span className="skeleton-row" />
              <span className="skeleton-row" />
              <span className="skeleton-row" />
            </div>
          )}
          {!loading && !project && (
            <p className="muted empty-hint">Aucun projet.</p>
          )}
          {project && !assets.length && (
            <p className="muted empty-hint">Aucun asset pour l'instant.</p>
          )}
          {assets.map((a) => (
            <button
              key={a.id}
              className={"asset-item" + (a.id === assetId ? " active" : "")}
              onClick={() => onSelectAsset(a.id)}
            >
              <span className="asset-name">{a.name}</span>
              <span className="dots" aria-hidden>
                {STAGES.map((s) => (
                  <span
                    key={s.key}
                    className={`dot ${stageStatus(bundle, a.id, s.key)}`}
                    title={`${s.label}: ${stageStatus(bundle, a.id, s.key)}`}
                  />
                ))}
              </span>
            </button>
          ))}
        </div>
      </div>

      <NewAssetForm
        project={project}
        onCreated={onCreatedAsset}
      />
    </aside>
  );
}
