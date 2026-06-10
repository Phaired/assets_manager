import { useEffect, useState } from "react";
import { Loader2, Check, Plus, Search } from "lucide-react";

import type { ProjectBundle, StageStatus } from "../lib/types";
import { STAGES } from "../lib/constants";
import { useSetProjectStyle } from "../lib/queries";
import { useAppState } from "../lib/appState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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
function ProjectStyleField({ project, style }: { project: string; style: string }) {
  const setStyle = useSetProjectStyle(project);
  const [value, setValue] = useState(style);
  const [saved, setSaved] = useState(false);

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

/** 3D-section contents of the sidebar: new-asset action, filterable asset
 *  list, project style. The creation form itself lives in the main pane
 *  (shown when no asset is selected), mirroring the audio section. */
export function Assets3dSidebar({
  bundle,
  loading,
}: {
  bundle: ProjectBundle | null;
  loading: boolean;
}) {
  const { project, assetId, setAssetId } = useAppState();
  const assets = bundle?.project.assets ?? [];
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? assets.filter((a) => a.name.toLowerCase().includes(needle))
    : assets;

  return (
    <>
      <Button
        size="sm"
        disabled={!project}
        onClick={() => setAssetId(null)}
        title="Créer un nouvel asset"
      >
        <Plus size={14} /> Nouvel asset
      </Button>

      <div className="flex min-h-0 grow flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">Assets</span>
          <span className="text-xs text-muted-foreground">
            {needle ? `${visible.length}/${assets.length}` : assets.length}
          </span>
        </div>

        {assets.length > 5 && (
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrer…"
              aria-label="Filtrer les assets"
              className="h-8 pl-8"
            />
          </div>
        )}

        <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto">
          {loading && !bundle && (
            <div className="flex flex-col gap-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {!loading && !project && (
            <p className="px-1 py-2 text-sm text-muted-foreground">Aucun projet.</p>
          )}
          {project && !assets.length && (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              Aucun asset pour l'instant.
            </div>
          )}
          {project && assets.length > 0 && !visible.length && (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              Aucun asset ne correspond.
            </p>
          )}
          {visible.map((a) => {
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
                onClick={() => setAssetId(a.id)}
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
                        className={cn("size-2 rounded-full", DOT_COLOR[status])}
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

      {project && bundle && (
        <ProjectStyleField project={project} style={bundle.project.style} />
      )}
    </>
  );
}
