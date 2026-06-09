/** mm:ss elapsed since an ISO timestamp, or "" when no timestamp. */
export function elapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Last non-empty line of a multi-line log tail. */
export function lastLine(s: string | null | undefined): string {
  if (!s) return "";
  const lines = s.split("\n").filter((l) => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1] : "";
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}
