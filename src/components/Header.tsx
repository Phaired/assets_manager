import { Box, Settings, Wallet } from "lucide-react";
import type { ServerStatus } from "../lib/types";
import { ServerPill } from "./ServerPill";
import { QuickSettings } from "./QuickSettings";
import { fmtUsd } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
    <header className="flex items-center justify-between border-b border-border bg-card px-5 py-3">
      <div className="flex items-center gap-3">
        <span
          className="flex size-9 items-center justify-center rounded-lg bg-primary"
          aria-hidden
        >
          <span className="size-4 rounded-sm bg-primary-foreground" />
        </span>
        <div className="flex flex-col leading-tight">
          <h1 className="font-mono text-sm font-semibold text-foreground">
            assets_gen
          </h1>
          <span className="text-xs text-muted-foreground">
            pipeline 3D local
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {spendUsd != null && (
          <Badge
            variant={overBudget ? "destructive" : "secondary"}
            className="gap-1.5"
            title="Dépense estimée OpenAI sur ce projet / budget"
          >
            <Wallet size={14} />
            {fmtUsd(spendUsd)}
            {budgetUsd != null && (
              <span className="opacity-70">/ {fmtUsd(budgetUsd)}</span>
            )}
          </Badge>
        )}
        <ServerPill server={server} />
        <QuickSettings />
        <Button variant="ghost" size="sm" onClick={onOpenViewer}>
          <Box size={15} /> Visualiseur 3D
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          <Settings size={15} /> Réglages
        </Button>
      </div>
    </header>
  );
}
