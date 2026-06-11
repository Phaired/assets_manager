import { useState } from "react";
import { Box, Image as ImageIcon, Loader2, Sparkles, Volume2 } from "lucide-react";
import { toast } from "sonner";

import type { PackAssetIdea } from "../lib/types";
import { stagesForKind } from "../lib/constants";
import { useIdeatePack } from "../lib/queries";
import * as api from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "../lib/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Per-idea selection state: the asset itself + each suggested sound. */
interface Selection {
  asset: boolean;
  sounds: boolean[];
}

/** « Idéation IA » : le directeur créatif propose un pack d'assets cohérent
 *  avec le DNA depuis une consigne ; l'utilisateur coche et crée en masse. */
export function PackIdeationDialog({ project }: { project: string }) {
  const ideate = useIdeatePack(project);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [ideas, setIdeas] = useState<PackAssetIdea[]>([]);
  const [sel, setSel] = useState<Selection[]>([]);
  const [autoGenerate, setAutoGenerate] = useState(false);
  const [creating, setCreating] = useState(false);

  function run() {
    if (!brief.trim()) {
      toast.error("écris une consigne (ex. « pack médiéval, 12 assets »)");
      return;
    }
    ideate.mutate(brief.trim(), {
      onSuccess: (out) => {
        setIdeas(out);
        setSel(
          out.map((i) => ({ asset: true, sounds: i.sounds.map(() => true) })),
        );
      },
      onError: (e) => toast.error(String(e)),
    });
  }

  function toggleAsset(i: number) {
    setSel((s) =>
      s.map((x, idx) => (idx === i ? { ...x, asset: !x.asset } : x)),
    );
  }

  function toggleSound(i: number, j: number) {
    setSel((s) =>
      s.map((x, idx) =>
        idx === i
          ? { ...x, sounds: x.sounds.map((b, jdx) => (jdx === j ? !b : b)) }
          : x,
      ),
    );
  }

  const checkedCount = sel.filter((x) => x.asset).length;

  async function createSelection() {
    setCreating(true);
    let assetCount = 0;
    let soundCount = 0;
    try {
      for (let i = 0; i < ideas.length; i++) {
        if (!sel[i]?.asset) continue;
        const idea = ideas[i];
        const created = await api.createAsset({
          project,
          name: idea.name,
          description: idea.description,
          tags: idea.tags,
          backend: "auto",
          kind: idea.kind,
        });
        assetCount++;
        if (autoGenerate) {
          await api.generate(project, created.id, stagesForKind(idea.kind));
        }
        for (let j = 0; j < idea.sounds.length; j++) {
          if (!sel[i].sounds[j]) continue;
          const s = idea.sounds[j];
          const item = await api.createAudioItem({
            project,
            kind: "sfx",
            name: s.name,
            text: s.prompt,
            assetId: created.id,
          });
          soundCount++;
          if (autoGenerate) {
            await api.generateAudioItem(project, item.id);
          }
        }
      }
      qc.invalidateQueries({ queryKey: qk.project(project) });
      qc.invalidateQueries({ queryKey: qk.audio(project) });
      toast.success(
        `${assetCount} asset(s) et ${soundCount} son(s) créés${autoGenerate ? " — génération lancée" : ""}`,
      );
      setOpen(false);
      setIdeas([]);
      setSel([]);
      setBrief("");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start">
          <Sparkles size={14} className="text-primary" />
          Idéation IA
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Idéation de pack</DialogTitle>
          <DialogDescription>
            Le directeur créatif propose un pack d'assets cohérent avec le DNA
            du projet. Coche ce que tu veux créer.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              className="flex-1"
              placeholder="ex. « un pack médiéval : 12 assets, armes, props et textures de sol »"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
            />
            <Button onClick={run} disabled={ideate.isPending}>
              {ideate.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              Proposer
            </Button>
          </div>

          {ideas.length > 0 && (
            <div className="flex flex-col gap-2">
              {ideas.map((idea, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3"
                >
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-primary"
                      checked={sel[i]?.asset ?? false}
                      onChange={() => toggleAsset(i)}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {idea.kind === "texture" ? (
                          <ImageIcon size={13} className="text-primary" />
                        ) : (
                          <Box size={13} className="text-primary" />
                        )}
                        {idea.name}
                        <Badge variant="outline" className="text-xs">
                          {idea.kind === "texture" ? "texture" : "modèle 3D"}
                        </Badge>
                        {idea.tags.map((t) => (
                          <span key={t} className="text-xs text-muted-foreground">
                            #{t}
                          </span>
                        ))}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {idea.description}
                      </span>
                    </span>
                  </label>
                  {idea.sounds.length > 0 && (
                    <div className="ml-6 flex flex-col gap-1">
                      {idea.sounds.map((s, j) => (
                        <label
                          key={j}
                          className="flex cursor-pointer items-center gap-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            checked={sel[i]?.sounds[j] ?? false}
                            onChange={() => toggleSound(i, j)}
                            disabled={!sel[i]?.asset}
                          />
                          <Volume2 size={12} className="text-muted-foreground" />
                          <span className="font-medium">{s.name}</span>
                          <span className="truncate text-muted-foreground">
                            {s.prompt}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={autoGenerate}
                  onChange={(e) => setAutoGenerate(e.target.checked)}
                />
                Lancer la génération immédiatement (images + sons — coût API)
              </label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Fermer
          </Button>
          {ideas.length > 0 && (
            <Button onClick={createSelection} disabled={creating || !checkedCount}>
              {creating && <Loader2 size={14} className="animate-spin" />}
              Créer la sélection ({checkedCount})
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
