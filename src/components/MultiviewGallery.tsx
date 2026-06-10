import { useEffect, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { VIEW_FILES } from "../lib/constants";
import { assetFileUrl } from "../lib/api";

/**
 * 4-view gallery (front/back/left/right). Resolves each PNG to a webview URL via
 * convertFileSrc(asset_file_src(...)). `version` is a cache-bust token tied to
 * the multiview stage updatedAt so we only re-resolve when the artifact changes.
 */
export function MultiviewGallery({
  project,
  assetId,
  version,
}: {
  project: string;
  assetId: string;
  version: string;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    (async () => {
      const entries = await Promise.all(
        VIEW_FILES.map(async (v) => {
          try {
            const base = await assetFileUrl(
              project,
              assetId,
              `multiview/${v}.png`,
            );
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
  }, [project, assetId, version]);

  return (
    <div className="grid grid-cols-4 gap-3">
      {VIEW_FILES.map((v) => (
        <figure key={v} className="flex flex-col gap-1.5">
          <div className="aspect-square overflow-hidden rounded-md border border-border bg-muted">
            {urls[v] ? (
              <img
                src={urls[v]}
                alt={v}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-200 hover:scale-105"
              />
            ) : (
              <Skeleton className="h-full w-full rounded-none" />
            )}
          </div>
          <figcaption className="text-center text-xs text-muted-foreground">
            {v}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
