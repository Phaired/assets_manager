import type { ServerStatus } from "../lib/types";

const LABELS: Record<ServerStatus["status"], string> = {
  stopped: "arrêté",
  starting: "démarrage…",
  healthy: "prêt",
  error: "erreur",
};

export function ServerPill({ server }: { server: ServerStatus | null }) {
  const status = server?.status ?? "stopped";
  const backend = server?.backend ?? "—";
  return (
    <span
      className={`pill pill-${status}`}
      title={server?.error ?? undefined}
      role="status"
      aria-live="polite"
    >
      <span className="pill-dot" />
      serveur {backend} · {LABELS[status]}
    </span>
  );
}
