import { useEffect, useState } from "react";
import { X, Save, Loader2, Play, Square } from "lucide-react";

import type { ConfigPatch, Gen3d } from "../lib/types";
import {
  useConfig,
  useServer,
  useServerStart,
  useServerStop,
  useUpdateConfig,
} from "../lib/queries";
import { Modal } from "./Modal";

interface GenNum {
  key: keyof Gen3d;
  label: string;
  step: number;
}

const GEN_NUMS: GenNum[] = [
  { key: "stepsV21", label: "Steps 2.1", step: 1 },
  { key: "stepsMv2", label: "Steps 2mv", step: 1 },
  { key: "guidanceScale", label: "Guidance scale", step: 0.5 },
  { key: "octreeResolution", label: "Résolution octree", step: 32 },
  { key: "numChunks", label: "Num chunks", step: 10000 },
  { key: "faceCountV21", label: "Plafond faces (2.1)", step: 1000 },
  { key: "targetFaceNum", label: "Faces cible (réduction)", step: 1000 },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const configQ = useConfig();
  const update = useUpdateConfig();
  const serverQ = useServer();
  const startServer = useServerStart();
  const stopServer = useServerStop();

  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [quality, setQuality] = useState("low");
  const [budget, setBudget] = useState("");
  const [cost, setCost] = useState("");
  const [timeout, setTimeoutVal] = useState("");
  const [backend, setBackend] = useState<"v21" | "mv2">("v21");
  const [gen, setGen] = useState<Gen3d | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hydrate form from config once loaded.
  useEffect(() => {
    const c = configQ.data;
    if (!c) return;
    setKey("");
    setModel(c.openaiModel);
    setQuality(c.openaiQuality);
    setBudget(String(c.budgetUsd));
    setCost(String(c.estimatedCostPerImage));
    setTimeoutVal(String(c.openaiTimeout));
    setBackend(c.defaultBackend);
    setGen(c.gen3d);
  }, [configQ.data]);

  function setGenNum(k: keyof Gen3d, raw: string) {
    setGen((g) => (g ? { ...g, [k]: Number(raw) } : g));
  }

  async function save() {
    if (!gen) return;
    setSaveError(null);
    const gen3d: Partial<Gen3d> = { texture: gen.texture };
    for (const { key: k } of GEN_NUMS) {
      const v = gen[k];
      if (typeof v === "number" && !Number.isNaN(v)) {
        (gen3d as Record<string, unknown>)[k] = v;
      }
    }
    const patch: ConfigPatch = {
      openaiModel: model,
      openaiQuality: quality,
      budgetUsd: parseFloat(budget),
      estimatedCostPerImage: parseFloat(cost),
      openaiTimeout: parseInt(timeout, 10),
      defaultBackend: backend,
      gen3d,
    };
    if (key.trim()) patch.openaiApiKey = key.trim();
    try {
      await update.mutateAsync(patch);
      onClose();
    } catch (e) {
      setSaveError(String(e));
    }
  }

  const server = serverQ.data ?? null;
  const c = configQ.data;

  return (
    <Modal onClose={onClose} labelledBy="settings-title">
      <div className="modal-head">
        <h2 id="settings-title">Réglages</h2>
        <button className="btn icon ghost" onClick={onClose} aria-label="Fermer">
          <X size={16} />
        </button>
      </div>

      {configQ.isLoading && (
        <p className="muted">
          <Loader2 size={14} className="spin" /> Chargement…
        </p>
      )}

      {c && gen && (
        <>
          <label className="fld">
            Clé OpenAI
            <input
              type="password"
              className="input"
              value={key}
              placeholder={
                c.openaiKeySet
                  ? "déjà configurée — laisser vide pour garder"
                  : "sk-…"
              }
              onChange={(e) => setKey(e.target.value)}
            />
          </label>

          <label className="fld">
            Modèle image
            <input
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>

          <label className="fld">
            Qualité
            <select
              className="input"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <div className="grid2">
            <label className="fld">
              Budget USD
              <input
                type="number"
                step="0.5"
                className="input"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </label>
            <label className="fld">
              Coût estimé / image
              <input
                type="number"
                step="0.001"
                className="input"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </label>
            <label className="fld">
              Timeout image (s)
              <input
                type="number"
                step="10"
                className="input"
                value={timeout}
                onChange={(e) => setTimeoutVal(e.target.value)}
              />
            </label>
            <label className="fld">
              Backend par défaut
              <select
                className="input"
                value={backend}
                onChange={(e) =>
                  setBackend(e.target.value as "v21" | "mv2")
                }
              >
                <option value="v21">Hunyuan 2.1</option>
                <option value="mv2">Hunyuan 2mv</option>
              </select>
            </label>
          </div>

          <p className="muted small spend-line">
            Workspace : <code>{c.workspaceDir}</code>
          </p>

          <h3>Paramètres de génération 3D</h3>
          <div className="grid2">
            {GEN_NUMS.map((g) => (
              <label className="fld" key={g.key}>
                {g.label}
                <input
                  type="number"
                  step={g.step}
                  className="input"
                  value={String(gen[g.key])}
                  onChange={(e) => setGenNum(g.key, e.target.value)}
                />
              </label>
            ))}
            <label className="fld check">
              <input
                type="checkbox"
                checked={gen.texture}
                onChange={(e) =>
                  setGen((p) =>
                    p ? { ...p, texture: e.target.checked } : p,
                  )
                }
              />
              Générer la texture
            </label>
          </div>

          <h3>Serveur Hunyuan</h3>
          <div className="row server-controls">
            <button
              className="btn sm"
              onClick={() => startServer.mutate("v21")}
              disabled={startServer.isPending}
            >
              <Play size={13} /> Démarrer 2.1
            </button>
            <button
              className="btn sm"
              onClick={() => startServer.mutate("mv2")}
              disabled={startServer.isPending}
            >
              <Play size={13} /> Démarrer 2mv
            </button>
            <button
              className="btn ghost sm"
              onClick={() => stopServer.mutate()}
              disabled={stopServer.isPending}
            >
              <Square size={13} /> Arrêter
            </button>
            <span className="server-state muted small">
              {server
                ? `${server.backend ?? "—"} · ${server.status}`
                : "—"}
            </span>
          </div>
          <pre className="log">
            {server?.logTail?.trim()
              ? server.logTail
              : "(pas encore de logs)"}
          </pre>

          {saveError && <p className="form-error">{saveError}</p>}

          <div className="row end modal-actions">
            <button
              className="btn primary"
              onClick={save}
              disabled={update.isPending}
            >
              {update.isPending ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Save size={15} />
              )}
              Enregistrer
            </button>
            <button className="btn ghost" onClick={onClose}>
              Fermer
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
