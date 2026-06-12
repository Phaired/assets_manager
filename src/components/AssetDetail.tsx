import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import type {
  DecimateResult,
  ExtraStageKey,
  ProjectBundle,
  StageKey,
  StageState,
} from "../lib/types";
import { stageDefsForKind, stagesForKind } from "../lib/constants";
import { useConfig, useGenerate, useServer, useUploadSource } from "../lib/queries";
import { planAssetImages } from "../lib/assetStatus";
import { save } from "@tauri-apps/plugin-dialog";
import { assetFileUrl, saveAssetFile } from "../lib/api";
import { ImageEditDialog } from "./ImageEditDialog";
import { AssetHeader } from "./asset-detail/AssetHeader";
import { ModelStage } from "./asset-detail/ModelStage";
import { TextureStage } from "./asset-detail/TextureStage";
import { MultiviewStrip } from "./asset-detail/MultiviewStrip";
import { StageStrip } from "./asset-detail/StageStrip";
import { SettingsPanel } from "./asset-detail/SettingsPanel";
import { parseGenProgress } from "./asset-detail/genProgress";
import { useCompactLayout } from "./asset-detail/useCompactLayout";

/** Workbench layout for an asset: header (identity + primary CTA), main column
 *  (viewer star + multiview strip + stage pipeline) and a right settings panel
 *  with tabs (Génération / Décimation / Prompt / Audio). The panel docks when
 *  the content row is wide enough, otherwise it becomes a slide-over. */
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
  const upload = useUploadSource(project);
  const serverQ = useServer();
  const configQ = useConfig();

  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [rawUrl, setRawUrl] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const compact = useCompactLayout(contentEl);

  const asset = useMemo(
    () => bundle?.project.assets.find((a) => a.id === assetId) ?? null,
    [bundle, assetId],
  );
  const stages: Partial<Record<ExtraStageKey, StageState>> =
    (assetId && bundle?.state.assets[assetId]) || {};

  const jobBusy =
    !!bundle?.jobs.current && bundle.jobs.current.assetId === assetId;

  // Profile drives every per-mode difference: text-to-3D hides all image/OpenAI
  // affordances; image keeps upload/multiview; texture is a single-image asset.
  const profile: "text3d" | "image3d" | "texture" =
    asset?.kind === "texture"
      ? "texture"
      : asset?.source === "text"
        ? "text3d"
        : "image3d";
  const isTexture = profile === "texture";
  const isText = profile === "text3d";
  const isImage = profile === "image3d";

  const multiviewState = stages.multiview;
  const model3dState = stages.model3d;
  const exportState = stages.export;
  const textureState = stages.texture;
  const decimateState = stages.decimate;
  const paint3dState = stages.paint3d;

  // model.glb changes on generation AND on re-decimation — cache-bust with the
  // most recent of the two stage timestamps.
  const modelVer =
    [model3dState?.updatedAt, decimateState?.updatedAt, paint3dState?.updatedAt]
      .filter((t): t is string => !!t)
      .sort()
      .pop() ?? "0";
  const mvVer = multiviewState?.updatedAt ?? "0";
  const rawOutput = model3dState?.meta?.rawOutput as string | undefined;
  const decimateResult =
    decimateState?.status === "done"
      ? (decimateState.meta as unknown as DecimateResult)
      : null;

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

  // Raw pre-decimation mesh (for the before/after comparison), when persisted.
  useEffect(() => {
    let active = true;
    if (!project || !assetId || !modelReady || !rawOutput) {
      setRawUrl(null);
      return;
    }
    (async () => {
      try {
        const base = await assetFileUrl(project, assetId, "model_raw.glb");
        if (active) setRawUrl(`${base}?t=${encodeURIComponent(modelVer)}`);
      } catch {
        if (active) setRawUrl(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [project, assetId, modelReady, rawOutput, modelVer]);

  // Leave compare mode when switching assets.
  useEffect(() => {
    setCompare(false);
  }, [assetId]);

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
      <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
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

  // Texture assets have a single image stage — no 3D prerequisites to plan.
  const plan = isTexture
    ? null
    : planAssetImages(asset, multiviewState?.status, serverQ.data ?? null);

  // Texture intent for the decimate tab: the baked truth once exported, else
  // the merged config intent (so an untextured model gates rebake even pre-export).
  // Once a paint pass has succeeded the model carries a texture (so the decimate
  // tab exposes the textured path and the "Texturer" button hides). A later
  // decimate marks paint3d pending again → untextured → button re-appears.
  const decimateTextured =
    paint3dState?.status === "done"
      ? true
      : (exportState?.meta?.textured as boolean | undefined) ??
        (asset.gen3d?.texture ?? configQ.data?.gen3d?.texture ?? true);

  const primaryLabel = modelReady
    ? "Régénérer"
    : isTexture
      ? "Générer la texture"
      : isText
        ? "Générer le modèle 3D"
        : "Tout générer";

  // Live progress parsed from the Hunyuan log tail, surfaced both in the
  // header CTA (%) and the viewer overlay.
  const prog =
    model3dState?.status === "running"
      ? parseGenProgress(serverQ.data?.logTail)
      : null;

  function runStages(s: StageKey[]) {
    // Guard a standalone 3D run when its image prerequisites aren't met (mv2
    // needs 4 views, v21 needs a source). Running multiview in the same batch is
    // fine — the views will exist by the time model3d runs.
    if (
      plan &&
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

  const settingsPanel = (
    <SettingsPanel
      key={assetId}
      project={project}
      asset={asset}
      profile={profile}
      plan={isImage ? plan : null}
      model3dState={model3dState}
      decimateState={decimateState}
      jobBusy={jobBusy}
      textured={decimateTextured}
      onClose={compact ? () => setPanelOpen(false) : undefined}
    />
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <AssetHeader
        project={project}
        asset={asset}
        profile={profile}
        primaryLabel={primaryLabel}
        ctaDisabled={generate.isPending || jobBusy}
        jobRunning={jobBusy}
        progressPct={prog?.pct ?? null}
        onGenerate={() => runStages(stagesForKind(asset.kind, asset.source))}
        onDeleted={onDeleted}
        compact={compact}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />

      <div ref={setContentEl} className="relative flex min-h-0 flex-1">
        {/* Main column — scrolls independently when the window is short. */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="flex min-h-full flex-col gap-3 p-4">
            <div className="min-h-[380px] min-w-0 flex-1">
              {isTexture ? (
                <TextureStage
                  project={project}
                  assetId={assetId}
                  textureState={textureState}
                  generatePending={generate.isPending}
                  onRetry={() => runStages(["texture"])}
                />
              ) : (
                <ModelStage
                  project={project}
                  asset={asset}
                  modelUrl={modelUrl}
                  rawUrl={rawUrl}
                  compare={compare}
                  onCompareChange={setCompare}
                  model3dState={model3dState}
                  exportState={exportState}
                  paint3dState={paint3dState}
                  decimateResult={decimateResult}
                  prog={prog}
                  generatePending={generate.isPending}
                  jobBusy={jobBusy}
                  textured={decimateTextured}
                  isText={isText}
                  onRunStages={runStages}
                  onEnlarge={onEnlarge}
                  onDownload={downloadGlb}
                />
              )}
            </div>

            {isImage && (
              <MultiviewStrip
                project={project}
                assetId={assetId}
                version={String(mvVer)}
                mvDone={mvDone}
                uploadPending={upload.isPending}
                onUpload={onUploadFile}
                editDisabled={asset.source !== "manual" && !mvDone}
                onEditImage={() => setEditOpen(true)}
              />
            )}

            <StageStrip
              defs={stageDefsForKind(asset.kind, asset.source)}
              stages={stages}
              plan={plan}
              disabled={jobBusy || generate.isPending}
              onRun={runStages}
            />
          </div>
        </div>

        {/* Settings panel — docked when wide, slide-over when compact. A div
            (not <aside>): .app-chrome aside carries the entrance animation and
            would replay it on every overlay open. */}
        {!compact && (
          <div
            role="complementary"
            className="flex w-[340px] shrink-0 flex-col border-l border-border bg-card/40"
          >
            {settingsPanel}
          </div>
        )}
        {compact && panelOpen && (
          <>
            <div
              className="absolute inset-0 z-10 bg-black/40"
              onClick={() => setPanelOpen(false)}
              aria-hidden
            />
            <div
              role="complementary"
              className="absolute inset-y-0 right-0 z-20 flex w-[340px] flex-col border-l border-border bg-card shadow-xl"
            >
              {settingsPanel}
            </div>
          </>
        )}
      </div>

      {isImage && editOpen && (
        <ImageEditDialog
          project={project}
          assetId={assetId}
          onClose={() => setEditOpen(false)}
        />
      )}
    </div>
  );
}
