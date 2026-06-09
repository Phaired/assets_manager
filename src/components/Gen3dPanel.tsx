import { useEffect, useMemo, useState } from "react";
import { Sliders, Loader2, Check, RotateCcw } from "lucide-react";

import type { Asset, Gen3d } from "../lib/types";
import { useConfig, useSetAssetGen3d } from "../lib/queries";

// Fields exposed in the panel (a subset of Gen3d that matters per asset).
const NUM_FIELDS: Array<{ key: keyof Gen3d; label: string; step?: number }> = [
  { key: "targetFaceNum", label: "Polygones (cible finale)" },
  { key: "faceCountV21", label: "Faces brutes (v21)" },
  { key: "octreeResolution", label: "Résolution octree" },
  { key: "stepsV21", label: "Étapes (v21)" },
  { key: "stepsMv2", label: "Étapes (mv2)" },
  { key: "guidanceScale", label: "Guidance", step: 0.5 },
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
    <div className="gen3d-panel">
      <button
        className="gen3d-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Sliders size={14} />
        Paramètres 3D
        {hasOverride && <span className="pill pill-on">personnalisé</span>}
      </button>

      {open && (
        <div className="gen3d-body">
          <div className="gen3d-presets">
            <span className="muted small">Presets :</span>
            {Object.keys(PRESETS).map((name) => (
              <button
                key={name}
                className="btn ghost xs"
                onClick={() => applyPreset(name)}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="gen3d-grid">
            {NUM_FIELDS.map((f) => (
              <label key={f.key} className="gen3d-field">
                <span>{f.label}</span>
                <input
                  className="input"
                  type="number"
                  step={f.step ?? 1}
                  value={Number(values[f.key])}
                  onChange={(e) =>
                    setField(f.key, Number(e.target.value))
                  }
                />
              </label>
            ))}
            <label className="gen3d-field gen3d-toggle-field">
              <span>Texture</span>
              <input
                type="checkbox"
                checked={values.texture}
                onChange={(e) => setField("texture", e.target.checked)}
              />
            </label>
          </div>

          <div className="row gen3d-actions">
            <button
              className="btn primary sm"
              onClick={onSave}
              disabled={save.isPending}
            >
              {save.isPending ? (
                <Loader2 size={14} className="spin" />
              ) : saved ? (
                <Check size={14} />
              ) : null}
              Enregistrer
            </button>
            <button
              className="btn ghost sm"
              onClick={onReset}
              disabled={save.isPending || !hasOverride}
              title="Revenir aux paramètres globaux"
            >
              <RotateCcw size={14} /> Défauts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
