import { useEffect, useState } from "react";
import { Check, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import type { Asset } from "@/lib/types";
import { useSetAssetPrompt } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** Prompt tab: the per-asset prompt override (replaces the global template). */
export function PromptTab({
  project,
  asset,
  profile,
}: {
  project: string;
  asset: Asset;
  profile: "text3d" | "image3d" | "texture";
}) {
  const setPrompt = useSetAssetPrompt(project);
  const [draft, setDraft] = useState("");

  // Keep the draft in sync with the selected asset.
  useEffect(() => {
    setDraft(asset.promptOverride ?? "");
  }, [asset.id, asset.promptOverride]);

  function commit() {
    setPrompt.mutate(
      { assetId: asset.id, prompt: draft },
      { onSuccess: () => toast.success("Prompt enregistré") },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {profile === "texture"
            ? "Prompt texture"
            : profile === "text3d"
              ? "Prompt text-to-3D"
              : "Prompt multivue"}
        </span>
        {asset.promptOverride && (
          <Badge variant="secondary" className="text-run">personnalisé</Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Remplace le gabarit global pour cet asset. Laisse vide pour revenir au
        gabarit + style du projet.
      </p>

      <textarea
        rows={8}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          profile === "texture"
            ? "Décris précisément la texture seamless à générer…"
            : profile === "text3d"
              ? "Décris précisément l'objet à générer…"
              : "Décris précisément la planche 4 vues à générer…"
        }
        className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-primary"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={commit}
          disabled={setPrompt.isPending || draft === (asset.promptOverride ?? "")}
        >
          {setPrompt.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Enregistrer
        </Button>
        {asset.promptOverride && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft("");
              setPrompt.mutate({ assetId: asset.id, prompt: "" });
            }}
            disabled={setPrompt.isPending}
          >
            <RotateCcw className="size-3.5" /> Gabarit par défaut
          </Button>
        )}
      </div>
    </div>
  );
}
