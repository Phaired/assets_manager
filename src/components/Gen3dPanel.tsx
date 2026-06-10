import { useEffect, useMemo, useState } from "react";
import { Sliders, Loader2, Check, RotateCcw, Info } from "lucide-react";

import type { Asset, Backend, Gen3d } from "@/lib/types";
import { useConfig, useSetAssetGen3d } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Fields exposed in the panel (a subset of Gen3d that matters per asset).
// `backends` restricts a field to specific backends; omit = applies to all.
const NUM_FIELDS: Array<{
  key: keyof Gen3d;
  label: string;
  step?: number;
  backends?: Backend[];
  hint: string;
}> = [
  {
    key: "targetFaceNum",
    label: "Polygones (cible finale)",
    hint: "Nombre de faces conservées après simplification finale du maillage.",
  },
  {
    key: "faceCountV21",
    label: "Faces brutes (v21)",
    backends: ["v21"],
    hint: "Densité du maillage brut avant simplification (backend v21 uniquement).",
  },
  {
    key: "octreeResolution",
    label: "Résolution octree",
    hint: "Résolution de la grille de reconstruction. Plus haut = plus de détail, plus lent.",
  },
  {
    key: "stepsV21",
    label: "Étapes (v21)",
    backends: ["v21"],
    hint: "Étapes de diffusion (v21). Plus = plus net mais plus lent.",
  },
  {
    key: "stepsMv2",
    label: "Étapes (mv2)",
    backends: ["mv2"],
    hint: "Étapes de diffusion (mv2). Plus = plus net mais plus lent.",
  },
  {
    key: "guidanceScale",
    label: "Guidance",
    step: 0.5,
    hint: "Fidélité au conditionnement image. Trop haut peut rigidifier le résultat.",
  },
];

// Quick presets tune the polygon-related fields.
const PRESETS: Record<string, Partial<Gen3d>> = {
  Low: { targetFaceNum: 8000, faceCountV21: 20000 },
  Medium: { targetFaceNum: 20000, faceCountV21: 40000 },
  High: { targetFaceNum: 60000, faceCountV21: 120000 },
};

/** Per-asset 3D generation override, pre-filled from the global defaults. Only
 *  values that differ from the defaults are persisted as the asset override. */
export function Gen3dPanel({
  project,
  asset,
}: {
  project: string;
  asset: Asset;
}) {
  const configQ = useConfig();
  const defaults = configQ.data?.gen3d;
  const save = useSetAssetGen3d(project);

  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Gen3d | null>(null);
  const [saved, setSaved] = useState(false);

  // (Re)initialise local state from defaults + the asset's existing override.
  useEffect(() => {
    if (!defaults) return;
    setValues({ ...defaults, ...(asset.gen3d ?? {}) });
    setSaved(false);
  }, [defaults, asset.id, asset.gen3d]);

  const hasOverride = !!asset.gen3d && Object.keys(asset.gen3d).length > 0;

  // The diff vs defaults — what we actually persist.
  const overrideDiff = useMemo<Partial<Gen3d>>(() => {
    if (!values || !defaults) return {};
    const out: Partial<Gen3d> = {};
    (Object.keys(defaults) as Array<keyof Gen3d>).forEach((k) => {
      if (values[k] !== defaults[k]) {
        (out as Record<string, unknown>)[k] = values[k];
      }
    });
    return out;
  }, [values, defaults]);

  if (!values || !defaults) return null;

  // Only show fields relevant to the asset's backend ("auto" shows everything).
  const fields = NUM_FIELDS.filter(
    (f) =>
      !f.backends ||
      asset.backend === "auto" ||
      f.backends.includes(asset.backend),
  );

  function setField(key: keyof Gen3d, raw: number | boolean) {
    setValues((v) => (v ? { ...v, [key]: raw } : v));
    setSaved(false);
  }

  function applyPreset(name: string) {
    setValues((v) => (v ? { ...v, ...PRESETS[name] } : v));
    setSaved(false);
  }

  function onSave() {
    save.mutate(
      { assetId: asset.id, gen3d: overrideDiff },
      {
        onSuccess: () => {
          setSaved(true);
          window.setTimeout(() => setSaved(false), 1500);
        },
      },
    );
  }

  function onReset() {
    const base = defaults;
    if (!base) return;
    // Empty override → back to global defaults.
    save.mutate(
      { assetId: asset.id, gen3d: {} },
      { onSuccess: () => setValues({ ...base }) },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Sliders className="size-3.5" />
        Paramètres 3D
        {hasOverride && (
          <Badge variant="secondary" className="ml-1 text-run">
            personnalisé
          </Badge>
        )}
      </Button>

      {open && (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Presets :</span>
            {Object.keys(PRESETS).map((name) => (
              <Button
                key={name}
                variant="ghost"
                size="xs"
                onClick={() => applyPreset(name)}
              >
                {name}
              </Button>
            ))}
          </div>

          {asset.backend === "auto" && (
            <p className="text-xs text-muted-foreground">
              Backend « auto » : les paramètres des deux moteurs sont affichés.
            </p>
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                  {f.label}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="size-3 cursor-help opacity-60" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[240px]">
                      {f.hint}
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  type="number"
                  step={f.step ?? 1}
                  value={Number(values[f.key])}
                  onChange={(e) => setField(f.key, Number(e.target.value))}
                />
              </div>
            ))}
            <Label className="col-span-2 flex w-fit items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={values.texture}
                onChange={(e) => setField("texture", e.target.checked)}
              />
              Texture
            </Label>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onSave} disabled={save.isPending}>
              {save.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : saved ? (
                <Check className="size-3.5" />
              ) : null}
              Enregistrer
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              disabled={save.isPending || !hasOverride}
              title="Revenir aux paramètres globaux"
            >
              <RotateCcw className="size-3.5" /> Défauts
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
