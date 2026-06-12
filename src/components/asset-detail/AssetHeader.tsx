import { useState } from "react";
import {
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SlidersHorizontal,
  Tag as TagIcon,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { Asset } from "@/lib/types";
import {
  useDeleteAsset,
  useDuplicateAsset,
  useRenameAsset,
  useResetAsset,
  useSetAssetTags,
} from "@/lib/queries";
import { useAppState } from "@/lib/appState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Workbench top bar: identity (rename, tags), profile badge, and THE primary
 *  CTA — the single obvious "generate" entry point of the page. */
export function AssetHeader({
  project,
  asset,
  profile,
  primaryLabel,
  ctaDisabled,
  jobRunning,
  progressPct,
  onGenerate,
  onDeleted,
  compact,
  panelOpen,
  onTogglePanel,
}: {
  project: string;
  asset: Asset;
  profile: "text3d" | "image3d" | "texture";
  primaryLabel: string;
  ctaDisabled: boolean;
  jobRunning: boolean;
  progressPct: number | null;
  onGenerate: () => void;
  onDeleted: () => void;
  compact: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const reset = useResetAsset(project);
  const del = useDeleteAsset(project);
  const rename = useRenameAsset(project);
  const duplicate = useDuplicateAsset(project);
  const setTags = useSetAssetTags(project);
  const { setAssetId } = useAppState();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");

  function commitRename() {
    setRenaming(false);
    const next = nameDraft.trim();
    if (!next || next === asset.name) return;
    rename.mutate(
      { assetId: asset.id, name: next },
      { onSuccess: () => toast.success("Asset renommé") },
    );
  }

  function commitTags(tags: string[]) {
    setTags.mutate({ assetId: asset.id, tags });
  }

  function addTag() {
    const t = tagDraft.trim();
    setTagDraft("");
    if (!t || asset.tags.includes(t)) return;
    commitTags([...asset.tags, t]);
  }

  async function onDelete() {
    if (!window.confirm("Supprimer cet asset et ses fichiers ?")) return;
    await del.mutateAsync(asset.id);
    toast.success("Asset supprimé");
    onDeleted();
  }

  async function onDuplicate() {
    const created = await duplicate.mutateAsync(asset.id);
    toast.success("Asset dupliqué");
    setAssetId(created.id);
  }

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-2">
        {renaming ? (
          <div className="flex min-w-0 items-center gap-2">
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
          <h2 className="group flex min-w-0 items-center gap-2 text-lg font-semibold text-foreground">
            <span className="truncate">{asset.name}</span>
            <span className="shrink-0 font-normal text-muted-foreground">· {asset.id}</span>
            <button
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
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

        <span className="flex-1" />

        {profile === "text3d" && (
          <Badge variant="outline" className="shrink-0 text-primary">
            Text-to-3D · hors-ligne
          </Badge>
        )}
        {profile === "texture" && (
          <Badge variant="outline" className="shrink-0 text-primary">
            Texture seamless
          </Badge>
        )}

        <Button onClick={onGenerate} disabled={ctaDisabled} className="shrink-0">
          {jobRunning ? <Loader2 className="animate-spin" /> : <Wand2 />}
          {primaryLabel}
          {jobRunning && progressPct != null && (
            <span className="font-mono text-xs opacity-80">{progressPct}%</span>
          )}
        </Button>

        {compact && (
          <Button
            variant={panelOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Réglages de génération"
            aria-pressed={panelOpen}
            title="Réglages de génération"
            onClick={onTogglePanel}
            className="shrink-0"
          >
            <SlidersHorizontal size={16} />
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Actions" className="shrink-0">
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => reset.mutate(asset.id)}
              disabled={reset.isPending}
            >
              <RotateCcw size={14} /> Réinitialiser
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate} disabled={duplicate.isPending}>
              <Copy size={14} /> Dupliquer
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              disabled={del.isPending}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 size={14} /> Supprimer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {asset.description && (
          <p
            className="min-w-0 max-w-[60ch] truncate text-sm text-muted-foreground"
            title={asset.description}
          >
            {asset.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <TagIcon size={13} className="text-muted-foreground" aria-hidden />
          {asset.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-foreground"
            >
              {tag}
              <button
                onClick={() => commitTags(asset.tags.filter((t) => t !== tag))}
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
    </div>
  );
}
