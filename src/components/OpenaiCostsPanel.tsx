import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import type { CostsSummary } from "../lib/types";
import { openaiCosts } from "../lib/api";
import { Button } from "@/components/ui/button";

function dayLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
  });
}

/** Dépenses réellement facturées par OpenAI (toute l'organisation), lues via
 *  la Costs API (clé admin). Chargé à la demande — un appel réseau par clic. */
export function OpenaiCostsPanel({ adminKeySet }: { adminKeySet: boolean }) {
  const [summary, setSummary] = useState<CostsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSummary(await openaiCosts(30));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  const last7 = summary
    ? summary.days.slice(-7).reduce((s, d) => s + d.amountUsd, 0)
    : 0;
  const maxDay = summary
    ? Math.max(...summary.days.map((d) => d.amountUsd), 0.000001)
    : 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={load}
          disabled={loading || !adminKeySet}
          title={
            adminKeySet
              ? "Interroge la Costs API d'OpenAI (facturation réelle)"
              : "Renseigne d'abord la clé admin OpenAI ci-dessus"
          }
        >
          {loading ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <RefreshCw size={13} />
          )}
          Charger les dépenses (30 j)
        </Button>
        {summary && (
          <span className="text-sm">
            <span className="font-mono font-semibold">
              ${summary.totalUsd.toFixed(2)}
            </span>{" "}
            <span className="text-muted-foreground">
              sur 30 j · ${last7.toFixed(2)} sur 7 j
            </span>
          </span>
        )}
      </div>

      {!adminKeySet && (
        <p className="text-xs text-muted-foreground">
          Nécessite une clé <code className="font-mono">sk-admin-…</code> (à
          créer sur platform.openai.com → Organization → Admin keys — une clé
          <code className="font-mono"> sk-proj-…</code> ne suffit pas), à
          enregistrer ci-dessus d'abord. Les montants viennent de la
          facturation OpenAI : toute l'organisation, pas seulement cette app,
          avec ~24 h de délai.
        </p>
      )}

      {error && (
        <p className="rounded-md bg-destructive/15 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {summary && summary.days.length > 0 && (
        <div className="flex h-20 items-end gap-[2px] rounded-md border border-border bg-card p-2">
          {summary.days.map((d) => (
            <div
              key={d.startTime}
              className="group relative flex-1 rounded-sm bg-primary/60 transition-colors hover:bg-primary"
              style={{
                height: `${Math.max(4, (d.amountUsd / maxDay) * 100)}%`,
              }}
              title={`${dayLabel(d.startTime)} : $${d.amountUsd.toFixed(3)}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
