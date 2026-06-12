import { useEffect, useState } from "react";

/** Below this content width the docked settings panel would starve the viewer
 *  (340px panel + <540px viewer), so it switches to a slide-over. Measured on
 *  the workbench row itself — viewport queries lie here because the rail +
 *  sidebar chrome (~356px) is fixed. */
const COMPACT_THRESHOLD = 880;

/** Takes the observed element (from a callback ref, so the observer attaches
 *  even when the element appears after an empty-state render). */
export function useCompactLayout(el: HTMLElement | null): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      setCompact(w < COMPACT_THRESHOLD);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return compact;
}
