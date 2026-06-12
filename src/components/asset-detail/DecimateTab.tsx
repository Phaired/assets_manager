import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Info,
  Loader2,
  RotateCcw,
  Scissors,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import type {
  Asset,
  DecimateMode,
  DecimateParams,
  DecimateResult,
  StageState,
} from "@/lib/types";
import {
  useConfig,
  useDecimateModel,
  useSetAssetDecimate,
} from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PRESETS: Array<{ label: string; faces: number }> = [
  { label: "Low", faces: 8000 },
  { label: "Medium", faces: 20000 },
  { label: "High", faces: 60000 },
];

const MODE_HINTS: Record<DecimateMode, string> = {
  auto: "Essaie les deux méthodes (+ meshoptimizer) et garde la meilleure fidélité mesurée. Recommandé.",
  preserve:
    "Décimation qui conserve l'atlas UV d'origine. Sûr, mais les coutures UV limitent la qualité géométrique.",
  rebake:
    "Décimation libre (optimum géométrique) puis nouvel atlas UV + texture re-bakée depuis le brut.",
};

const METHOD_LABELS: Record<string, string> = {
  preserve: "préserver l'atlas",
  rebake: "re-bake",
  meshopt: "meshoptimizer",
};

/** Décimation tab: on-demand polygon reduction — re-decimates model_raw.glb →
 *  model.glb in seconds (no GPU re-generation), with measured Hausdorff
 *  fidelity and an optional baked normal map carrying the high-poly detail. */
