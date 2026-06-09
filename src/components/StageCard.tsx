import { useEffect, useState } from "react";
import { Loader2, Check, X, Clock, Play, RotateCw } from "lucide-react";

import type { StageState } from "../lib/types";
import type { StageDef } from "../lib/constants";
import { elapsed } from "../lib/format";

export function StageCard({
  def,
  state,
  disabled,
  onRun,
}: {
  def: StageDef;
  state: StageState | undefined;
  disabled: boolean;
  onRun: () => void;
}) {
  const status = state?.status ?? "pending";
  const busy = status === "running" || status === "queued";

  // Live ticking elapsed while running.
  const [, force] = useState(0);
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  const el = elapsed(state?.updatedAt);

  let statusNode: React.ReactNode;
  switch (status) {
    case "running":
      statusNode = (
        <>
          <Loader2 size={13} className="spin" /> en cours
          {el ? ` · ${el}` : ""}
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
    <div className={`stage status-${status}`}>
      <h4>{def.label}</h4>
      <div className={`status ${status}`}>{statusNode}</div>
      <div className="hint">{def.hint}</div>
      {state?.error && <div className="err">{state.error}</div>}
      <button
        className="btn sm stage-run"
        disabled={busy || disabled}
        onClick={onRun}
      >
        {status === "done" ? <RotateCw size={13} /> : <Play size={13} />}
        {status === "done" ? "Relancer" : "Lancer"}
      </button>
    </div>
  );
}
