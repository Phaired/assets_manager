import { Box, Settings, Wallet } from "lucide-react";
import type { ServerStatus } from "../lib/types";
import { ServerPill } from "./ServerPill";
import { fmtUsd } from "../lib/format";

export function Header({
  server,
  spendUsd,
  budgetUsd,
  onOpenViewer,
  onOpenSettings,
}: {
  server: ServerStatus | null;
  spendUsd: number | null;
  budgetUsd: number | null;
  onOpenViewer: () => void;
  onOpenSettings: () => void;
}) {
  const overBudget =
    budgetUsd != null && spendUsd != null && spendUsd > budgetUsd + 1e-9;
  return (
    <header className="header">
      <div className="header-brand">
        <span className="brand-mark" aria-hidden>
          <span className="brand-cube" />
        </span>
        <div className="brand-text">
          <h1>assets_gen</h1>
          <span className="brand-sub">pipeline 3D local</span>
        </div>
      </div>

      <div className="header-right">
        {spendUsd != null && (
          <span
            className={"budget-chip" + (overBudget ? " over" : "")}
            title="Dépense estimée OpenAI sur ce projet / budget"
          >
            <Wallet size={14} />
            {fmtUsd(spendUsd)}
            {budgetUsd != null && (
              <span className="budget-sep">/ {fmtUsd(budgetUsd)}</span>
            )}
          </span>
        )}
        <ServerPill server={server} />
        <button className="btn ghost" onClick={onOpenViewer}>
          <Box size={15} /> Visualiseur 3D
        </button>
        <button className="btn ghost" onClick={onOpenSettings}>
          <Settings size={15} /> Réglages
        </button>
      </div>
    </header>
  );
}