export function DecimateTab({
  project,
  asset,
  model3dState,
  decimateState,
  jobBusy,
  textured,
}: {
  project: string;
  asset: Asset;
  model3dState: StageState | undefined;
  decimateState: StageState | undefined;
  jobBusy: boolean;
  /** Whether the current model carries a texture. When false, only the
   *  geometry-only path is possible (rebake / normal-map are hidden). */
  textured?: boolean;
}) {
  const configQ = useConfig();
  const defaults = configQ.data?.decimate;
  const saveOverride = useSetAssetDecimate(project);
  const decimate = useDecimateModel(project);

  const [advanced, setAdvanced] = useState(false);
  const [values, setValues] = useState<DecimateParams | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!defaults) return;
    setValues({ ...defaults, ...(asset.decimate ?? {}) });
    setSaved(false);
  }, [defaults, asset.id, asset.decimate]);

  const hasOverride = !!asset.decimate && Object.keys(asset.decimate).length > 0;
  const rawAvailable = typeof model3dState?.meta?.rawOutput === "string";
  const result =
    decimateState?.status === "done"
      ? (decimateState.meta as unknown as DecimateResult)
      : null;
  const running = decimateState?.status === "running" || decimate.isPending;

  const overrideDiff = useMemo<Partial<DecimateParams>>(() => {
    if (!values || !defaults) return {};
    const out: Partial<DecimateParams> = {};
    (Object.keys(defaults) as Array<keyof DecimateParams>).forEach((k) => {
      if (values[k] !== defaults[k]) {
        (out as Record<string, unknown>)[k] = values[k];
      }
    });
    return out;
  }, [values, defaults]);

  // No model yet → nothing to decimate. Keep the tab present but explain.
  if (model3dState?.status !== "done") {
    return (
      <div className="flex flex-col items-center gap-3 px-2 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-lg border border-border bg-card">
          <Scissors className="size-5 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">
          Génère d'abord le modèle 3D — la réduction de polygones s'applique au
          maillage généré.
        </p>
      </div>
    );
  }

  if (!values || !defaults) return null;

  // Untextured mesh: rebake / normal-map are impossible — the worker forces a
  // geometry-only "preserve" reduction. Reflect that in the UI.
  const untextured = textured === false;

  const facesBefore =
    (result?.facesBefore as number | undefined) ??
    (decimateState?.meta?.facesBefore as number | undefined);
  const sliderMax = Math.max(facesBefore ?? 100_000, values.targetFaceNum);

  function setField<K extends keyof DecimateParams>(
    key: K,
    value: DecimateParams[K],
  ) {
    setValues((v) => (v ? { ...v, [key]: value } : v));
    setSaved(false);
  }

  function apply() {
    // Send the full current values as a one-shot patch: what's on screen is
    // exactly what runs, saved override or not.
    decimate.mutate(
      { assetId: asset.id, params: values ?? undefined },
      {
        onSuccess: (r) => {
          toast.success(
            `Réduit à ${r.facesAfter.toLocaleString("fr-FR")} faces · fidélité ${r.fidelity.toLocaleString("fr-FR")} %`,
          );
        },
        onError: (e) => toast.error(String(e)),
      },
    );
  }

  function onSave() {
    saveOverride.mutate(
      { assetId: asset.id, decimate: overrideDiff },
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
    saveOverride.mutate(
      { assetId: asset.id, decimate: {} },
      { onSuccess: () => setValues({ ...base }) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Réduction de polygones
        </span>
        {hasOverride && (
          <Badge variant="secondary" className="text-run">personnalisé</Badge>
        )}
      </div>

      {!rawAvailable && (
        <p className="text-xs text-run">
          Maillage brut absent — relance l'étape 3D pour le conserver (les
          modèles générés avant cette version ne l'ont pas gardé).
        </p>
      )}

      {/* Target polycount: slider + input + presets. */}
      <div className="flex flex-col gap-1.5">
        <Label className="flex items-center gap-1 text-xs text-muted-foreground">
          Polygones cibles
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="size-3 cursor-help opacity-60" />
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px]">
              Nombre de faces visées. La re-réduction part toujours du
              maillage brut conservé — itérer ne dégrade jamais le modèle.
            </TooltipContent>
          </Tooltip>
        </Label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={500}
            max={sliderMax}
            step={100}
            value={values.targetFaceNum}
            onChange={(e) => setField("targetFaceNum", Number(e.target.value))}
            className="flex-1 cursor-pointer"
            style={{ accentColor: "#e39a4a" }}
          />
          <Input
            type="number"
            min={500}
            step={500}
            className="w-28"
            value={values.targetFaceNum}
            onChange={(e) => setField("targetFaceNum", Number(e.target.value))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Presets :</span>
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              variant="ghost"
              size="xs"
              onClick={() => setField("targetFaceNum", p.faces)}
            >
              {p.label}
            </Button>
          ))}
          {facesBefore != null && (
            <span className="ml-auto text-xs text-muted-foreground">
              brut : {facesBefore.toLocaleString("fr-FR")} faces
            </span>
          )}
        </div>
      </div>

      {/* Method */}
      {untextured ? (
        <p className="text-xs text-run">
          Modèle sans texture — réduction géométrique seule (méthode «
          préserver »). Le re-bake et la normal map nécessitent une texture.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Méthode</Label>
          <Select
            value={values.mode}
            onValueChange={(v) => setField("mode", v as DecimateMode)}
          >
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (meilleur des deux)</SelectItem>
              <SelectItem value="preserve">Préserver l'atlas UV</SelectItem>
              <SelectItem value="rebake">Re-bake (atlas neuf)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{MODE_HINTS[values.mode]}</p>
        </div>
      )}

      {/* Normal map (textured meshes only). */}
      {!untextured && (
        <div className="flex flex-wrap items-center gap-3">
          <Label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={values.bakeNormalMap}
              onChange={(e) => setField("bakeNormalMap", e.target.checked)}
            />
            Normal map (détail du brut « peint » sur le maillage réduit)
          </Label>
          {values.bakeNormalMap && (
            <Select
              value={String(values.normalMapResolution)}
              onValueChange={(v) => setField("normalMapResolution", Number(v))}
            >
              <SelectTrigger className="h-7 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1024">1024²</SelectItem>
                <SelectItem value="2048">2048²</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* Advanced (manual modes only — auto searches these itself). */}
      {!untextured && values.mode !== "auto" && (
        <div className="flex flex-col gap-2">
          <Button
            variant="ghost"
            size="xs"
            className="w-fit px-1 text-muted-foreground"
            onClick={() => setAdvanced((v) => !v)}
            aria-expanded={advanced}
          >
            Réglages avancés {advanced ? "▾" : "▸"}
          </Button>
          {advanced && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1 text-xs text-muted-foreground">
                  Seuil de qualité
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="size-3 cursor-help opacity-60" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[240px]">
                      1.0 = qualité maximale des triangles, mais peut
                      empêcher d'atteindre la cible sur les maillages denses.
                    </TooltipContent>
                  </Tooltip>
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={values.qualityThr}
                  onChange={(e) => setField("qualityThr", Number(e.target.value))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Poids des bords
                </Label>
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={values.boundaryWeight}
                  onChange={(e) =>
                    setField("boundaryWeight", Number(e.target.value))
                  }
                />
              </div>
              {(
                [
                  ["preserveBoundary", "Préserver les bords"],
                  ["preserveNormal", "Préserver les normales"],
                  ["optimalPlacement", "Placement optimal"],
                  ["planarQuadric", "Simplification planaire"],
                ] as Array<[keyof DecimateParams, string]>
              ).map(([key, label]) => (
                <Label
                  key={key}
                  className="flex w-fit items-center gap-2 text-xs text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={Boolean(values[key])}
                    onChange={(e) => setField(key, e.target.checked as never)}
                  />
                  {label}
                </Label>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={apply}
          disabled={!rawAvailable || running || jobBusy}
          title="Re-décime le maillage brut avec ces paramètres (quelques secondes)"
        >
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          Appliquer la réduction
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSave}
          disabled={saveOverride.isPending}
          title="Mémorise ces paramètres pour cet asset"
        >
          {saveOverride.isPending ? (
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
          disabled={saveOverride.isPending || !hasOverride}
          title="Revenir aux paramètres globaux"
        >
          <RotateCcw className="size-3.5" /> Défauts
        </Button>
      </div>

      {decimateState?.status === "error" && decimateState.error && (
        <p className="text-xs text-destructive">{decimateState.error}</p>
      )}

      {result && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-mono text-foreground">
              {result.facesBefore.toLocaleString("fr-FR")}
            </span>{" "}
            →{" "}
            <span className="font-mono text-foreground">
              {result.facesAfter.toLocaleString("fr-FR")}
            </span>{" "}
            faces (−
            {(
              ((result.facesBefore - result.facesAfter) /
                Math.max(result.facesBefore, 1)) *
              100
            ).toLocaleString("fr-FR", { maximumFractionDigits: 1 })}
            %)
          </span>
          <span>·</span>
          <span>
            fidélité{" "}
            <span className="font-mono text-ok">
              {result.fidelity.toLocaleString("fr-FR", {
                maximumFractionDigits: 2,
              })}
              {" "}%
            </span>
          </span>
          <span>·</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help underline decoration-dotted">
                méthode {METHOD_LABELS[result.method] ?? result.method}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[280px]">
              {result.candidatesTried?.length ? (
                <ul className="flex flex-col gap-0.5">
                  {result.candidatesTried.map((c, i) => (
                    <li key={i} className="font-mono text-xs">
                      {METHOD_LABELS[c.method] ?? c.method} :{" "}
                      {c.error
                        ? `échec (${c.error.slice(0, 60)})`
                        : `${c.fidelity} %`}
                    </li>
                  ))}
                </ul>
              ) : (
                "Un seul candidat évalué."
              )}
            </TooltipContent>
          </Tooltip>
          {result.baked && (
            <>
              <span>·</span>
              <span>normal map {result.normalMapResolution}²</span>
            </>
          )}
          {result.note && (
            <>
              <span>·</span>
              <span className="text-run">{result.note}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
