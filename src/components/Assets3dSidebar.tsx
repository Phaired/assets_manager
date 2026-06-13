import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Plus,
  Search,
  ArrowUpDown,
  Image as ImageIcon,
  Boxes,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import type {
  Asset,
  AssetKind,
  ProjectBundle,
  StageKey,
  StageStatus,
} from "../lib/types";
import {
  STAGE_STATUS_COLOR,
  stageDefsForKind,
  stagesForKind,
} from "../lib/constants";
import { useGenerate, useServer } from "../lib/queries";
import { useAppState } from "../lib/appState";
import { planAssetImages } from "../lib/assetStatus";
import { assetFileUrl } from "../lib/api";
import { PackIdeationDialog } from "./PackIdeationDialog";
import { ProjectDnaPanel } from "./ProjectDnaPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type SortKey = "date" | "name" | "status";

function stageStatus(
  bundle: ProjectBundle | null,
  assetId: string,
  stage: string,
): StageStatus {
  return (
    (bundle?.state?.assets?.[assetId]?.[
      stage as keyof (typeof bundle.state.assets)[string]
    ]?.status as StageStatus) ?? "pending"
  );
}

/** Sort rank by aggregate status: active first, then errors, partial, done, idle. */
function statusRank(bundle: ProjectBundle | null, asset: Asset): number {
  const statuses = stagesForKind(asset.kind, asset.source).map((s) =>
    stageStatus(bundle, asset.id, s),
  );
  if (statuses.some((s) => s === "running" || s === "queued")) return 0;
  if (statuses.some((s) => s === "error")) return 1;
  if (statuses.every((s) => s === "done")) return 2;
  if (statuses.some((s) => s === "done")) return 3;
  return 4;
}

/** Small thumbnail once the image stage is done: multiview front.png for model
 *  assets, texture.png for texture assets. */
function AssetThumb({
  project,
  assetId,
  rel,
  ready,
  version,
  fallbackIcon: Fallback = ImageIcon,
}: {
  project: string;
  assetId: string;
  rel: string;
  ready: boolean;
  version: string;
  fallbackIcon?: LucideIcon;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!ready) {
      setUrl(null);
      return;
    }
    assetFileUrl(project, assetId, rel)
      .then((u) => {
        if (active) setUrl(`${u}?t=${encodeURIComponent(version)}`);
      })
      .catch(() => {
        if (active) setUrl(null);
      });
    return () => {
      active = false;
    };
  }, [project, assetId, rel, ready, version]);

  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted">
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : (
        <Fallback size={12} className="text-muted-foreground/50" aria-hidden />
      )}
    </span>
  );
}

/** 3D-section contents of the sidebar: new-asset action, sortable/filterable
 *  asset list, project style. The creation form itself lives in the main pane
 *  (shown when no asset is selected), mirroring the audio section. */
