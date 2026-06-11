import { useEffect, useState } from "react";
import {
  Loader2,
  Check,
  X,
  Clock,
  Play,
  RotateCw,
  AlertTriangle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { StageState } from "../lib/types";
import type { StageDef } from "../lib/constants";
import { elapsed } from "../lib/format";

export function StageCard({
  def,
  state,
  disabled,
  onRun,
  blockedReason,
}: {
  def: StageDef;
  state: StageState | undefined;
  disabled: boolean;
  onRun: () => void;
  /** When set, the stage can't run standalone yet — explains why + blocks run. */
  blockedReason?: string | null;
}) {
  const status = state?.status ?? "pending";
  const busy = status === "running" || status === "queued";
  const blocked = !!blockedReason && !busy;

  // Live ticking elapsed while running.
  const [, force] = useState(0);
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  const el = elapsed(state?.updatedAt);

  // OpenAI cost of the last run (real when computed from the API usage block).
  const cost =
    typeof state?.meta?.cost === "number" ? (state.meta.cost as number) : null;
  const costReal = state?.meta?.cost_source === "api";

  // Left accent bar color reflects status.
  const accentClass =
    status === "done"
      ? "bg-ok"
      : busy
        ? "bg-run"
        : status === "error"
          ? "bg-destructive"
          : "bg-border";

  // Status line color matches the status.
  const statusColor =
    status === "done"
      ? "text-ok"
      : busy
        ? "text-run"
        : status === "error"
          ? "text-destructive"
          : "text-muted-foreground";

  let statusNode: React.ReactNode;
  switch (status) {
    case "running":
      statusNode = (
        <>
          <Loader2 size={13} className="animate-spin" /> en cours
          {el ? ` · ${el}` : ""}
          <span className="text-muted-foreground">· {def.eta}</span>
        </>
      );
      break;
    case "queued":
      statusNode = (
        <>
          <Clock size={13} /> en file…
        </>
      );
      break;
    case "done":
      statusNode = (
        <>
          <Check size={13} /> terminé
          {cost !== null && (
            <span
              className="text-muted-foreground"
              title={
                costReal
                  ? "Coût réel calculé depuis les tokens renvoyés par l'API"
                  : "Coût estimé (forfait) — modèle absent de la table de prix"
              }
            >
              · ${cost.toFixed(4)} {costReal ? "" : "(est.)"}
            </span>
          )}
        </>
      );
      break;
    case "error":
      statusNode = (
        <>
          <X size={13} /> erreur
        </>
      );
      break;
    default:
      statusNode = "en attente";
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card p-4">
      <span
        aria-hidden
        className={cn("absolute inset-y-0 left-0 w-[3px]", accentClass)}
      />
      <h4 className="text-sm font-semibold text-foreground">{def.label}</h4>
      <div
        className={cn(
          "mt-1 flex items-center gap-1.5 text-xs font-medium",
          statusColor,
        )}
      >
        {statusNode}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{def.hint}</div>
      {state?.error && (
        <div className="mt-2 rounded-md bg-destructive/15 px-2 py-1.5 text-xs text-destructive">
          {state.error}
        </div>
      )}
      {blocked && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-run/15 px-2 py-1.5 text-xs text-run">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{blockedReason}</span>
        </div>
      )}
      <Button
        size="sm"
        className="mt-3"
        disabled={busy || disabled || blocked}
        title={blocked ? (blockedReason ?? undefined) : undefined}
        onClick={onRun}
      >
        {status === "done" ? <RotateCw size={13} /> : <Play size={13} />}
        {status === "done" ? "Relancer" : "Lancer"}
      </Button>
    </div>
  );
}
