import { useState } from "react";
import { Loader2, Sparkles, Mic2, Music, Volume2 } from "lucide-react";
import { toast } from "sonner";

import type { AudioKind } from "../lib/types";
import {
  useVoices,
  useCreateAudioItem,
  useGenerateAudioItem,
} from "../lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Create-and-generate hub for the audio section. One sub-tab per kind. */
export function NewAudioForm({
  project,
  onCreated,
}: {
  project: string | null;
  onCreated: (id: string) => void;
}) {
  const create = useCreateAudioItem(project);
  const generate = useGenerateAudioItem(project);
  const voicesQ = useVoices();
  const voices = voicesQ.data ?? [];

  const [kind, setKind] = useState<AudioKind>("sfx");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [duration, setDuration] = useState("");
  const [promptInfluence, setPromptInfluence] = useState("");
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setText("");
    setDuration("");
    setPromptInfluence("");
    setLoop(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!project) {
      setError("Sélectionne d'abord un projet.");
      return;
    }
    if (!name.trim() || !text.trim()) return;
    if (kind === "voice" && !voiceId) {
      setError("Choisis une voix (ou crée-en une dans « Voix »).");
      return;
    }

    const params: Record<string, unknown> = {};
    if (kind === "sfx") {
      if (duration.trim()) params.durationSeconds = Number(duration);
      if (promptInfluence.trim()) params.promptInfluence = Number(promptInfluence);
      if (loop) params.loop = true;
    } else if (kind === "music") {
      if (duration.trim()) params.musicLengthMs = Math.round(Number(duration) * 1000);
    }

    try {
      const item = await create.mutateAsync({
        kind,
        name: name.trim(),
        text: text.trim(),
        voiceId: kind === "voice" ? voiceId : null,
        params,
      });
      await generate.mutateAsync(item.id);
      reset();
      toast.success(`« ${item.name} » en génération`);
      onCreated(item.id);
    } catch (err) {
      setError(String(err));
    }
  }

  const busy = create.isPending || generate.isPending;
  const promptLabel =
    kind === "voice" ? "Texte à dire" : "Prompt (description du son)";
  const promptPlaceholder =
    kind === "voice"
      ? "Le texte que la voix doit prononcer…"
      : kind === "music"
        ? "ex. musique d'aventure épique, orchestre, tempo modéré…"
        : "ex. porte en bois qui grince puis claque, réverbération…";

  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <Tabs value={kind} onValueChange={(v) => setKind(v as AudioKind)}>
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="sfx" className="flex-1 gap-1.5">
              <Volume2 size={14} /> Son
            </TabsTrigger>
            <TabsTrigger value="voice" className="flex-1 gap-1.5">
              <Mic2 size={14} /> Voix
            </TabsTrigger>
            <TabsTrigger value="music" className="flex-1 gap-1.5">
              <Music size={14} /> Musique
            </TabsTrigger>
          </TabsList>

          {/* The fields are shared; only kind-specific extras differ. */}
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <Input
              placeholder="Nom (ex. door_creak)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />

            <TabsContent value="voice" className="m-0 flex flex-col gap-3">
              <Select value={voiceId} onValueChange={setVoiceId}>
                <SelectTrigger className="w-full" aria-label="Voix">
                  <SelectValue placeholder="Choisir une voix…" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => (
                    <SelectItem key={v.voiceId} value={v.voiceId}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!voices.length && (
                <p className="text-xs text-muted-foreground">
                  Aucune voix : crée-en une via le bouton « Voix » de la barre
                  latérale.
                </p>
              )}
            </TabsContent>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="audio-text">{promptLabel}</Label>
              <Textarea
                id="audio-text"
                placeholder={promptPlaceholder}
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
              />
            </div>

            <TabsContent value="sfx" className="m-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sfx-dur">Durée (s, optionnel)</Label>
                  <Input
                    id="sfx-dur"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="30"
                    placeholder="auto"
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="sfx-infl">Prompt influence (0–1)</Label>
                  <Input
                    id="sfx-infl"
                    type="number"
                    step="0.1"
                    min="0"
                    max="1"
                    placeholder="0.3"
                    value={promptInfluence}
                    onChange={(e) => setPromptInfluence(e.target.value)}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={loop}
                  onChange={(e) => setLoop(e.target.checked)}
                />
                Bouclable (loop)
              </label>
            </TabsContent>

            <TabsContent value="music" className="m-0 flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="music-dur">Durée (s)</Label>
                <Input
                  id="music-dur"
                  type="number"
                  step="1"
                  min="3"
                  max="300"
                  placeholder="ex. 30"
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                />
              </div>
            </TabsContent>

            {error && (
              <p className="rounded-md bg-destructive/15 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy || !project}>
              {busy ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Sparkles size={15} />
              )}
              Générer
            </Button>
          </form>
        </Tabs>
      </CardContent>
    </Card>
  );
}
