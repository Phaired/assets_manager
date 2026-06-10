import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";

import type { ConfigPatch } from "../lib/types";
import { useConfig, useUpdateConfig } from "../lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const QUALITIES = ["low", "medium", "high", "auto"];

/** A header popover for the settings users tweak most often (OpenAI model +
 *  quality, default 3D backend), without opening the full Settings dialog. */
export function QuickSettings() {
  const configQ = useConfig();
  const update = useUpdateConfig();
  const cfg = configQ.data;

  const [model, setModel] = useState("");
  useEffect(() => {
    if (cfg) setModel(cfg.openaiModel);
  }, [cfg?.openaiModel]);

  function patch(p: ConfigPatch) {
    update.mutate(p, {
      onSuccess: () => toast.success("Réglages mis à jour"),
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Réglages rapides"
          title="Réglages rapides"
        >
          <SlidersHorizontal size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">Réglages rapides</p>

          {!cfg ? (
            <p className="text-xs text-muted-foreground">Chargement…</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="qs-model" className="text-xs text-muted-foreground">
                  Modèle image (OpenAI)
                </Label>
                <Input
                  id="qs-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={() => {
                    if (model.trim() && model !== cfg.openaiModel) {
                      patch({ openaiModel: model.trim() });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Qualité</Label>
                <Select
                  value={cfg.openaiQuality}
                  onValueChange={(v) => patch({ openaiQuality: v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUALITIES.map((q) => (
                      <SelectItem key={q} value={q}>
                        {q}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Backend 3D par défaut
                </Label>
                <Select
                  value={cfg.defaultBackend}
                  onValueChange={(v) =>
                    patch({ defaultBackend: v as "v21" | "mv2" })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="v21">Hunyuan 2.1 · mono</SelectItem>
                    <SelectItem value="mv2">Hunyuan 2mv · 4 vues</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
