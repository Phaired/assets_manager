import { useState } from "react";
import { Plus, Mic2, Music, Volume2, Settings2, Search } from "lucide-react";

import type { AudioItem } from "../lib/types";
import { AUDIO_KIND_ACCENT, AUDIO_STATUS_COLOR } from "../lib/constants";
import { useAudio } from "../lib/queries";
import { useAppState } from "../lib/appState";
import { VoicesManager } from "./VoicesManager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<AudioItem["kind"], React.ReactNode> = {
  voice: <Mic2 size={13} />,
  sfx: <Volume2 size={13} />,
  music: <Music size={13} />,
};

/** Audio-section contents of the sidebar: item list + new/voices actions. */
export function AudioSidebar() {
  const { project, audioId, setAudioId } = useAppState();
  const audioQ = useAudio(project);
  const items = audioQ.data?.items ?? [];
  const [voicesOpen, setVoicesOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? items.filter((it) => it.name.toLowerCase().includes(needle))
    : items;

  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="flex-1"
          disabled={!project}
          onClick={() => setAudioId(null)}
          title="Créer un nouvel audio"
        >
          <Plus size={14} /> Nouvel audio
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setVoicesOpen(true)}
          title="Gérer les voix (catalogue)"
        >
          <Settings2 size={14} /> Voix
        </Button>
      </div>

      <div className="flex min-h-0 grow flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">Audios</span>
          <span className="text-xs text-muted-foreground">
            {needle ? `${visible.length}/${items.length}` : items.length}
          </span>
        </div>

        {items.length > 5 && (
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrer…"
              aria-label="Filtrer les audios"
              className="h-8 pl-8"
            />
          </div>
        )}

        <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto">
          {audioQ.isLoading && !audioQ.data && (
            <div className="flex flex-col gap-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
          {!project && (
            <p className="px-1 py-2 text-sm text-muted-foreground">Aucun projet.</p>
          )}
          {project && !items.length && (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              Aucun audio pour l'instant.
            </div>
          )}
          {project && items.length > 0 && !visible.length && (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              Aucun audio ne correspond.
            </p>
          )}
          {visible.map((it) => {
            const active = it.id === audioId;
            return (
              <button
                key={it.id}
                className={cn(
                  "relative flex items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-left text-sm transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-foreground hover:bg-muted",
                )}
                onClick={() => setAudioId(it.id)}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px] bg-primary"
                  />
                )}
                <span
                  className="grid size-6 shrink-0 place-items-center rounded-md"
                  style={{
                    color: AUDIO_KIND_ACCENT[it.kind],
                    background: `color-mix(in srgb, ${AUDIO_KIND_ACCENT[it.kind]} 14%, transparent)`,
                  }}
                  aria-hidden
                >
                  {KIND_ICON[it.kind]}
                </span>
                <span className="truncate">{it.name}</span>
                <span
                  className={cn(
                    "ml-auto size-2 shrink-0 rounded-full",
                    AUDIO_STATUS_COLOR[it.status],
                  )}
                  title={it.status}
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
      </div>

      {voicesOpen && <VoicesManager onClose={() => setVoicesOpen(false)} />}
    </>
  );
}
