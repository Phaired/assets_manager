import { useEffect, useState } from "react";
import {
  Save,
  Loader2,
  Play,
  Square,
  FolderOpen,
  Download,
  ChevronDown,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

import type { ConfigPatch, Gen3d } from "../lib/types";
import { HunyuanInstaller } from "./HunyuanInstaller";
import {
  useConfig,
  useServer,
  useServerStart,
  useServerStop,
  useUpdateConfig,
} from "../lib/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

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

type HunBackend = "v21" | "mv2";
interface HunEntryForm {
  dir: string;
  python: string;
  port: string;
}
type HunyuanForm = Record<HunBackend, HunEntryForm>;

const HUN_LABELS: Record<HunBackend, string> = {
  v21: "Hunyuan 2.1",
  mv2: "Hunyuan 2mv",
};

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
  const [hun, setHun] = useState<HunyuanForm | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showInstaller, setShowInstaller] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
    setHun({
      v21: {
        dir: c.hunyuan.v21.dir,
        python: c.hunyuan.v21.python,
        port: String(c.hunyuan.v21.port),
      },
      mv2: {
        dir: c.hunyuan.mv2.dir,
        python: c.hunyuan.mv2.python,
        port: String(c.hunyuan.mv2.port),
      },
    });
  }, [configQ.data]);

  function setGenNum(k: keyof Gen3d, raw: string) {
    setGen((g) => (g ? { ...g, [k]: Number(raw) } : g));
  }

  function setHunField(b: HunBackend, k: keyof HunEntryForm, v: string) {
    setHun((h) => (h ? { ...h, [b]: { ...h[b], [k]: v } } : h));
  }

  // Native pickers (Tauri dialog plugin) for the Hunyuan paths.
  async function pickHunDir(b: HunBackend) {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setHunField(b, "dir", sel);
  }
  async function pickHunPython(b: HunBackend) {
    const sel = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "Python", extensions: ["exe"] }],
    });
    if (typeof sel === "string") setHunField(b, "python", sel);
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
    if (hun) {
      const entry = (e: HunEntryForm) => ({
        dir: e.dir.trim(),
        python: e.python.trim(),
        port: Number(e.port),
      });
      patch.hunyuan = { v21: entry(hun.v21), mv2: entry(hun.mv2) };
    }
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
    <>
      {showInstaller && (
        <HunyuanInstaller onClose={() => setShowInstaller(false)} />
      )}
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
      >
      <DialogContent
        aria-labelledby="settings-title"
        className="max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl"
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle id="settings-title">Réglages</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 py-4">
          {configQ.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Chargement…
            </p>
          )}

          {c && gen && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="settings-key">Clé OpenAI</Label>
                <Input
                  id="settings-key"
                  type="password"
                  value={key}
                  placeholder={
                    c.openaiKeySet
                      ? "déjà configurée — laisser vide pour garder"
                      : "sk-…"
                  }
                  onChange={(e) => setKey(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="settings-model">Modèle image</Label>
                <Input
                  id="settings-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="settings-quality">Qualité</Label>
                <Select value={quality} onValueChange={setQuality}>
                  <SelectTrigger id="settings-quality" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">low</SelectItem>
                    <SelectItem value="medium">medium</SelectItem>
                    <SelectItem value="high">high</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="settings-budget">Budget USD</Label>
                  <Input
                    id="settings-budget"
                    type="number"
                    step="0.5"
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="settings-cost">Coût estimé / image</Label>
                  <Input
                    id="settings-cost"
                    type="number"
                    step="0.001"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="settings-timeout">Timeout image (s)</Label>
                  <Input
                    id="settings-timeout"
                    type="number"
                    step="10"
                    value={timeout}
                    onChange={(e) => setTimeoutVal(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="settings-backend">Backend par défaut</Label>
                  <Select
                    value={backend}
                    onValueChange={(v) => setBackend(v as "v21" | "mv2")}
                  >
                    <SelectTrigger id="settings-backend" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="v21">Hunyuan 2.1</SelectItem>
                      <SelectItem value="mv2">Hunyuan 2mv</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Workspace :{" "}
                <code className="font-mono">{c.workspaceDir}</code>
              </p>

              <Separator />

              <h3 className="text-sm font-semibold">
                Paramètres de génération 3D
              </h3>
              <div className="grid grid-cols-2 gap-4">
                {GEN_NUMS.map((g) => (
                  <div className="flex flex-col gap-1.5" key={g.key}>
                    <Label htmlFor={`gen-${g.key}`}>{g.label}</Label>
                    <Input
                      id={`gen-${g.key}`}
                      type="number"
                      step={g.step}
                      value={String(gen[g.key])}
                      onChange={(e) => setGenNum(g.key, e.target.value)}
                    />
                  </div>
                ))}
                <label className="flex items-center gap-2 self-end text-sm font-medium">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
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

              <Separator />

              <h3 className="text-sm font-semibold">Backends 3D (Hunyuan)</h3>
              <p className="text-xs text-muted-foreground">
                La génération 3D locale a besoin du moteur Hunyuan3D. Le plus
                simple : laisse l'app l'installer automatiquement (un GPU NVIDIA
                récent suffit, aucun terminal requis).
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setShowInstaller(true)}>
                  <Download size={13} /> Installer automatiquement (recommandé)
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <ChevronDown
                    size={13}
                    className={showAdvanced ? "rotate-180 transition" : "transition"}
                  />
                  Avancé : chemins manuels
                </Button>
              </div>
              {showAdvanced &&
                hun &&
                (["v21", "mv2"] as HunBackend[]).map((b) => (
                  <div
                    className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
                    key={b}
                  >
                    <strong className="text-sm">{HUN_LABELS[b]}</strong>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`hun-${b}-dir`}>Dossier du repo</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`hun-${b}-dir`}
                          value={hun[b].dir}
                          placeholder="C:\…\Hunyuan3D-…"
                          onChange={(e) =>
                            setHunField(b, "dir", e.target.value)
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => pickHunDir(b)}
                        >
                          <FolderOpen size={13} /> Parcourir
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`hun-${b}-python`}>
                        Python (venv du serveur)
                      </Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`hun-${b}-python`}
                          value={hun[b].python}
                          placeholder="C:\…\.venv\Scripts\python.exe"
                          onChange={(e) =>
                            setHunField(b, "python", e.target.value)
                          }
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => pickHunPython(b)}
                        >
                          <FolderOpen size={13} /> Parcourir
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`hun-${b}-port`}>Port</Label>
                      <Input
                        id={`hun-${b}-port`}
                        type="number"
                        value={hun[b].port}
                        onChange={(e) =>
                          setHunField(b, "port", e.target.value)
                        }
                      />
                    </div>
                  </div>
                ))}

              <Separator />

              <h3 className="text-sm font-semibold">Serveur Hunyuan</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => startServer.mutate("v21")}
                  disabled={startServer.isPending}
                >
                  <Play size={13} /> Démarrer 2.1
                </Button>
                <Button
                  size="sm"
                  onClick={() => startServer.mutate("mv2")}
                  disabled={startServer.isPending}
                >
                  <Play size={13} /> Démarrer 2mv
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stopServer.mutate()}
                  disabled={stopServer.isPending}
                >
                  <Square size={13} /> Arrêter
                </Button>
                <span className="text-xs text-muted-foreground">
                  {server
                    ? `${server.backend ?? "—"} · ${server.status}`
                    : "—"}
                </span>
              </div>
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                {server?.logTail?.trim()
                  ? server.logTail
                  : "(pas encore de logs)"}
              </pre>

              {saveError && (
                <p className="rounded-md bg-destructive/15 px-3 py-2 text-sm text-destructive">
                  {saveError}
                </p>
              )}
            </>
          )}
        </div>

        {c && gen && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
            <Button onClick={save} disabled={update.isPending}>
              {update.isPending ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Save size={15} />
              )}
              Enregistrer
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Fermer
            </Button>
          </div>
        )}
      </DialogContent>
      </Dialog>
    </>
  );
}
