import { Loader2, Power } from "lucide-react";
import { toast } from "sonner";

import type { ServerStatus } from "../lib/types";
import { useServerStop } from "../lib/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LABELS: Record<ServerStatus["status"], string> = {
  stopped: "arrêté",
  starting: "démarrage…",
  healthy: "prêt",
  error: "erreur",
};

const DOT_CLASS: Record<ServerStatus["status"], string> = {
  stopped: "bg-muted-foreground",
  starting: "bg-run animate-pulse",
  healthy: "bg-ok",
  error: "bg-destructive",
};

export function ServerPill({ server }: { server: ServerStatus | null }) {
  const status = server?.status ?? "stopped";
  const backend = server?.backend ?? "—";
  const stop = useServerStop();

  // Stopping the Hunyuan server frees the GPU VRAM. The worker sidecar (light)
  // keeps running. Only offer it while the server is alive/managed.
  const canStop =
    (status === "healthy" || status === "starting") && server?.managed !== false;

  return (
    <div className="flex items-center gap-1.5">
      <Badge
        variant="outline"
        className="gap-1.5 text-muted-foreground"
        title={server?.error ?? undefined}
        role="status"
        aria-live="polite"
      >
        <span
          className={cn("size-1.5 rounded-full", DOT_CLASS[status])}
          aria-hidden
        />
        serveur {backend} · {LABELS[status]}
      </Badge>
      {canStop && (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Arrêter le serveur (libère la VRAM)"
          aria-label="Arrêter le serveur"
          disabled={stop.isPending}
          onClick={() =>
            stop.mutate(undefined, {
              onSuccess: () => toast.success("Serveur arrêté"),
              onError: (e) =>
                toast.error(`Échec de l'arrêt : ${String(e)}`),
            })
          }
        >
          {stop.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Power size={14} />
          )}
        </Button>
      )}
    </div>
  );
}