export function Assets3dSidebar({
  bundle,
  loading,
}: {
  bundle: ProjectBundle | null;
  loading: boolean;
}) {
  const { project, assetId, setAssetId } = useAppState();
  const generate = useGenerate(project);
  const serverQ = useServer();
  const assets = bundle?.project.assets ?? [];
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [kindFilter, setKindFilter] = useState<AssetKind | null>(null);

  // Assets with at least one stage not yet done — candidates for "generate all".
  const pendingAssets = useMemo(
    () =>
      assets.filter((a) =>
        stagesForKind(a.kind, a.source).some(
          (s) => stageStatus(bundle, a.id, s) !== "done",
        ),
      ),
    [assets, bundle],
  );

  // Enqueue only the non-done stages per asset (so a finished — and paid —
  // multiview is never re-run).
  function generateAllPending() {
    let count = 0;
    for (const a of pendingAssets) {
      const stages = stagesForKind(a.kind, a.source).filter(
        (s) => stageStatus(bundle, a.id, s) !== "done",
      );
      if (!stages.length) continue;
      generate.mutate({ assetId: a.id, stages });
      count++;
    }
    if (count) toast.success(`${count} asset(s) en file`);
  }

  // Assets ready for 3D model generation: image prerequisites met (not blocked)
  // and the model3d stage not done. Enqueues ONLY model3d + export — never the
  // OpenAI image stages (the multiview is assumed already generated).
  const ready3dAssets = useMemo(
    () =>
      assets.filter((a) => {
        if (a.kind === "texture") return false;
        if (stageStatus(bundle, a.id, "model3d") === "done") return false;
        return (
          planAssetImages(
            a,
            stageStatus(bundle, a.id, "multiview"),
            serverQ.data ?? null,
          ).model3dBlocked === null
        );
      }),
    [assets, bundle, serverQ.data],
  );

  function generate3dReady() {
    let count = 0;
    for (const a of ready3dAssets) {
      const stages = (["model3d", "export"] as StageKey[]).filter(
        (s) => stageStatus(bundle, a.id, s) !== "done",
      );
      if (!stages.length) continue;
      generate.mutate({ assetId: a.id, stages });
      count++;
    }
    if (count) toast.success(`${count} modèle(s) en file`);
  }

  // All distinct tags across the project's assets (for the filter chips).
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const a of assets) for (const t of a.tags) set.add(t);
    return Array.from(set).sort((x, y) => x.localeCompare(y));
  }, [assets]);

  function toggleTag(tag: string) {
    setActiveTags((cur) =>
      cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag],
    );
  }

  const needle = filter.trim().toLowerCase();
  const hasTextures = assets.some((a) => a.kind === "texture");
  const visible = useMemo(() => {
    let out: Asset[] = assets.filter((a) => {
      if (needle && !a.name.toLowerCase().includes(needle)) return false;
      if (kindFilter && a.kind !== kindFilter) return false;
      // OR semantics: keep assets carrying at least one selected tag.
      if (activeTags.length && !a.tags.some((t) => activeTags.includes(t)))
        return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "status")
        return statusRank(bundle, a) - statusRank(bundle, b);
      // date (newest first)
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
    return out;
  }, [assets, needle, kindFilter, activeTags, sort, bundle]);

  return (
    <>
      <Button
        size="sm"
        className="w-full"
        disabled={!project}
        onClick={() => setAssetId(null)}
        title="Créer un nouvel asset"
      >
        <Plus size={14} /> Nouvel asset
      </Button>

      <div className="flex min-h-0 grow flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">Assets</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {needle || activeTags.length || kindFilter
                ? `${visible.length}/${assets.length}`
                : assets.length}
            </span>
            {ready3dAssets.length > 0 && (
              <Button
                size="xs"
                variant="ghost"
                onClick={generate3dReady}
                disabled={generate.isPending}
                title="Lance la 3D (model3d + export) pour tous les assets prêts dont le modèle n'est pas fait — n'utilise pas l'API images."
              >
                <Boxes size={13} /> 3D ({ready3dAssets.length})
              </Button>
            )}
            {pendingAssets.length > 0 && (
              <Button
                size="xs"
                variant="ghost"
                onClick={generateAllPending}
                disabled={generate.isPending}
                title="Lance les étapes manquantes de tous les assets non terminés (multivue OpenAI incluse)"
              >
                <Wand2 size={13} /> Tout ({pendingAssets.length})
              </Button>
            )}
          </div>
        </div>

        {assets.length > 1 && (
          <div className="flex items-center gap-2">
            {assets.length > 5 && (
              <div className="relative flex-1">
                <Search
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filtrer…"
                  aria-label="Filtrer les assets"
                  className="h-8 pl-8"
                />
              </div>
            )}
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger
                className="h-8 w-[110px] text-xs"
                aria-label="Trier les assets"
              >
                <ArrowUpDown size={13} className="text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Date</SelectItem>
                <SelectItem value="name">Nom</SelectItem>
                <SelectItem value="status">Statut</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {hasTextures && (
          <div className="flex gap-1">
            {(
              [
                ["model", "3D"],
                ["texture", "Textures"],
              ] as Array<[AssetKind, string]>
            ).map(([k, label]) => {
              const on = kindFilter === k;
              return (
                <button
                  key={k}
                  onClick={() => setKindFilter(on ? null : k)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                  aria-pressed={on}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {allTags.map((tag) => {
              const on = activeTags.includes(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs transition-colors",
                    on
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                  aria-pressed={on}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto">
          {loading && !bundle && (
            <div className="flex flex-col gap-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {!loading && !project && (
            <p className="px-1 py-2 text-sm text-muted-foreground">Aucun projet.</p>
          )}
          {project && !assets.length && (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              Aucun asset pour l'instant.
            </div>
          )}
          {project && assets.length > 0 && !visible.length && (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              Aucun asset ne correspond.
            </p>
          )}
          {visible.map((a) => {
            const active = a.id === assetId;
            const isTexture = a.kind === "texture";
            const isText = a.source === "text";
            const thumbStage = isTexture ? "texture" : "multiview";
            const thumbDone = stageStatus(bundle, a.id, thumbStage) === "done";
            const thumbVer =
              bundle?.state?.assets?.[a.id]?.[thumbStage]?.updatedAt ?? "0";
            return (
              <button
                key={a.id}
                className={cn(
                  "relative flex items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-foreground hover:bg-muted",
                )}
                onClick={() => setAssetId(a.id)}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px] bg-primary"
                  />
                )}
                <AssetThumb
                  project={project as string}
                  assetId={a.id}
                  rel={isTexture ? "texture.png" : "multiview/front.png"}
                  ready={thumbDone}
                  version={String(thumbVer)}
                  fallbackIcon={isText ? Boxes : undefined}
                />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="flex shrink-0 items-center gap-1" aria-hidden>
                  {stageDefsForKind(a.kind, a.source).map((s) => {
                    const status = stageStatus(bundle, a.id, s.key);
                    return (
                      <span
                        key={s.key}
                        className={cn("size-2 rounded-full", STAGE_STATUS_COLOR[status])}
                        title={`${s.label}: ${status}`}
                      />
                    );
                  })}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {project && bundle && (
        <>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Projet
            </span>
            <PackIdeationDialog project={project} />
            <ProjectDnaPanel projectName={project} project={bundle.project} />
          </div>
        </>
      )}
    </>
  );
}
