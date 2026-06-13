import { Loader2, Square, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import type {
  ProjectBundle,
  ServerStatus,
  StageKey,
  StageState,
} from "../lib/types";
import { STAGES, STAGE_STATUS_COLOR, TEXTURE_STAGE } from "../lib/constants";
import { parseGenProgress } from "./asset-detail/genProgress";
import {
  useCancelGeneration,
  useClearQueue,
  useRemoveQueued,
} from "../lib/queries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ALL_STAGE_DEFS = [...STAGES, TEXTURE_STAGE];

/** Human label for a stage key (falls back to the raw key). */
function stageLabel(key: string): string {
  return ALL_STAGE_DEFS.find((d) => d.key === key)?.label ?? key;
}

/**
 * Expandable generation-queue panel rendered under the ActivityBanner. Shows the
 * running job (asset + current stage + live %) on top, then the waiting jobs in
 * FIFO order, each removable; footer offers "Vider la file" and "Tout arrêter".
 * The serial GPU executor lives in the Rust backend — this only displays and
 * controls it via the existing event → query refresh path.
 */
export function GenerationQueue({
  bundle,
  server,
}: {
  bundle: ProjectBundle;
  server: ServerStatus | null;
}) {
  const project = bundle.project.name;
  const cancel = useCancelGeneration(project);
  const clear = useClearQueue(project);
  const remove = useRemoveQueued(project);

  const current = bundle.jobs.current;
  const pending = bundle.jobs.pending ?? [];

  const assetName = (assetId: string) =>
    bundle.project.assets.find((a) => a.id === assetId)?.name ?? assetId;

  // Running stage label + live % (parsed from the Hunyuan log tail).
  const runningStages: Partial<Record<StageKey, StageState>> = current
    ? bundle.state.assets[current.assetId] ?? {}
    : {};
  const runningKey = current
    ? ALL_STAGE_DEFS.find((d) => runningStages[d.key]?.status === "running")?.key
    : undefined;
  const curStageLabel = runningKey
    ? stageLabel(runningKey)
    : current
      ? current.stages.map(stageLabel).join(" → ")
      : "";
  const prog = current ? parseGenProgress(server?.logTail) : null;

  function onCancel() {
    cancel.mutate(undefined, {
      onSuccess: (acked) =>
        toast.success(
          acked ? "Arrêt demandé — le modèle reste chargé" : "Arrêt demandé",
        ),
      onError: (e) => toast.error(`Échec de l'arrêt : ${String(e)}`),
    });
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-card/60 px-5 py-2 text-sm animate-in slide-in-from-top-1 fade-in duration-200">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          File de génération
        </span>
        <div className="flex items-center gap-1">
          {pending.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                clear.mutate(undefined, {
                  onSuccess: () => toast.success("File vidée"),
                })
              }
              disabled={clear.isPending}
              title="Retirer tous les jobs en attente (le job en cours continue)"
            >
              <Trash2 size={13} /> Vider la file
            </Button>
          )}
          {current && pending.length > 0 && (
            <Button
              size="xs"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                clear.mutate(undefined);
                onCancel();
              }}
              disabled={clear.isPending || cancel.isPending}
              title="Vider la file et arrêter le job en cours"
            >
              <Square size={13} /> Tout arrêter
            </Button>
          )}
        </div>
      </div>

      <ul className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
        {current && (
          <li className="flex items-center gap-2 rounded-md px-1 py-1">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                STAGE_STATUS_COLOR.running,
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              <b className="font-medium">{assetName(current.assetId)}</b>
              <span className="text-muted-foreground"> · {curStageLabel}</span>
              {prog?.pct != null && (
                <span className="ml-1 font-mono text-xs text-muted-foreground">
                  {prog.pct}%
                </span>
              )}
            </span>
            <Button
              size="xs"
              variant="destructive"
              onClick={onCancel}
              disabled={cancel.isPending}
              className="shrink-0"
              title="Arrêter la génération en cours (les modèles restent chargés en VRAM)"
            >
              {cancel.isPending ? (
                <Loader2 className="animate-spin" size={13} />
              ) : (
                <Square size={13} />
              )}
              Arrêter
            </Button>
          </li>
        )}

        {pending.map((job) => (
          <li key={job.id} className="flex items-center gap-2 rounded-md px-1 py-1">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                STAGE_STATUS_COLOR.queued,
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">
              {assetName(job.assetId)}
              <span className="text-muted-foreground">
                {" "}
                · {job.stages.map(stageLabel).join(" → ")}
              </span>
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                remove.mutate(job.id, {
                  onSuccess: () => toast.success("Retiré de la file"),
                })
              }
              disabled={remove.isPending}
              aria-label="Retirer de la file"
              title="Retirer ce job de la file"
              className="shrink-0"
            >
              <X size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
