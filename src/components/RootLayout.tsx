import { Outlet, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useEventBridge } from "@/lib/queries";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Root layout: mounts the Tauri event → query bridge once for the whole app,
 * provides tooltip + toast infrastructure, then renders the active route.
 * `useRouter` keeps this re-rendering tied to router context so the bridge stays
 * mounted for the app lifetime.
 */
export function RootLayout() {
  const qc = useQueryClient();
  useEventBridge(qc);
  // Touch the router so the component participates in the router tree.
  useRouter();
  return (
    <TooltipProvider delayDuration={300}>
      <Outlet />
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
