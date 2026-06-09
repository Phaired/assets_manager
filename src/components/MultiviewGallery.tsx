import { useEffect, useState } from "react";

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
    <div className="views">
      {VIEW_FILES.map((v) => (
        <figure key={v}>
          {urls[v] ? (
            <img src={urls[v]} alt={v} loading="lazy" />
          ) : (
            <div className="view-skeleton" />
          )}
          <figcaption>{v}</figcaption>
        </figure>
      ))}
    </div>
  );
}
