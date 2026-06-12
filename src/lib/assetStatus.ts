// Derives the mono/multi image story for an asset: which 3D backend is in play,
// which images feed the 3D stage, and whether the 3D stage can run yet. Pure —
// drives badges, tooltips and pre-run guards in the UI.

import type { Asset, Backend, ServerStatus, StageStatus } from "./types";
import { VIEW_FILES } from "./constants";

export type ImageMode = "mono" | "multi" | "auto";

export interface AssetImagePlan {
  /** Backend after resolving "auto" against the running server when possible. */
  effectiveBackend: Backend;
  /** mono = single image (v21), multi = 4 views (mv2), auto = undecided. */
  mode: ImageMode;
  /** Human label of which image(s) feed the 3D reconstruction. */
  feedsLabel: string;
  /** Non-null when the 3D stage cannot run on its own yet (why). */
  model3dBlocked: string | null;
}

export function planAssetImages(
  asset: Asset,
  multiviewStatus: StageStatus | undefined,
  server: ServerStatus | null,
): AssetImagePlan {
  // Native text-to-3D: the prompt feeds HunyuanDiT inside the mv2 server — there
  // is no image prerequisite, so the 3D stage is never image-blocked.
  if (asset.source === "text") {
    return {
      effectiveBackend: "mv2",
      mode: "auto",
      feedsLabel: "texte (prompt)",
      model3dBlocked: null,
    };
  }

  const multiviewDone = multiviewStatus === "done";
  const sourceManual = asset.source === "manual";
  const hasAnyImage = multiviewDone || sourceManual;

  // Resolve "auto" to the running server backend when one is up.
  let effectiveBackend: Backend = asset.backend;
  if (asset.backend === "auto" && server?.backend) {
    effectiveBackend = server.backend;
  }

  const mode: ImageMode =
    effectiveBackend === "mv2"
      ? "multi"
      : effectiveBackend === "v21"
        ? "mono"
        : "auto";

  let feedsLabel: string;
  let model3dBlocked: string | null = null;

  if (effectiveBackend === "mv2") {
    feedsLabel = VIEW_FILES.join(", ");
    if (!multiviewDone) {
      model3dBlocked = sourceManual
        ? "mv2 a besoin des 4 vues — une source manuelle seule ne suffit pas. Lance d'abord « Multivue »."
        : "mv2 a besoin des 4 vues. Lance d'abord « Multivue ».";
    }
  } else if (effectiveBackend === "v21") {
    feedsLabel = sourceManual ? "image source" : "vue front";
    if (!hasAnyImage) {
      model3dBlocked =
        "Aucune image source. Lance « Multivue » ou importe une image source.";
    }
  } else {
    // auto — undecided until a backend is resolved at run time.
    feedsLabel = multiviewDone
      ? "4 vues (ou source)"
      : sourceManual
        ? "image source"
        : "—";
    if (!hasAnyImage) {
      model3dBlocked =
        "Aucune image source. Lance « Multivue » ou importe une image source.";
    }
  }

  return { effectiveBackend, mode, feedsLabel, model3dBlocked };
}
