import {
  AlertTriangle,
  Box,
  Boxes,
  Columns2,
  Download,
  Loader2,
  Maximize2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import type { Asset, DecimateResult, StageKey, StageState } from "@/lib/types";
import { useConfig, useGenerate, usePaintModel, useSetAssetGen3d } from "@/lib/queries";
import { LazyViewer3D, LazyCompareViewer3D } from "../LazyViewer3D";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** The star of the workbench: the 3D viewer card filling the main column, with
 *  its 4-state body (done / loading / error / idle) and the model-level
 *  controls (texture toggle, paint, compare, enlarge, download). */
export function ModelStage({
  project,
  asset,
  modelUrl,
  rawUrl,
  compare,
  onCompareChange,
  model3dState,
  exportState,
  paint3dState,
  decimateResult,
  prog,
  generatePending,
  jobBusy,
  textured,
  isText,
  onRunStages,
  onEnlarge,
  onDownload,
}: {
  project: string;
  asset: Asset;
  modelUrl: string | null;
  rawUrl: string | null;
  compare: boolean;
  onCompareChange: (v: boolean) => void;
  model3dState: StageState | undefined;
  exportState: StageState | undefined;
  paint3dState: StageState | undefined;
  decimateResult: DecimateResult | null;
  /** Live progress parsed from the Hunyuan log tail (running jobs only). */
  prog: { label: string; pct: number | null } | null;
  generatePending: boolean;
  jobBusy: boolean;
  /** Whether the current model carries a texture (gates the paint button). */
  textured: boolean;
  isText: boolean;
  onRunStages: (s: StageKey[]) => void;
  onEnlarge: (src: string) => void;
  onDownload: () => void;
}) {
  const paintMut = usePaintModel(project);
  const painting = paint3dState?.status === "running" || paintMut.isPending;

  const status = model3dState?.status;
  const modelReady = status === "done";
  const loadingModel =
    status === "queued" ||
    status === "running" ||
    (generatePending && status !== "done" && status !== "error");

  let body: React.ReactNode;
  if (modelReady && modelUrl) {
    body = (
      <div className="absolute inset-0">
        {compare && rawUrl ? (
          <LazyCompareViewer3D
            rawSrc={rawUrl}
            reducedSrc={modelUrl}
            height="100%"
            meta={{
              fidelity: decimateResult?.fidelity,
              fileSizeBefore: decimateResult?.fileSizeBefore,
              fileSizeAfter: decimateResult?.fileSizeAfter,
            }}
          />
        ) : (
          <LazyViewer3D src={modelUrl} height="100%" name={asset.id} />
        )}
      </div>
    );
  } else if (loadingModel) {
    const msg = prog
      ? prog.label
      : status === "running"
        ? "Génération du maillage 3D (serveur Hunyuan)…"
        : status === "queued"
          ? "En file d'attente…"
          : "Génération en cours…";
    body = (
      <>
        <Skeleton className="absolute inset-0 rounded-lg" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8">
          <Loader2 className="size-7 animate-spin text-primary" />
          <span className="text-sm text-run">
            {msg}
            {prog?.pct != null && (
              <span className="ml-1 font-mono text-foreground">{prog.pct}%</span>
            )}
          </span>
          <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full bg-primary transition-all duration-500",
                prog?.pct == null && "w-2/5 animate-pulse",
              )}
              style={prog?.pct != null ? { width: `${prog.pct}%` } : undefined}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            Étapes : texte → image → forme 3D → texture → export
          </span>
        </div>
      </>
    );
  } else if (status === "error") {
    body = (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-destructive/10 p-6 text-center">
        <AlertTriangle className="size-7 text-destructive" />
        <p className="max-w-md text-sm text-destructive">{model3dState?.error}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onRunStages(["model3d", "export"])}
        >
          <RotateCcw className="size-3.5" /> Relancer
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
        <div className="flex size-16 items-center justify-center rounded-lg border border-border bg-card">
          {isText ? (
            <Boxes className="size-7 text-muted-foreground" />
          ) : (
            <Box className="size-7 text-muted-foreground" />
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Aucun modèle encore. Lance la génération.
        </p>
        {isText && (
          <p className="max-w-xs text-xs text-muted-foreground/70">
            Le maillage est généré directement depuis le texte, sans OpenAI.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">Modèle 3D</h3>
        <div className="flex items-center gap-3">
          <TextureToggle
            project={project}
            assetId={asset.id}
            asset={asset}
            exportMeta={exportState?.meta}
            disabled={jobBusy}
          />
          {modelReady && !textured && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => paintMut.mutate({ assetId: asset.id })}
              disabled={painting || jobBusy}
              title="Génère la texture du modèle (passe Hunyuan séparée — le serveur est arrêté le temps du calcul, pour libérer la VRAM)"
            >
              {painting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {painting ? "Texturing…" : "Texturer"}
            </Button>
          )}
          {rawUrl && (
            <Button
              variant={compare ? "secondary" : "ghost"}
              size="xs"
              onClick={() => onCompareChange(!compare)}
              aria-pressed={compare}
              title="Comparer le maillage brut et le maillage réduit côte à côte"
            >
              <Columns2 className="size-3.5" /> Comparer brut / réduit
            </Button>
          )}
        </div>
      </div>

      {(paint3dState?.status === "error" || paintMut.error) && (
        <p className="shrink-0 text-xs text-destructive">
          {paint3dState?.error ?? (paintMut.error as Error)?.message}
        </p>
      )}

      <div className="relative min-h-[280px] flex-1">{body}</div>

      {modelReady && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <ModelMetrics model3d={model3dState} exportState={exportState} />
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => modelUrl && onEnlarge(modelUrl)}
              disabled={!modelUrl}
            >
              <Maximize2 /> Agrandir
            </Button>
            <Button variant="ghost" size="sm" onClick={onDownload}>
              <Download /> Télécharger .glb
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** First-class enable/disable of texture baking on the 3D model. Persists the
 *  per-asset gen3d.texture override (merge-preserving) and re-runs model3d+export
 *  locally — never touches OpenAI. */
function TextureToggle({
  project,
  assetId,
  asset,
  exportMeta,
  disabled,
}: {
  project: string;
  assetId: string;
  asset: Asset;
  exportMeta: Record<string, unknown> | undefined;
  disabled: boolean;
}) {
  const configQ = useConfig();
  const setGen3d = useSetAssetGen3d(project);
  const generate = useGenerate(project);
  const def = configQ.data?.gen3d?.texture ?? true;
  const checked = asset.gen3d?.texture ?? def;
  const baked = exportMeta?.textured as boolean | undefined;
  const diverged = baked !== undefined && baked !== checked;

  function set(next: boolean) {
    if (next === checked) return;
    setGen3d.mutate(
      { assetId, gen3d: { ...(asset.gen3d ?? {}), texture: next } },
      {
        onSuccess: () =>
          generate.mutate(
            { assetId, stages: ["model3d", "export"] },
            {
              onSuccess: () =>
                toast.success(
                  next ? "Régénération avec texture" : "Régénération sans texture",
                ),
            },
          ),
      },
    );
  }

  const busy = disabled || setGen3d.isPending || generate.isPending;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Texture</span>
      <div className="flex rounded-md border border-border bg-secondary/30 p-0.5">
        {([["Avec", true], ["Sans", false]] as const).map(([label, val]) => (
          <button
            key={label}
            type="button"
            disabled={busy}
            onClick={() => set(val)}
            aria-pressed={checked === val}
            className={cn(
              "rounded px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
              checked === val
                ? "bg-primary/15 font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {diverged && (
        <Badge variant="secondary" className="text-run">régénération requise</Badge>
      )}
    </div>
  );
}

/** Compact readout of the generated model's metrics (from the stage metadata). */
function ModelMetrics({
  model3d,
  exportState,
}: {
  model3d: StageState | undefined;
  exportState: StageState | undefined;
}) {
  const backend = model3d?.meta?.backend as string | undefined;
  const seed = model3d?.meta?.seed as number | undefined;
  const faces = exportState?.meta?.faces as number | undefined;
  const textured = exportState?.meta?.textured as boolean | undefined;
  const exportOutput =
    exportState?.status === "done"
      ? (exportState.meta?.output as string | undefined)
      : undefined;

  const items: Array<[string, string]> = [];
  if (backend) items.push(["Backend", backend]);
  if (typeof seed === "number") items.push(["Seed", String(seed)]);
  if (typeof faces === "number")
    items.push(["Faces", faces.toLocaleString("fr-FR")]);
  if (typeof textured === "boolean")
    items.push(["Texture", textured ? "oui" : "non"]);

  if (!items.length && !exportOutput) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([k, v]) => (
        <span key={k}>
          {k} : <span className="font-mono text-foreground">{v}</span>
        </span>
      ))}
      {exportOutput && (
        <span className="flex min-w-0 items-center gap-1" title={exportOutput}>
          OBJ :{" "}
          <code className="max-w-[28ch] truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {exportOutput}
          </code>
        </span>
      )}
    </div>
  );
}
