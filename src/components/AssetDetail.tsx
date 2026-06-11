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
  Pencil,
  Check,
  X,
  Copy,
  Tag as TagIcon,
  MessageSquareText,
} from "lucide-react";

import { toast } from "sonner";

import type { Backend, ProjectBundle, StageKey, StageState } from "../lib/types";
import { stageDefsForKind, stagesForKind } from "../lib/constants";
import {
  useDeleteAsset,
  useDuplicateAsset,
  useGenerate,
  useRenameAsset,
  useResetAsset,
  useServer,
  useSetAssetPrompt,
  useSetAssetTags,
  useUpdateAsset,
  useUploadSource,
} from "../lib/queries";
import { planAssetImages } from "../lib/assetStatus";
import { useAppState } from "../lib/appState";
import { save } from "@tauri-apps/plugin-dialog";
import { assetFileUrl, saveAssetFile } from "../lib/api";
import { StageCard } from "./StageCard";
import { LinkedAudioSection } from "./LinkedAudioSection";
import { TexturePreview } from "./TexturePreview";
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
  const rename = useRenameAsset(project);
  const duplicate = useDuplicateAsset(project);
  const setTags = useSetAssetTags(project);
  const setPrompt = useSetAssetPrompt(project);
  const serverQ = useServer();
  const { setAssetId } = useAppState();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");

  const asset = useMemo(
    () => bundle?.project.assets.find((a) => a.id === assetId) ?? null,
    [bundle, assetId],
  );
  const stages: Partial<Record<StageKey, StageState>> =
    (assetId && bundle?.state.assets[assetId]) || {};

  const jobBusy =
    !!bundle?.jobs.current && bundle.jobs.current.assetId === assetId;

  const isTexture = asset?.kind === "texture";
  const multiviewState = stages.multiview;
  const model3dState = stages.model3d;
  const exportState = stages.export;
  const textureState = stages.texture;

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

  // Keep the prompt-override draft in sync with the selected asset.
  useEffect(() => {
    setPromptDraft(asset?.promptOverride ?? "");
    setPromptOpen(!!asset?.promptOverride);
  }, [assetId, asset?.promptOverride]);

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

  // Texture assets have a single image stage — no 3D prerequisites to plan.
  const plan = isTexture
    ? null
    : planAssetImages(asset, multiviewState?.status, serverQ.data ?? null);

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

  async function onDelete() {
    if (!window.confirm("Supprimer cet asset et ses fichiers ?")) return;
    await del.mutateAsync(assetId as string);
    toast.success("Asset supprimé");
    onDeleted();
  }

  function commitRename() {
    setRenaming(false);
    const next = nameDraft.trim();
    if (!asset || !next || next === asset.name) return;
    rename.mutate(
      { assetId: assetId as string, name: next },
      { onSuccess: () => toast.success("Asset renommé") },
    );
  }

  function commitTags(tags: string[]) {
    setTags.mutate({ assetId: assetId as string, tags });
  }

  function addTag() {
    const t = tagDraft.trim();
    setTagDraft("");
    if (!asset || !t || asset.tags.includes(t)) return;
    commitTags([...asset.tags, t]);
  }

  function removeTag(tag: string) {
    if (!asset) return;
    commitTags(asset.tags.filter((t) => t !== tag));
  }

  function commitPrompt() {
    setPrompt.mutate(
      { assetId: assetId as string, prompt: promptDraft },
      { onSuccess: () => toast.success("Prompt enregistré") },
    );
  }

  async function onDuplicate() {
    const created = await duplicate.mutateAsync(assetId as string);
    toast.success("Asset dupliqué");
    setAssetId(created.id);
  }

  const exportOutput =
    exportState?.status === "done"
      ? (exportState.meta?.output as string | undefined)
      : undefined;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        {renaming ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              className="rounded-md border border-border bg-card px-2 py-1 text-lg font-semibold text-foreground outline-none focus:border-primary"
            />
            <span className="font-mono text-xs text-muted-foreground">{asset.id}</span>
          </div>
        ) : (
          <h2 className="group flex items-center gap-2 text-lg font-semibold text-foreground">
            {asset.name}
            <span className="font-normal text-muted-foreground">· {asset.id}</span>
            <button
              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
              title="Renommer"
              onClick={() => {
                setNameDraft(asset.name);
                setRenaming(true);
              }}
            >
              <Pencil size={14} />
            </button>
          </h2>
        )}
        {asset.description && (
          <p className="text-sm text-muted-foreground">{asset.description}</p>
        )}

        {/* Tags */}
        <div className="flex flex-wrap items-center gap-1.5">
          <TagIcon size={13} className="text-muted-foreground" aria-hidden />
          {asset.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-foreground"
            >
              {tag}
              <button
                onClick={() => removeTag(tag)}
                title="Retirer le tag"
                className="text-muted-foreground hover:text-destructive"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
            placeholder="+ tag"
            className="w-20 rounded-full border border-dashed border-border bg-transparent px-2 py-0.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {isTexture ? (
          <Badge variant="outline" className="text-primary">
            texture seamless
          </Badge>
        ) : (
          plan && (
            <>
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
                  <SelectTrigger
                    className="h-7 w-[185px] text-xs"
                    aria-label="Backend 3D"
                  >
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
            </>
          )
        )}

        <span className="flex-1" />

        {!isTexture && (
          <>
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
          </>
        )}

        <Button
          size="sm"
          onClick={() => runStages(stagesForKind(asset.kind))}
          disabled={generate.isPending}
        >
          <Wand2 /> {isTexture ? "Générer" : "Tout générer"}
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
          title="Créer une copie de la configuration (sans les fichiers générés)"
          onClick={onDuplicate}
          disabled={duplicate.isPending}
        >
          {duplicate.isPending ? <Loader2 className="animate-spin" /> : <Copy />}
          Dupliquer
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
        {stageDefsForKind(asset.kind).map((def) => (
          <StageCard
            key={def.key}
            def={def}
            state={stages[def.key]}
            disabled={jobBusy || generate.isPending}
            blockedReason={
              def.key === "model3d" ? plan?.model3dBlocked ?? undefined : undefined
            }
            onRun={() => runStages([def.key])}
          />
        ))}
      </div>

      {!isTexture && <Gen3dPanel project={project} asset={asset} />}

      {/* Per-asset multiview prompt override (replaces the global template). */}
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => setPromptOpen((v) => !v)}
          aria-expanded={promptOpen}
        >
          <MessageSquareText className="size-3.5" />
          {isTexture ? "Prompt texture" : "Prompt multivue"}
          {asset.promptOverride && (
            <Badge variant="secondary" className="ml-1 text-run">
              personnalisé
            </Badge>
          )}
        </Button>
        {promptOpen && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground">
              Remplace le gabarit global pour cet asset. Laisse vide pour revenir
              au gabarit + style du projet.
            </p>
            <textarea
              rows={5}
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              placeholder={
                isTexture
                  ? "Décris précisément la texture seamless à générer…"
                  : "Décris précisément la planche 4 vues à générer…"
              }
              className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-primary"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={commitPrompt}
                disabled={setPrompt.isPending || promptDraft === (asset.promptOverride ?? "")}
              >
                {setPrompt.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Enregistrer
              </Button>
              {asset.promptOverride && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPromptDraft("");
                    setPrompt.mutate({ assetId: assetId as string, prompt: "" });
                  }}
                  disabled={setPrompt.isPending}
                >
                  <RotateCcw className="size-3.5" /> Gabarit par défaut
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {isTexture && textureState?.status === "done" && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">Texture</h3>
          <TexturePreview
            project={project}
            assetId={assetId}
            version={String(textureState.updatedAt ?? "0")}
          />
        </section>
      )}

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
          <LazyViewer3D src={modelUrl} height={420} name={asset.id} />
          <ModelMetrics model3d={model3dState} exportState={exportState} />
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

      <LinkedAudioSection project={project} asset={asset} />

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

  const items: Array<[string, string]> = [];
  if (backend) items.push(["Backend", backend]);
  if (typeof seed === "number") items.push(["Seed", String(seed)]);
  if (typeof faces === "number")
    items.push(["Faces", faces.toLocaleString("fr-FR")]);
  if (typeof textured === "boolean")
    items.push(["Texture", textured ? "oui" : "non"]);

  if (!items.length) return null;

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([k, v]) => (
        <span key={k}>
          {k} :{" "}
          <span className="font-mono text-foreground">{v}</span>
        </span>
      ))}
    </div>
  );
}
