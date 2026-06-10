import { useEffect, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Trash2,
  Download,
  AlertTriangle,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { Mic2, Music, Volume2 } from "lucide-react";

import type { AudioItem } from "../lib/types";
import {
  AUDIO_KIND_ACCENT,
  AUDIO_KIND_LABELS,
  AUDIO_STATUS_COLOR,
} from "../lib/constants";
import {
  useVoices,
  useGenerateAudioItem,
  useDeleteAudioItem,
} from "../lib/queries";
import { projectFileUrl, saveProjectFile } from "../lib/api";
import { AudioPlayer } from "./AudioPlayer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<AudioItem["kind"], React.ReactNode> = {
  voice: <Mic2 size={18} />,
  sfx: <Volume2 size={18} />,
  music: <Music size={18} />,
};

export function AudioItemDetail({
  project,
  item,
  onDeleted,
}: {
  project: string;
  item: AudioItem;
  onDeleted: () => void;
}) {
  const generate = useGenerateAudioItem(project);
  const del = useDeleteAudioItem(project);
  const voicesQ = useVoices();
  const [src, setSrc] = useState<string | null>(null);

  const voiceName =
    item.kind === "voice"
      ? voicesQ.data?.find((v) => v.voiceId === item.voiceId)?.name ?? item.voiceId
      : null;

  // Resolve the generated mp3 to a webview-loadable URL.
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

  async function download() {
    if (!item.file) return;
    const dest = await save({
      defaultPath: `${item.id}.mp3`,
      filters: [{ name: "MP3", extensions: ["mp3"] }],
    });
    if (typeof dest === "string") {
      await saveProjectFile(project, item.file, dest);
      toast.success("Audio enregistré");
    }
  }

  const busy = item.status === "running" || item.status === "queued";
  const accent = AUDIO_KIND_ACCENT[item.kind];

  return (
    <div className="flex flex-col gap-5 p-6 animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid size-11 shrink-0 place-items-center rounded-xl"
            style={{
              color: accent,
              background: `color-mix(in srgb, ${accent} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            }}
            aria-hidden
          >
            {KIND_ICON[item.kind]}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-lg font-semibold leading-tight">
              {item.name}
            </h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{AUDIO_KIND_LABELS[item.kind]}</Badge>
              {voiceName && <span>voix : {voiceName}</span>}
              <span className="flex items-center gap-1">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    AUDIO_STATUS_COLOR[item.status],
                  )}
                  aria-hidden
                />
                {item.status}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            onClick={() => generate.mutate(item.id)}
            disabled={busy || generate.isPending}
            title="Régénérer"
          >
            {busy || generate.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Régénérer
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={download}
            disabled={!src}
            title="Télécharger le mp3"
          >
            <Download size={14} /> Télécharger
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive"
            onClick={() => {
              del.mutate(item.id, { onSuccess: onDeleted });
            }}
            disabled={del.isPending}
            title="Supprimer"
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </div>

      {/* Player */}
      {item.status === "error" ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle size={15} /> {item.error ?? "échec de la génération"}
          </p>
        </div>
      ) : busy ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Génération en cours…
          </p>
        </div>
      ) : src ? (
        <AudioPlayer key={`${item.id}-${item.updatedAt ?? ""}`} src={src} accent={accent} />
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            Pas encore généré — clique sur « Régénérer ».
          </p>
        </div>
      )}

      {/* Prompt / text */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {item.kind === "voice" ? "Texte" : "Prompt"}
        </span>
        <p className="rounded-md border border-border bg-card px-3 py-2 text-sm whitespace-pre-wrap">
          {item.text}
        </p>
      </div>
    </div>
  );
}
