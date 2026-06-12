import { Boxes } from "lucide-react";

import { useProject } from "../lib/queries";
import { useAppState } from "../lib/appState";
import { AssetDetail } from "./AssetDetail";
import { NewAssetForm } from "./NewAssetForm";

/** Main pane of the 3D section (route `/`): the selected asset's detail, or
 *  the create-and-generate hub when nothing is selected (same pattern as the
 *  audio section). */
export function Assets3dWorkspace() {
  const { project, assetId, setAssetId, openViewer } = useAppState();
  const bundleQ = useProject(project);

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
        <div
          className="flex size-20 items-center justify-center rounded-lg border border-border bg-card"
          aria-hidden
        >
          <Boxes size={28} className="text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">
          Sélectionne ou crée un projet pour générer des assets 3D.
        </p>
      </div>
    );
  }

  if (!assetId) {
    return (
      <div className="flex min-h-full p-8">
        <div className="m-auto flex w-full max-w-2xl flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">
              Nouvel asset 3D
            </h2>
            <p className="text-sm text-muted-foreground">
              Choisis un mode, décris l'objet, et lance la génération. En
              Text-to-3D, le modèle est créé directement depuis le texte —
              sans OpenAI.
            </p>
          </div>
          <NewAssetForm project={project} onCreated={setAssetId} />
        </div>
      </div>
    );
  }

  return (
    <AssetDetail
      project={project}
      assetId={assetId}
      bundle={bundleQ.data ?? null}
      onDeleted={() => setAssetId(null)}
      onEnlarge={openViewer}
    />
  );
}
