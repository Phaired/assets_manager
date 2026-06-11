import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AudioLines,
  ExternalLink,
  Link2,
  Loader2,
  Mic2,
  Music,
  Plus,
  Unlink,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";

import type { Asset, AudioItem, AudioKind } from "../lib/types";
import {
  AUDIO_KIND_ACCENT,
  AUDIO_KIND_LABELS,
  AUDIO_STATUS_COLOR,
} from "../lib/constants";
import {
  useAudio,
  useCreateAudioItem,
  useGenerateAudioItem,
  useSetAudioItemAsset,
} from "../lib/queries";
import { projectFileUrl } from "../lib/api";
import { useAppState } from "../lib/appState";
import { AudioPlayer } from "./AudioPlayer";
import { SuggestButton } from "./SuggestButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<AudioKind, React.ReactNode> = {
  voice: <Mic2 size={14} />,
  sfx: <Volume2 size={14} />,
  music: <Music size={14} />,
};

/** One linked audio item: status, inline player when ready, open + unlink. */
function LinkedAudioRow({
  project,
  item,
  onOpen,
  onUnlink,
}: {
  project: string;
  item: AudioItem;
  onOpen: () => void;
  onUnlink: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const accent = AUDIO_KIND_ACCENT[item.kind];

  useEffect(() => {
    let cancelled = false;
    if (item.file && item.status === "done") {
      projectFileUrl(project, item.file).then((u) => {
        if (!cancelled) setSrc(u);
      });
    } else {
      setSrc(null);
    }
    return () => {
      cancelled = true;
    };
  }, [project, item.file, item.status, item.updatedAt]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span style={{ color: accent }} aria-hidden>
          {KIND_ICON[item.kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {item.name}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span
            className={cn("size-1.5 rounded-full", AUDIO_STATUS_COLOR[item.status])}
            aria-hidden
          />
          {item.status}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Ouvrir dans l'onglet Audio"
          onClick={onOpen}
        >
          <ExternalLink size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          title="Délier de cet asset (le son est conservé)"
          onClick={onUnlink}
        >
          <Unlink size={13} />
        </Button>
      </div>
      {src && (
        <AudioPlayer
          key={`${item.id}-${item.updatedAt ?? ""}`}
          src={src}
          accent={accent}
        />
      )}
      {item.status === "error" && item.error && (
        <p className="text-xs text-destructive">{item.error}</p>
      )}
    </div>
  );
}

/** Section « Audio lié » d'un asset : les sons attachés à cet asset, un
 *  mini-formulaire « Générer un son pour cet asset » (prompt pré-rempli depuis
 *  la description + le DNA appliqué côté Rust), et le lien d'items existants. */
export function LinkedAudioSection({
  project,
  asset,
}: {
  project: string;
  asset: Asset;
}) {
  const audioQ = useAudio(project);
  const createItem = useCreateAudioItem(project);
  const generateItem = useGenerateAudioItem(project);
  const setItemAsset = useSetAudioItemAsset(project);
  const { setAudioId } = useAppState();
  const navigate = useNavigate();

  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState<AudioKind>("sfx");
  const [name, setName] = useState("");
  const [text, setText] = useState("");

  const items = audioQ.data?.items ?? [];
  const linked = items.filter((i) => i.assetId === asset.id);
  const linkable = items.filter((i) => !i.assetId && i.kind !== "voice");

  function openForm() {
    setKind("sfx");
    setName(`sfx ${asset.name}`);
    setText(asset.description || asset.name);
    setFormOpen(true);
  }

  function submit() {
    if (!name.trim() || !text.trim()) {
      toast.error("nom et prompt sont requis");
      return;
    }
    createItem.mutate(
      { kind, name: name.trim(), text: text.trim(), assetId: asset.id },
      {
        onSuccess: (item) => {
          setFormOpen(false);
          generateItem.mutate(item.id, {
            onSuccess: () => toast.success("Son en file de génération"),
          });
        },
        onError: (e) => toast.error(String(e)),
      },
    );
  }

  function openInAudio(itemId: string) {
    setAudioId(itemId);
    void navigate({ to: "/audio" });
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <AudioLines size={15} className="text-muted-foreground" />
        Audio lié
        {linked.length > 0 && (
          <span className="text-xs font-normal text-muted-foreground">
            {linked.length}
          </span>
        )}
      </h3>

      {linked.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
          {linked.map((item) => (
            <LinkedAudioRow
              key={item.id}
              project={project}
              item={item}
              onOpen={() => openInAudio(item.id)}
              onUnlink={() =>
                setItemAsset.mutate({ itemId: item.id, assetId: null })
              }
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={openForm}>
          <Plus size={14} /> Générer un son pour cet asset
        </Button>

        {linkable.length > 0 && (
          <Select
            value=""
            onValueChange={(itemId) =>
              setItemAsset.mutate(
                { itemId, assetId: asset.id },
                { onSuccess: () => toast.success("Son lié à l'asset") },
              )
            }
          >
            <SelectTrigger className="h-8 w-[220px] text-xs">
              <Link2 size={13} className="text-muted-foreground" />
              <SelectValue placeholder="Lier un son existant…" />
            </SelectTrigger>
            <SelectContent>
              {linkable.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {AUDIO_KIND_LABELS[i.kind]} · {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {formOpen && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <Select value={kind} onValueChange={(v) => setKind(v as AudioKind)}>
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sfx">Son (SFX)</SelectItem>
                <SelectItem value="music">Musique</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom du son"
              className="h-8 flex-1"
            />
          </div>
          <Textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Décris le son (le DNA audio du projet est appliqué automatiquement)…"
          />
          <div className="flex items-center gap-2">
            <SuggestButton
              project={project}
              assetId={asset.id}
              target={kind === "music" ? "music" : "sfx"}
              onPick={setText}
            />
            <Button
              size="sm"
              onClick={submit}
              disabled={createItem.isPending || generateItem.isPending}
            >
              {(createItem.isPending || generateItem.isPending) && (
                <Loader2 size={14} className="animate-spin" />
              )}
              Créer et générer
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFormOpen(false)}>
              Annuler
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
