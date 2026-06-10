import { useState } from "react";
import { Loader2, Sparkles, Trash2, Check, Save } from "lucide-react";
import { toast } from "sonner";

import type { VoicePreview } from "../lib/types";
import {
  useVoices,
  useDesignVoice,
  useCreateVoice,
  useDeleteVoice,
} from "../lib/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const DEFAULT_PREVIEW =
  "Bonjour ! Voici un aperçu de cette voix. Elle peut raconter une histoire, " +
  "donner des instructions, ou simplement présenter un personnage avec énergie et clarté.";

/** Designed-voices catalog (global, reusable across projects). Design a voice
 *  from a description, listen to previews, pick one and save it. */
export function VoicesManager({ onClose }: { onClose: () => void }) {
  const voicesQ = useVoices();
  const design = useDesignVoice();
  const create = useCreateVoice();
  const del = useDeleteVoice();

  const [description, setDescription] = useState("");
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW);
  const [name, setName] = useState("");
  const [previews, setPreviews] = useState<VoicePreview[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const voices = voicesQ.data ?? [];

  async function runDesign() {
    if (!description.trim()) return;
    setPreviews(null);
    setSelected(null);
    try {
      const res = await design.mutateAsync({
        description: description.trim(),
        previewText: previewText.trim(),
      });
      setPreviews(res);
      if (res[0]) setSelected(res[0].generatedVoiceId);
    } catch {
      /* mutation cache surfaces the error toast */
    }
  }

  async function saveVoice() {
    if (!selected || !name.trim()) return;
    try {
      await create.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        generatedVoiceId: selected,
      });
      toast.success(`Voix « ${name.trim()} » enregistrée`);
      setPreviews(null);
      setSelected(null);
      setName("");
      setDescription("");
    } catch {
      /* surfaced by the mutation cache */
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-labelledby="voices-title"
        className="max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl"
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle id="voices-title">Voix (sur-mesure)</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 py-4">
          {/* Design a new voice */}
          <h3 className="text-sm font-semibold">Créer une voix</h3>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voice-desc">Description de la voix</Label>
            <Textarea
              id="voice-desc"
              rows={2}
              placeholder="ex. voix grave et chaleureuse d'un vieux conteur, accent posé…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voice-preview">Texte d'aperçu</Label>
            <Textarea
              id="voice-preview"
              rows={2}
              value={previewText}
              onChange={(e) => setPreviewText(e.target.value)}
            />
          </div>
          <div>
            <Button
              size="sm"
              onClick={runDesign}
              disabled={design.isPending || !description.trim()}
            >
              {design.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              Générer des aperçus
            </Button>
          </div>

          {previews && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
              <span className="text-xs text-muted-foreground">
                Choisis un aperçu puis enregistre la voix.
              </span>
              {previews.map((p, i) => {
                const active = p.generatedVoiceId === selected;
                return (
                  <div
                    key={p.generatedVoiceId}
                    className={cn(
                      "flex items-center gap-3 rounded-md border p-2 transition-colors",
                      active ? "border-primary bg-primary/10" : "border-border",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(p.generatedVoiceId)}
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground",
                      )}
                      aria-label={`Choisir l'aperçu ${i + 1}`}
                    >
                      {active ? <Check size={13} /> : i + 1}
                    </button>
                    <audio
                      controls
                      className="h-8 w-full"
                      src={`data:audio/mpeg;base64,${p.audioBase64}`}
                    />
                  </div>
                );
              })}
              <Separator className="my-1" />
              <div className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="voice-name">Nom de la voix</Label>
                  <Input
                    id="voice-name"
                    placeholder="ex. Conteur grave"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <Button
                  onClick={saveVoice}
                  disabled={create.isPending || !selected || !name.trim()}
                >
                  {create.isPending ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Save size={15} />
                  )}
                  Enregistrer
                </Button>
              </div>
            </div>
          )}

          <Separator />

          {/* Existing catalog */}
          <h3 className="text-sm font-semibold">
            Catalogue ({voices.length})
          </h3>
          {voicesQ.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Chargement…
            </p>
          )}
          {!voicesQ.isLoading && !voices.length && (
            <p className="text-sm text-muted-foreground">
              Aucune voix enregistrée pour l'instant.
            </p>
          )}
          {voices.map((v) => (
            <div
              key={v.voiceId}
              className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{v.name}</span>
                {v.description && (
                  <span className="truncate text-xs text-muted-foreground">
                    {v.description}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto shrink-0 text-destructive"
                title="Supprimer du catalogue"
                onClick={() => del.mutate(v.voiceId)}
                disabled={del.isPending}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          <Button variant="ghost" onClick={onClose}>
            Fermer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
