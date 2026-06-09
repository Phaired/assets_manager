import { useEffect, useState } from "react";
import { Plus, FolderPlus, Loader2, Check } from "lucide-react";

import type { ProjectBundle, StageStatus } from "../lib/types";
import { STAGES } from "../lib/constants";
import { useCreateProject, useSetProjectStyle } from "../lib/queries";
import { NewAssetForm } from "./NewAssetForm";

/** Free-text style for the whole project — injected into every asset's image
 *  prompt. Saved on blur (or Ctrl/Cmd+Enter). */
function ProjectStyleField({
  project,
  style,
}: {
  project: string;
  style: string;
}) {
  const setStyle = useSetProjectStyle(project);
  const [value, setValue] = useState(style);
  const [saved, setSaved] = useState(false);

  // Re-sync when switching project or when the persisted value changes.
  useEffect(() => {
    setValue(style);
    setSaved(false);
  }, [project, style]);

  function commit() {
    if (value === style) return;
    setStyle.mutate(value, {
      onSuccess: () => {
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1500);
      },
    });
  }

  return (
    <div className="project-style">
      <label className="field-label" htmlFor="project-style">
        Style du projet
        {setStyle.isPending && <Loader2 size={12} className="spin" />}
        {saved && !setStyle.isPending && (
          <span className="saved-hint">
            <Check size={12} /> enregistré
          </span>
        )}
      </label>
      <textarea
        id="project-style"
        className="input"
        rows={2}
        placeholder="ex. low-poly, couleurs vives, matériaux mats…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </div>
  );
}

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

        {project && bundle && (
          <ProjectStyleField project={project} style={bundle.project.style} />
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
