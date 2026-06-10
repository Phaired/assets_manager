import type { ServerStatus } from "../lib/types";
import { Badge } from "@/components/ui/badge";
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
  return (
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
  );
}
