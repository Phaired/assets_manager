import { AlertTriangle, Box, Loader2, RotateCcw } from "lucide-react";

import type { StageState } from "@/lib/types";
import { TexturePreview } from "../TexturePreview";
import { Button } from "@/components/ui/button";

/** Texture-kind equivalent of ModelStage: the seamless-texture preview filling
 *  the main column, with the same 4-state body. */
export function TextureStage({
  project,
  assetId,
  textureState,
  generatePending,
  onRetry,
}: {
  project: string;
  assetId: string;
  textureState: StageState | undefined;
  generatePending: boolean;
  onRetry: () => void;
}) {
  const status = textureState?.status;

  let body: React.ReactNode;
  if (status === "done") {
    body = (
      <TexturePreview
        project={project}
        assetId={assetId}
        version={String(textureState?.updatedAt ?? "0")}
        fill
      />
    );
  } else if (status === "running" || status === "queued" || generatePending) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Loader2 className="size-7 animate-spin text-primary" />
        <span className="text-sm text-run">Génération de la texture…</span>
      </div>
    );
  } else if (status === "error") {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg bg-destructive/10 p-6 text-center">
        <AlertTriangle className="size-7 text-destructive" />
        <p className="max-w-md text-sm text-destructive">{textureState?.error}</p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCcw className="size-3.5" /> Relancer
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-16 items-center justify-center rounded-lg border border-border bg-card">
          <Box className="size-7 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">
          Aucune texture encore. Lance la génération.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h3 className="shrink-0 text-sm font-semibold text-foreground">Texture</h3>
      <div className="relative min-h-[280px] min-w-0 flex-1">{body}</div>
    </div>
  );
}
