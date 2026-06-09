import { Loader2, AlertTriangle } from "lucide-react";
import type {
  ProjectBundle,
  ServerStatus,
  StageKey,
  StageState,
} from "../lib/types";
import { STAGES } from "../lib/constants";
import { lastLine } from "../lib/format";

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
      <div className="banner banner-starting" role="status" aria-live="polite">
        <Loader2 size={15} className="spin" />
        <span>
          Démarrage du serveur Hunyuan <b>{server.backend ?? ""}</b> — chargement
          du modèle sur le GPU (1 à 3 min)…
        </span>
        <span className="banner-log">{lastLine(server.logTail)}</span>
      </div>
    );
  }

  if (job) {
    const stages: Partial<Record<StageKey, StageState>> =
      bundle?.state?.assets?.[job.assetId] ?? {};
    const runningKey = STAGES.find(
      (x) => stages[x.key]?.status === "running",
    )?.key;
    const stageLabel =
      STAGES.find((x) => x.key === runningKey)?.label ??
      STAGES.find((x) => job.stages?.includes(x.key))?.label ??
      (job.stages ?? []).join(", ");
    return (
      <div className="banner banner-running" role="status" aria-live="polite">
        <Loader2 size={15} className="spin" />
        <span>
          Génération en cours — <b>{job.assetId}</b> · {stageLabel}
        </span>
      </div>
    );
  }

  if (server && server.status === "error") {
    return (
      <div className="banner banner-error" role="alert">
        <AlertTriangle size={15} />
        <span>Serveur Hunyuan : {server.error ?? "erreur"}</span>
        <span className="banner-log">{lastLine(server.logTail)}</span>
      </div>
    );
  }

  return null;
}
