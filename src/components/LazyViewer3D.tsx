import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

// Code-split the heavy 3D stack (three + @react-three/fiber + @react-three/drei,
// ~1.5 MB). Importing Viewer3D statically pulled all of it into the entry chunk,
// which was parsed at app launch even when no model was on screen — the source of
// the startup freeze. Loading it lazily means the 3D bundle is only fetched/parsed
// the first time a model viewer is actually shown.
const Viewer3D = lazy(() =>
  import("./Viewer3D").then((m) => ({ default: m.Viewer3D })),
);

function ViewerFallback({ height }: { height: number }) {
  return (
    <div
      className="viewer3d viewer3d-loading"
      style={{ height }}
      role="status"
      aria-live="polite"
    >
      <div className="viewer-overlay-msg">
        <Loader2 size={28} className="spin" />
        <span>Chargement du visualiseur 3D…</span>
      </div>
    </div>
  );
}

/** Lazy wrapper around {@link Viewer3D} — same props, but the 3D bundle loads on demand. */
export function LazyViewer3D({
  src,
  height = 420,
  name,
}: {
  src: string | null;
  height?: number;
  name?: string;
}) {
  return (
    <Suspense fallback={<ViewerFallback height={height} />}>
      <Viewer3D src={src} height={height} name={name} />
    </Suspense>
  );
}
