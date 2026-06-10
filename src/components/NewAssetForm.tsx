import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import type { Backend } from "../lib/types";
import { PRESETS } from "../lib/constants";
import { useCreateAsset } from "../lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function NewAssetForm({
  project,
  onCreated,
}: {
  project: string | null;
  onCreated: (id: string) => void;
}) {
  const createAsset = useCreateAsset(project);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [backend, setBackend] = useState<Backend>("auto");
  const [error, setError] = useState<string | null>(null);

  function applyPreset(text: string) {
    if (!text) return;
    setDescription(text);
    const chosen = PRESETS.find((p) => p.text === text);
    if (chosen && !name.trim()) setName(chosen.name);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!project) {
      setError("Crée d'abord un projet.");
      return;
    }
    if (!name.trim()) return;
    try {
      const a = await createAsset.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        tags: [],
        backend,
      });
      setName("");
      setDescription("");
      toast.success(`Asset « ${a.name} » créé`);
      onCreated(a.id);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Input
            placeholder="Nom (ex. crusher)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <Textarea
            placeholder="Description (style, couleurs, forme…)"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Exemples :</span>
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => applyPreset(p.text)}
                title={p.text}
                className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                {p.name}
              </button>
            ))}
          </div>

          <Select
            value={backend}
            onValueChange={(v) => setBackend(v as Backend)}
          >
            <SelectTrigger className="w-full" aria-label="Backend">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Backend: auto</SelectItem>
              <SelectItem value="v21">Hunyuan 2.1 (image unique)</SelectItem>
              <SelectItem value="mv2">Hunyuan 2mv (4 vues)</SelectItem>
            </SelectContent>
          </Select>

          {error && (
            <p className="rounded-md bg-destructive/15 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={createAsset.isPending || !project}>
            {createAsset.isPending ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Sparkles size={15} />
            )}
            Créer l'asset
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
