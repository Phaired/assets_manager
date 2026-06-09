import { useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  Wand2,
  RotateCcw,
  Trash2,
  Download,
  Maximize2,
  Loader2,
} from "lucide-react";

import type { ProjectBundle, StageKey, StageState } from "../lib/types";
import { ALL_STAGES, STAGES } from "../lib/constants";
import {
  useDeleteAsset,
  useGenerate,
  useResetAsset,
  useUploadSource,
} from "../lib/queries";
import { assetFileUrl } from "../lib/api";
import { StageCard } from "./StageCard";
import { MultiviewGallery } from "./MultiviewGallery";
import { Viewer3D } from "./Viewer3D";

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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(null);

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
  const mvDone =
    multiviewState?.status === "done" && asset?.source !== "manual";

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

  if (!asset || !project || !assetId) {
    return (
      <div className="empty-detail">
        <div className="empty-art" aria-hidden>
          <span className="empty-cube" />
        </div>
        <p className="muted">Sélectionne ou crée un asset.</p>
      </div>
    );
  }

  function runStages(s: StageKey[]) {
    generate.mutate({ assetId: assetId as string, stages: s });
  }

  async function onUploadFile(file: File | undefined | null) {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    upload.mutate({ assetId: assetId as string, bytes: Array.from(buf) });
  }

  async function onDelete() {
    if (!window.confirm("Supprimer cet asset et ses fichiers ?")) return;
    await del.mutateAsync(assetId as string);
    onDeleted();
  }

  const exportOutput =
    exportState?.status === "done"
      ? (exportState.meta?.output as string | undefined)
      : undefined;

  return (
    <div className="asset-detail">
      <div className="detail-header">
        <h2>
          {asset.name} <span className="muted">· {asset.id}</span>
        </h2>
        {asset.description && (
          <p className="muted detail-desc">{asset.description}</p>
        )}
      </div>

      <div className="action-row">
        <span className="meta-chip">
          <span className="meta-chip-label">Backend</span>
          <span className="pill pill-stopped">{asset.backend}</span>
        </span>
        <span className="meta-chip">
          <span className="meta-chip-label">Source</span>
          <span className="pill pill-stopped">{asset.source}</span>
        </span>

        <span className="action-spacer" />

        <button
          className="btn ghost sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
        >
          {upload.isPending ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <Upload size={14} />
          )}
          Image source manuelle
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onUploadFile(e.target.files?.[0])}
        />

        <button
          className="btn primary sm"
          onClick={() => runStages(ALL_STAGES)}
          disabled={generate.isPending}
        >
          <Wand2 size={14} /> Tout générer
        </button>
        <button
          className="btn ghost sm"
          title="Débloque les étapes coincées en 'en cours'"
          onClick={() => reset.mutate(assetId)}
          disabled={reset.isPending}
        >
          <RotateCcw size={14} /> Réinitialiser
        </button>
        <button
          className="btn ghost sm danger"
          onClick={onDelete}
          disabled={del.isPending}
        >
          <Trash2 size={14} /> Supprimer
        </button>
      </div>

      <div className="stage-grid">
        {STAGES.map((def) => (
          <StageCard
            key={def.key}
            def={def}
            state={stages[def.key]}
            disabled={jobBusy || generate.isPending}
            onRun={() => runStages([def.key])}
          />
        ))}
      </div>

      {mvDone && (
        <section className="detail-section">
          <h3 className="section-title">Multivue</h3>
          <MultiviewGallery
            project={project}
            assetId={assetId}
            version={String(mvVer)}
          />
        </section>
      )}

      {modelReady && (
        <section className="detail-section">
          <h3 className="section-title">Modèle 3D</h3>
          <Viewer3D src={modelUrl} height={420} />
          <div className="row viewer-actions">
            <button
              className="btn ghost sm"
              onClick={() => modelUrl && onEnlarge(modelUrl)}
              disabled={!modelUrl}
            >
              <Maximize2 size={14} /> Agrandir dans le visualiseur
            </button>
            {modelUrl && (
              <a
                className="btn ghost sm btnlink"
                href={modelUrl}
                download={`${asset.id}.glb`}
              >
                <Download size={14} /> Télécharger .glb
              </a>
            )}
          </div>
        </section>
      )}

      {exportOutput && (
        <p className="muted export-line">
          OBJ exporté : <code>{exportOutput}</code>
        </p>
      )}
    </div>
  );
}
