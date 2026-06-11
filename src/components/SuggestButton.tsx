import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import type { SuggestTarget } from "../lib/types";
import { useSuggestPrompts } from "../lib/queries";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** « Suggérer » : demande au directeur créatif (LLM + DNA du projet) trois
 *  prompts pour la modalité visée et laisse l'utilisateur en choisir un. */
export function SuggestButton({
  project,
  assetId,
  target,
  onPick,
}: {
  project: string;
  assetId?: string | null;
  target: SuggestTarget;
  onPick: (text: string) => void;
}) {
  const suggest = useSuggestPrompts(project);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);

  function run() {
    suggest.mutate(
      { assetId, target },
      {
        onSuccess: (prompts) => {
          setOptions(prompts);
          setOpen(true);
        },
        onError: (e) => toast.error(String(e)),
      },
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.preventDefault();
            run();
          }}
          disabled={suggest.isPending}
          title="Suggestions du directeur créatif (DNA du projet)"
        >
          {suggest.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
          Suggérer
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2">
        <div className="flex flex-col gap-1">
          {options.map((opt, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                onPick(opt);
                setOpen(false);
              }}
              className="rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
            >
              {opt}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
