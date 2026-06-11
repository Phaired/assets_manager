import { Loader2, AlertTriangle } from "lucide-react";
import type {
  ProjectBundle,
  ServerStatus,
  StageKey,
  StageState,
} from "../lib/types";
import { STAGES, TEXTURE_STAGE } from "../lib/constants";
import { lastLine } from "../lib/format";
import { cn } from "@/lib/utils";

const bannerBase =
  "flex items-center gap-2 px-5 py-2 text-sm border-b border-border " +
  "animate-in slide-in-from-top-1 fade-in duration-200";

/**
 * Global activity banner. Priority: server starting (model load) > job running
 * > server error. Mirrors the original updateBanner() logic.
 */
export function ActivityBanner({
  server,
  bundle,
}: {
  server: ServerStatus | null;
  bundle: ProjectBundle | null;
}) {
  const job = bundle?.jobs?.current ?? null;

  if (server && server.status === "starting") {
    return (
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
        <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
          {lastLine(server.logTail)}
        </span>
      </div>
    );
  }

  if (job) {
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
    return (
      <div
        className={cn(bannerBase, "bg-primary/15 text-primary")}
        role="status"
        aria-live="polite"
      >
        <Loader2 size={15} className="animate-spin shrink-0" />
        <span>
          Génération en cours — <b>{job.assetId}</b> · {stageLabel}
        </span>
      </div>
    );
  }

  if (server && server.status === "error") {
    return (
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

  return null;
}
