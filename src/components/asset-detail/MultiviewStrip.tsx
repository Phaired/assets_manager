import { useEffect, useRef, useState } from "react";
import { ImageIcon, Loader2, Paintbrush, Upload } from "lucide-react";

import { VIEW_FILES } from "@/lib/constants";
import { assetFileUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

/** Compact horizontal multiview strip (front/back/left/right): thumbnails with
 *  click-to-enlarge, plus the source-image affordances (manual upload, OpenAI
 *  edit). Rendered before generation too — empty slots show what's coming. */
export function MultiviewStrip({
  project,
  assetId,
  version,
  mvDone,
  uploadPending,
  onUpload,
  editDisabled,
  onEditImage,
}: {
  project: string;
  assetId: string;
  /** Cache-bust token tied to the multiview stage updatedAt. */
  version: string;
  mvDone: boolean;
  uploadPending: boolean;
  onUpload: (file: File | undefined | null) => void;
  editDisabled: boolean;
  onEditImage: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!mvDone) {
      setUrls({});
      return;
    }
    (async () => {
      const entries = await Promise.all(
        VIEW_FILES.map(async (v) => {
          try {
            const base = await assetFileUrl(project, assetId, `multiview/${v}.png`);
            return [v, `${base}?t=${encodeURIComponent(version)}`] as const;
          } catch {
            return [v, ""] as const;
          }
        }),
      );
      if (active) setUrls(Object.fromEntries(entries));
    })();
    return () => {
      active = false;
    };
  }, [project, assetId, version, mvDone]);

  return (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Multivue
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadPending}
        >
          {uploadPending ? <Loader2 className="animate-spin" /> : <Upload />}
          Image source manuelle
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onUpload(e.target.files?.[0])}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={onEditImage}
          disabled={editDisabled}
          title="Modifier l'image source via OpenAI (couleur, détails…)"
        >
          <Paintbrush /> Modifier l'image
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {VIEW_FILES.map((v) => (
          <figure key={v} className="flex flex-col gap-1">
            <div className="size-24 overflow-hidden rounded-md border border-border bg-muted">
              {mvDone && urls[v] ? (
                <button
                  type="button"
                  className="size-full"
                  onClick={() => setLightbox(v)}
                  title="Agrandir"
                >
                  <img
                    src={urls[v]}
                    alt={v}
                    loading="lazy"
                    className="size-full object-cover transition-transform duration-200 hover:scale-105"
                  />
                </button>
              ) : mvDone ? (
                <Skeleton className="size-full rounded-none" />
              ) : (
                <div className="flex size-full items-center justify-center border border-dashed border-border/0">
                  <ImageIcon className="size-5 text-muted-foreground/40" />
                </div>
              )}
            </div>
            <figcaption className="text-center text-xs text-muted-foreground">
              {v}
            </figcaption>
          </figure>
        ))}
      </div>

      <Dialog open={lightbox != null} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent className="max-w-[80vw] sm:max-w-[80vw]">
          <DialogTitle className="text-sm font-medium text-muted-foreground">
            Vue {lightbox}
          </DialogTitle>
          {lightbox && urls[lightbox] && (
            <img
              src={urls[lightbox]}
              alt={lightbox}
              className="max-h-[75vh] w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
