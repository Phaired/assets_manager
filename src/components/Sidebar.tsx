import { useEffect, useState } from "react";
import { Plus, FolderPlus, Loader2, Check } from "lucide-react";
import { toast } from "sonner";

import type { ProjectBundle, StageStatus } from "../lib/types";
import { STAGES } from "../lib/constants";
import { useCreateProject, useSetProjectStyle } from "../lib/queries";
import { NewAssetForm } from "./NewAssetForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Maps a stage status to the dot color class. */
const DOT_COLOR: Record<StageStatus, string> = {
  pending: "bg-muted-foreground/40",
  queued: "bg-run",
  running: "bg-run animate-pulse",
  done: "bg-ok",
  error: "bg-destructive",
};

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
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="project-style" className="text-muted-foreground">
        Style du projet
        {setStyle.isPending && <Loader2 size={12} className="animate-spin" />}
        {saved && !setStyle.isPending && (
          <span className="flex items-center gap-1 text-ok">
            <Check size={12} /> enregistré
          </span>
        )}
      </Label>
      <Textarea
        id="project-style"
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
    toast.success(`Projet « ${p.name} » créé`);
    onSelectProject(p.name);
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 border-r border-border bg-card p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-select" className="text-muted-foreground">
          Projet
        </Label>
        <div className="flex items-center gap-2">
          <Select
            value={project ?? ""}
            disabled={!projects.length}
            onValueChange={onSelectProject}
          >
            <SelectTrigger
              id="project-select"
              className="w-full"
              aria-label="Projet"
            >
              <SelectValue placeholder="Aucun projet" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            title="Nouveau projet"
            aria-label="Nouveau projet"
            onClick={() => setCreatingProject((v) => !v)}
            aria-expanded={creatingProject}
          >
            <FolderPlus size={16} />
          </Button>
        </div>

        {creatingProject && (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitNewProject();
            }}
          >
            <Input
              autoFocus
              placeholder="Nom du projet…"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
            />
            <Button
              type="submit"
              size="icon"
              className="shrink-0"
              aria-label="Créer le projet"
              disabled={createProject.isPending || !newProjectName.trim()}
            >
              {createProject.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
            </Button>
          </form>
        )}

        {project && bundle && (
          <ProjectStyleField project={project} style={bundle.project.style} />
        )}
      </div>

      <div className="flex min-h-0 grow flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">
            Assets
          </span>
          <span className="text-xs text-muted-foreground">{assets.length}</span>
        </div>

        <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto">
          {loading && !bundle && (
            <div className="flex flex-col gap-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {!loading && !project && (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              Aucun projet.
            </p>
          )}
          {project && !assets.length && (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              Aucun asset pour l'instant.
            </p>
          )}
          {assets.map((a) => {
            const active = a.id === assetId;
            return (
              <button
                key={a.id}
                className={cn(
                  "relative flex items-center justify-between gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-foreground hover:bg-muted",
                )}
                onClick={() => onSelectAsset(a.id)}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px] bg-primary"
                  />
                )}
                <span className="truncate">{a.name}</span>
                <span className="flex shrink-0 items-center gap-1" aria-hidden>
                  {STAGES.map((s) => {
                    const status = stageStatus(bundle, a.id, s.key);
                    return (
                      <span
                        key={s.key}
                        className={cn(
                          "size-2 rounded-full",
                          DOT_COLOR[status],
                        )}
                        title={`${s.label}: ${status}`}
                      />
                    );
                  })}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <NewAssetForm project={project} onCreated={onCreatedAsset} />
    </aside>
  );
}
