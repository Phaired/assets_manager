import { useEffect, useState } from "react";
import { Download, Grid3x3, Square } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { assetFileUrl, saveAssetFile } from "../lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Preview of a generated seamless texture: single view or CSS tiling (repeat)
 *  with a scale slider — the tiling mode makes any visible seam obvious. */
export function TexturePreview({
  project,
  assetId,
  version,
}: {
  project: string;
  assetId: string;
  version: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [tiling, setTiling] = useState(true);
  // Tile size in px when tiling (smaller = more repetitions visible).
  const [scale, setScale] = useState(128);

  useEffect(() => {
    let active = true;
    assetFileUrl(project, assetId, "texture.png")
      .then((u) => {
        if (active) setUrl(`${u}?t=${encodeURIComponent(version)}`);
      })
      .catch(() => {
        if (active) setUrl(null);
      });
    return () => {
      active = false;
    };
  }, [project, assetId, version]);

  async function exportPng() {
    const dest = await save({
      defaultPath: `${assetId}.png`,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (typeof dest === "string") {
      await saveAssetFile(project, assetId, "texture.png", dest);
      toast.success("Texture exportée");
    }
  }

  if (!url) return null;

  return (
    <div className="flex flex-col gap-3">
      <div
        className="h-[420px] w-full overflow-hidden rounded-lg border border-border bg-muted"
        style={
          tiling
            ? {
                backgroundImage: `url("${url}")`,
                backgroundRepeat: "repeat",
                backgroundSize: `${scale}px ${scale}px`,
              }
            : undefined
        }
      >
        {!tiling && (
          <img
            src={url}
            alt="texture générée"
            className="size-full object-contain"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-border bg-secondary/30 p-1">
          <button
            type="button"
            onClick={() => setTiling(false)}
            aria-pressed={!tiling}
            title="Vue simple"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              !tiling
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Square size={13} /> 1×
          </button>
          <button
            type="button"
            onClick={() => setTiling(true)}
            aria-pressed={tiling}
            title="Aperçu en tiling (répétition) — les coutures sautent aux yeux"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
              tiling
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Grid3x3 size={13} /> Tiling
          </button>
        </div>

        {tiling && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Échelle
            <input
              type="range"
              min={48}
              max={512}
              step={8}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              className="w-36 accent-primary"
            />
            <span className="w-12 font-mono">{scale}px</span>
          </label>
        )}

        <span className="flex-1" />

        <Button variant="ghost" size="sm" onClick={exportPng}>
          <Download size={14} /> Exporter .png
        </Button>
      </div>
    </div>
  );
}
