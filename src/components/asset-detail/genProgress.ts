/** Best-effort live progress for a running 3D job, parsed from the Hunyuan
 *  server's log tail (carried in the polled ServerStatus). The diffusion loops
 *  print "N/M" / "P%"; we surface the last one with a coarse stage label.
 *  Returns null when nothing parseable is in view (→ indeterminate spinner). */
export function parseGenProgress(
  logTail: string | undefined,
): { label: string; pct: number | null } | null {
  if (!logTail) return null;
  const lines = logTail.replace(/\r/g, "").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    const frac = ln.match(/(\d+)\s*\/\s*(\d+)/);
    if (frac) {
      const cur = Number(frac[1]);
      const tot = Number(frac[2]);
      if (tot > 0 && cur <= tot) {
        const label = /Diffusion Sampling/i.test(ln)
          ? "Reconstruction de la forme"
          : /Volume Decoding/i.test(ln)
            ? "Décodage du volume"
            : /Loading pipeline/i.test(ln)
              ? "Chargement des modèles"
              : "Génération de l'image (texte → image)";
        return { label, pct: Math.min(100, Math.round((cur / tot) * 100)) };
      }
    }
  }
  // Stage hints that don't carry a fraction (texture paint is mostly silent).
  if (/Shape generation takes|Face Reduction takes/i.test(logTail)) {
    return { label: "Peinture de la texture", pct: null };
  }
  return null;
}
