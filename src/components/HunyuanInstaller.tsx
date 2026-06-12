import { useMemo } from "react";
import {
  Download,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Square,
  Cpu,
  Type,
} from "lucide-react";

import type { InstallPhase, InstallProgress } from "../lib/types";
import {
  useInstallStatus,
  useInstallBackend,
  useCancelInstall,
  useInstallText3d,
  useConfig,
} from "../lib/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const PHASES: { key: InstallPhase; label: string }[] = [
  { key: "preflight", label: "Vérification du GPU NVIDIA" },
  { key: "python", label: "Python (géré par uv)" },
  { key: "code", label: "Code Hunyuan3D" },
  { key: "venv", label: "Environnement Python" },
  { key: "torch", label: "PyTorch (CUDA)" },
  { key: "deps", label: "Dépendances" },
  { key: "extensions", label: "Extensions CUDA" },
  { key: "weights", label: "Poids du modèle (plusieurs Go)" },
  { key: "config", label: "Configuration" },
  { key: "start", label: "Démarrage du serveur" },
];

function phaseIndex(p: InstallPhase): number {
  const i = PHASES.findIndex((x) => x.key === p);
  return i; // -1 for idle, PHASES.length-equivalent handled by `done`
}

export function HunyuanInstaller({ onClose }: { onClose: () => void }) {
  const statusQ = useInstallStatus();
  const install = useInstallBackend();
  const cancel = useCancelInstall();
  const installText3d = useInstallText3d();
  const configQ = useConfig();

  const st: InstallProgress | null = statusQ.data ?? null;
  const running = st?.running ?? false;
  const done = st?.done ?? false;
  const error = st?.error ?? null;
  const mv2Installed = !!configQ.data?.hunyuan?.mv2?.python;
  const text3dEnabled = !!configQ.data?.hunyuan?.mv2?.text3dEnabled;
  const curIdx = useMemo(
    () => (st ? phaseIndex(st.phase) : -1),
    [st],
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Cpu size={18} /> Installer la génération 3D (Hunyuan 2mv)
          </DialogTitle>
          <DialogDescription>
            Installe automatiquement le moteur 3D local. Aucun terminal requis —
            il faut seulement un <b>GPU NVIDIA</b> avec un driver récent. Le
            téléchargement (modèle + dépendances) fait plusieurs Go.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 py-4">
          {/* Progress bar */}
          {(running || done) && st && (
            <div className="flex flex-col gap-1.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    done ? "bg-ok" : "bg-primary",
                  )}
                  style={{ width: `${st.pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{st.message || "…"}</span>
                <span className="font-mono">{st.pct}%</span>
              </div>
            </div>
          )}

          {/* Phase checklist */}
          <ol className="flex flex-col gap-1.5">
            {PHASES.map((p, i) => {
              const isDone = done || (curIdx >= 0 && i < curIdx);
              const isCurrent = running && i === curIdx;
              return (
                <li
                  key={p.key}
                  className={cn(
                    "flex items-center gap-2 text-sm",
                    isCurrent
                      ? "font-medium text-foreground"
                      : isDone
                        ? "text-muted-foreground"
                        : "text-muted-foreground/60",
                  )}
                >
                  {isDone ? (
                    <CheckCircle2 size={15} className="shrink-0 text-ok" />
                  ) : isCurrent ? (
                    <Loader2
                      size={15}
                      className="shrink-0 animate-spin text-primary"
                    />
                  ) : (
                    <span className="size-[15px] shrink-0 rounded-full border border-current opacity-40" />
                  )}
                  {p.label}
                </li>
              );
            })}
          </ol>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/15 px-3 py-2 text-sm text-destructive">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Success */}
          {done && !error && (
            <div className="flex items-center gap-2 rounded-md bg-ok/15 px-3 py-2 text-sm text-ok">
              <CheckCircle2 size={15} className="shrink-0" />
              Installation terminée — le serveur Hunyuan est prêt.
            </div>
          )}

          {/* Log tail */}
          {st?.logTail?.trim() && (
            <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {st.logTail}
            </pre>
          )}

          {/* Optional add-on: native offline text-to-3D (HunyuanDiT). */}
          {mv2Installed && (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-secondary/20 px-3 py-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Type size={15} /> Text-to-3D natif (optionnel)
              </div>
              <p className="text-xs text-muted-foreground">
                Génère un modèle 3D directement depuis un texte, hors-ligne (sans
                OpenAI), via HunyuanDiT. Téléchargement supplémentaire ~8 Go ;
                VRAM accrue au démarrage du serveur.
              </p>
              {text3dEnabled ? (
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-2 text-sm text-ok">
                    <CheckCircle2 size={15} /> Activé
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={running || installText3d.isPending}
                    onClick={() => installText3d.mutate()}
                    title="Réinstalle les dépendances + le modèle et redémarre le serveur"
                  >
                    {installText3d.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Download size={13} />
                    )}
                    Réparer / réinstaller
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={running || installText3d.isPending}
                  onClick={() => installText3d.mutate()}
                >
                  {installText3d.isPending ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Download size={15} />
                  )}
                  Activer le text-to-3D (~8 Go)
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {running ? (
            <Button
              variant="ghost"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              <Square size={15} /> Annuler
            </Button>
          ) : (
            <Button
              onClick={() => install.mutate("mv2")}
              disabled={install.isPending}
            >
              {install.isPending ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Download size={15} />
              )}
              {done ? "Réinstaller" : "Installer"}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Fermer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
