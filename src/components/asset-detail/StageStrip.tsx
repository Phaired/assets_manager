import { Fragment } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";

import type { ExtraStageKey, StageKey, StageState, StageStatus } from "@/lib/types";
import type { StageDef } from "@/lib/constants";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const DOT_COLOR: Record<StageStatus, string> = {
  pending: "bg-muted-foreground/40",
  queued: "bg-run",
  running: "bg-run animate-pulse",
  done: "bg-ok",
  error: "bg-destructive",
};

/** Horizontal status pipeline under the viewer: a dot per stage, hover to
 *  re-run a single stage. Quieter chrome than a card — it's a readout, not a
 *  primary control surface. */
export function StageStrip({
  defs,
  stages,
  plan,
  disabled,
  onRun,
}: {
  defs: StageDef[];
  stages: Partial<Record<ExtraStageKey, StageState>>;
  plan: { model3dBlocked: string | null } | null;
  disabled: boolean;
  onRun: (s: StageKey[]) => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg bg-card/40 px-3 py-2">
      {defs.map((def, i) => {
        const st = stages[def.key];
        const status = st?.status ?? "pending";
        const blocked =
          def.key === "model3d" ? plan?.model3dBlocked ?? undefined : undefined;
        return (
          <Fragment key={def.key}>
            {i > 0 && <ChevronRight className="size-3 text-muted-foreground/40" />}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="group flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", DOT_COLOR[status])} />
                  <span className="text-xs text-foreground">{def.label}</span>
                  {status === "running" && (
                    <span className="text-xs text-run">{def.eta}</span>
                  )}
                  <button
                    onClick={() => !blocked && onRun([def.key])}
                    disabled={disabled || !!blocked}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 disabled:opacity-30"
                    title="Relancer cette étape"
                  >
                    <RotateCcw className="size-3" />
                  </button>
                </div>
              </TooltipTrigger>
              <TooltipContent>{blocked ?? def.hint}</TooltipContent>
            </Tooltip>
          </Fragment>
        );
      })}
    </div>
  );
}
