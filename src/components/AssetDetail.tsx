import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Wand2,
  RotateCcw,
  Trash2,
  Download,
  Maximize2,
  Loader2,
  Paintbrush,
} from "lucide-react";

import { toast } from "sonner";

import type { Backend, ProjectBundle, StageKey, StageState } from "../lib/types";
import { ALL_STAGES, STAGES } from "../lib/constants";
import {
  useDeleteAsset,
  useGenerate,
  useResetAsset,
  useServer,
  useUpdateAsset,
  useUploadSource,
} from "../lib/queries";
import { planAssetImages } from "../lib/assetStatus";
import { save } from "@tauri-apps/plugin-dialog";
import { assetFileUrl, saveAssetFile } from "../lib/api";
import { StageCard } from "./StageCard";
import { MultiviewGallery } from "./MultiviewGallery";
import { LazyViewer3D } from "./LazyViewer3D";
import { Gen3dPanel } from "./Gen3dPanel";
import { ImageEditDialog } from "./ImageEditDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function AssetDetail({
  project,
  assetId,
  bundle,
  onDeleted,
  onEnlarge,
}: {
  project: string | null;
  assetId: string | null;
  bundle: ProjectBundle | null;
  onDeleted: () => void;
  onEnlarge: (src: string) => void;
}) {
  const generate = useGenerate(project);
  const reset = useResetAsset(project);
  const del = useDeleteAsset(project);
  const upload = useUploadSource(project);
  const updateAsset = useUpdateAsset(project);
  const serverQ = useServer();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const asset = useMemo(
    () => bundle?.project.assets.find((a) => a.id === assetId) ?? null,
    [bundle, assetId],
  );
  const stages: Partial<Record<StageKey, StageState>> =
    (assetId && bundle?.state.assets[assetId]) || {};

  const jobBusy =
    !!bundle?.jobs.current && bundle.jobs.current.assetId === assetId;

  const multiviewState = stages.multiview;
  const model3dState = stages.model3d;
  const exportState = stages.export;

  const modelVer = model3dState?.updatedAt ?? "0";
  const mvVer = multiviewState?.updatedAt ?? "0";

  const modelReady = model3dState?.status === "done";
  // Show the generated views whenever they exist on disk — including after a
  // manual source was later uploaded (the views are still useful context).
  const mvDone = multiviewState?.status === "done";

  // Resolve the local model.glb to a webview URL, cache-busted by updatedAt.
  useEffect(() => {
    let active = true;
    if (!project || !assetId || !modelReady) {
      setModelUrl(null);
      return;
    }
    (async () => {
      try {
        const base = await assetFileUrl(project, assetId, "model.glb");
        if (active) setModelUrl(`${base}?t=${encodeURIComponent(modelVer)}`);
      } catch {
        if (active) setModelUrl(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [project, assetId, modelReady, modelVer]);

  // Real "Save As": native dialog -> Rust-side file copy. An <a download> to the
  // asset protocol does not save in WebView2 (it opened the .glb in Notepad).
  async function downloadGlb() {
    if (!project || !assetId || !asset) return;
    const dest = await save({
      defaultPath: `${asset.id}.glb`,
      filters: [{ name: "glTF binaire", extensions: ["glb"] }],
    });
    if (typeof dest === "string") {
      await saveAssetFile(project, assetId, "model.glb", dest);
    }
  }

  if (!asset || !project || !assetId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
        <div
          className="flex size-20 items-center justify-center rounded-lg border border-border bg-card"
          aria-hidden
        >
          <span className="size-8 rounded-md bg-muted" />
        </div>
        <p className="text-muted-foreground">Sélectionne ou crée un asset.</p>
      </div>
    );
  }

  const plan = planAssetImages(
    asset,
    multiviewState?.status,
    serverQ.data ?? null,
  );

  function runStages(s: StageKey[]) {
    // Guard a standalone 3D run when its image prerequisites aren't met (mv2
    // needs 4 views, v21 needs a source). Running multiview in the same batch is
    // fine — the views will exist by the time model3d runs.
    if (
      s.includes("model3d") &&
      !s.includes("multiview") &&
      plan.model3dBlocked
    ) {
      toast.error(plan.model3dBlocked);
      return;
    }
    generate.mutate(
      { assetId: assetId as string, stages: s },
      { onSuccess: () => toast.success("Génération lancée") },
    );
  }

  async function onUploadFile(file: File | undefined | null) {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    upload.mutate(
      { assetId: assetId as string, bytes: Array.from(buf) },
      { onSuccess: () => toast.success("Image source importée") },
    );
  }

  async function onDelete() {
    if (!window.confirm("Supprimer cet asset et ses fichiers ?")) return;
    await del.mutateAsync(assetId as string);
    toast.success("Asset supprimé");
    onDeleted();
  }

  const exportOutput =
    exportState?.status === "done"
      ? (exportState.meta?.output as string | undefined)
      : undefined;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">
          {asset.name}{" "}
          <span className="font-normal text-muted-foreground">
            · {asset.id}
          </span>
        </h2>
        {asset.description && (
          <p className="text-sm text-muted-foreground">{asset.description}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">Backend</span>
          <Select
            value={asset.backend}
            onValueChange={(v) =>
              updateAsset.mutate(
                { assetId: assetId as string, backend: v as Backend },
                { onSuccess: () => toast.success("Backend mis à jour") },
              )
            }
            disabled={updateAsset.isPending || jobBusy}
          >
            <SelectTrigger className="h-7 w-[185px] text-xs" aria-label="Backend 3D">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Backend : auto</SelectItem>
              <SelectItem value="v21">Hunyuan 2.1 · mono</SelectItem>
              <SelectItem value="mv2">Hunyuan 2mv · 4 vues</SelectItem>
            </SelectContent>
          </Select>
          {asset.backend === "auto" && plan.effectiveBackend !== "auto" && (
            <span className="text-muted-foreground">
              → {plan.effectiveBackend}
            </span>
          )}
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className={cn(
                plan.mode === "multi"
                  ? "text-primary"
                  : plan.mode === "mono"
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {plan.mode === "multi"
                ? "multi-image"
                : plan.mode === "mono"
                  ? "mono-image"
                  : "auto"}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>La 3D utilisera : {plan.feedsLabel}</TooltipContent>
        </Tooltip>

        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">Source</span>
          <Badge variant="secondary" className="font-mono">
            {asset.source}
          </Badge>
        </span>

        <span className="flex-1" />

        <Button
          variant="ghost"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
        >
          {upload.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Upload />
          )}
          Image source manuelle
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onUploadFile(e.target.files?.[0])}
        />

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditOpen(true)}
          disabled={
            asset.source !== "manual" && multiviewState?.status !== "done"
          }
          title="Modifier l'image source via OpenAI (couleur, détails…)"
        >
          <Paintbrush /> Modifier l'image
        </Button>

        <Button
          size="sm"
          onClick={() => runStages(ALL_STAGES)}
          disabled={generate.isPending}
        >
          <Wand2 /> Tout générer
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title="Débloque les étapes coincées en 'en cours'"
          onClick={() => reset.mutate(assetId)}
          disabled={reset.isPending}
        >
          <RotateCcw /> Réinitialiser
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={del.isPending}
        >
          <Trash2 /> Supprimer
        </Button>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {STAGES.map((def) => (
          <StageCard
            key={def.key}
            def={def}
            state={stages[def.key]}
            disabled={jobBusy || generate.isPending}
            blockedReason={
              def.key === "model3d" ? plan.model3dBlocked : undefined
            }
            onRun={() => runStages([def.key])}
          />
        ))}
      </div>

      <Gen3dPanel project={project} asset={asset} />

      {mvDone && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Multivue</h3>
          <MultiviewGallery
            project={project}
            assetId={assetId}
            version={String(mvVer)}
          />
        </section>
      )}

      {modelReady && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Modèle 3D</h3>
          <LazyViewer3D src={modelUrl} height={420} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => modelUrl && onEnlarge(modelUrl)}
              disabled={!modelUrl}
            >
              <Maximize2 /> Agrandir dans le visualiseur
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={downloadGlb}
              disabled={!modelReady}
            >
              <Download /> Télécharger .glb
            </Button>
          </div>
        </section>
      )}

      {exportOutput && (
        <p className="text-sm text-muted-foreground">
          OBJ exporté :{" "}
          <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            {exportOutput}
          </code>
        </p>
      )}

      {editOpen && (
        <ImageEditDialog
          project={project}
          assetId={assetId}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  );
}
