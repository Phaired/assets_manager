import { useEffect, useState } from "react";
import { Dna, Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { Project, ProjectDna } from "../lib/types";
import { useSetProjectDna } from "../lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const EMPTY_DNA: ProjectDna = {
  gameDescription: "",
  artStyle: "",
  palette: "",
  ambiance: "",
  audioTone: "",
  audioInstrumentation: "",
  audioMood: "",
};

/** Initial form values: existing DNA, else seed artStyle from the legacy style. */
function initialDna(project: Project): ProjectDna {
  if (project.dna) return project.dna;
  return { ...EMPTY_DNA, artStyle: project.style };
}

/** Dialog d'édition du DNA du projet — la fiche d'identité (description du jeu,
 *  direction artistique, direction audio) injectée dans tous les pipelines de
 *  génération (prompts image, édition d'image, SFX, musique, textures). */
export function ProjectDnaPanel({
  projectName,
  project,
}: {
  projectName: string;
  project: Project;
}) {
  const setDna = useSetProjectDna(projectName);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectDna>(() => initialDna(project));

  useEffect(() => {
    if (open) setDraft(initialDna(project));
  }, [open, project]);

  const filled = project.dna
    ? Object.values(project.dna).some((v) => v.trim() !== "")
    : project.style.trim() !== "";

  function field<K extends keyof ProjectDna>(key: K, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function save() {
    setDna.mutate(draft, {
      onSuccess: () => {
        setOpen(false);
        toast.success("DNA du projet enregistré");
      },
      onError: (e) => toast.error(String(e)),
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start">
          <Dna size={14} className={filled ? "text-primary" : undefined} />
          DNA du projet
          {!filled && (
            <span className="ml-auto text-xs text-muted-foreground">
              à définir
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>DNA du projet</DialogTitle>
          <DialogDescription>
            La fiche d'identité du projet — injectée dans toutes les
            générations (images, textures, sons, musiques) pour garder un
            ensemble cohérent.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dna-game">Description du jeu</Label>
            <Textarea
              id="dna-game"
              rows={3}
              placeholder="ex. un jeu d'aventure médiéval cartoon où l'on collectionne des créatures…"
              value={draft.gameDescription}
              onChange={(e) => field("gameDescription", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <span className="text-sm font-medium">Direction artistique</span>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-art">Style visuel</Label>
              <Input
                id="dna-art"
                placeholder="ex. low-poly, formes simples, matériaux mats"
                value={draft.artStyle}
                onChange={(e) => field("artStyle", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-palette">Palette de couleurs</Label>
              <Input
                id="dna-palette"
                placeholder="ex. couleurs vives et saturées, accents dorés"
                value={draft.palette}
                onChange={(e) => field("palette", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-ambiance">Ambiance visuelle</Label>
              <Input
                id="dna-ambiance"
                placeholder="ex. joyeuse, féérique, légèrement mystérieuse"
                value={draft.ambiance}
                onChange={(e) => field("ambiance", e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <span className="text-sm font-medium">Direction audio</span>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-tone">Ton</Label>
              <Input
                id="dna-tone"
                placeholder="ex. léger, comique, épique"
                value={draft.audioTone}
                onChange={(e) => field("audioTone", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-instru">Instrumentation</Label>
              <Input
                id="dna-instru"
                placeholder="ex. orchestral léger, flûtes, percussions douces"
                value={draft.audioInstrumentation}
                onChange={(e) => field("audioInstrumentation", e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dna-mood">Mood</Label>
              <Input
                id="dna-mood"
                placeholder="ex. énergique, fun, entraînant"
                value={draft.audioMood}
                onChange={(e) => field("audioMood", e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Annuler
          </Button>
          <Button onClick={save} disabled={setDna.isPending}>
            {setDna.isPending && <Loader2 size={14} className="animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
