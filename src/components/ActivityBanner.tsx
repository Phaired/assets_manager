import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ListOrdered,
  Loader2,
} from "lucide-react";
import type {
  ProjectBundle,
  ServerStatus,
  StageKey,
  StageState,
} from "../lib/types";
import { STAGES, TEXTURE_STAGE } from "../lib/constants";
import { lastLine } from "../lib/format";
import { cn } from "@/lib/utils";
import { GenerationQueue } from "./GenerationQueue";

const bannerBase =
  "flex items-center gap-2 px-5 py-2 text-sm border-b border-border " +
  "animate-in slide-in-from-top-1 fade-in duration-200";

/**
 * Global activity banner. Priority: server starting (model load) > job running
 * > server error. When jobs are waiting in the queue, a "File : N" chip toggles
 * an expandable GenerationQueue strip rendered just beneath the banner.
 */
export function ActivityBanner({
  server,
  bundle,
}: {
  server: ServerStatus | null;
  bundle: ProjectBundle | null;
}) {
  const [queueOpen, setQueueOpen] = useState(false);
  const job = bundle?.jobs?.current ?? null;
  const pending = bundle?.jobs?.pending ?? [];
  const hasQueue = pending.length > 0;

  // Chip shown whenever something is waiting; toggles the queue strip below.
  const queueChip = hasQueue ? (
    <button
      onClick={() => setQueueOpen((v) => !v)}
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-foreground transition-colors hover:border-primary"
      aria-expanded={queueOpen}
      title="Afficher / masquer la file de génération"
    >
      <ListOrdered size={12} />
      File : {pending.length}
      {queueOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
    </button>
  ) : null;

  let banner: ReactNode = null;

  if (server && server.status === "starting") {
    banner = (
      <div
        className={cn(bannerBase, "bg-run/15 text-run")}
        role="status"
        aria-live="polite"
      >
        <Loader2 size={15} className="animate-spin shrink-0" />
        <span>
          Démarrage du serveur Hunyuan <b>{server.backend ?? ""}</b> — chargement
          du modèle sur le GPU (1 à 3 min)…
        </span>
        {queueChip ?? (
          <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
            {lastLine(server.logTail)}
          </span>
        )}
      </div>
    );
  } else if (job) {
    const stages: Partial<Record<StageKey, StageState>> =
      bundle?.state?.assets?.[job.assetId] ?? {};
    const allDefs = [...STAGES, TEXTURE_STAGE];
    const runningKey = allDefs.find(
      (x) => stages[x.key]?.status === "running",
    )?.key;
    const stageLabel =
      allDefs.find((x) => x.key === runningKey)?.label ??
      allDefs.find((x) => job.stages?.includes(x.key))?.label ??
      (job.stages ?? []).join(", ");
    const assetName =
      bundle?.project.assets.find((a) => a.id === job.assetId)?.name ??
      job.assetId;
    banner = (
      <div
        className={cn(bannerBase, "bg-primary/15 text-primary")}
        role="status"
        aria-live="polite"
      >
        <Loader2 size={15} className="animate-spin shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          Génération en cours — <b>{assetName}</b> · {stageLabel}
        </span>
        {queueChip}
      </div>
    );
  } else if (server && server.status === "error") {
    banner = (
      <div
        className={cn(bannerBase, "bg-destructive/15 text-destructive")}
        role="alert"
      >
        <AlertTriangle size={15} className="shrink-0" />
        <span>Serveur Hunyuan : {server.error ?? "erreur"}</span>
        <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
          {lastLine(server.logTail)}
        </span>
      </div>
    );
  }

  // Defensive: jobs queued but none of the branches above matched (e.g. the brief
  // gap between two jobs) — still expose the queue via a minimal bar.
  if (!banner && hasQueue) {
    banner = (
      <div
        className={cn(bannerBase, "bg-card/60 text-foreground")}
        role="status"
        aria-live="polite"
      >
        <ListOrdered size={15} className="shrink-0 text-muted-foreground" />
        <span>{pending.length} génération(s) en attente</span>
        {queueChip}
      </div>
    );
  }

  if (!banner) return null;

  return (
    <>
      {banner}
      {queueOpen && hasQueue && bundle && (
        <GenerationQueue bundle={bundle} server={server} />
      )}
    </>
  );
}
