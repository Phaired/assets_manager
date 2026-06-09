import { Outlet, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEventBridge } from "../lib/queries";

/**
 * Root layout: mounts the Tauri event → query bridge once for the whole app,
 * then renders the active route. `useRouter` keeps this re-rendering tied to
 * router context so the bridge stays mounted for the app lifetime.
 */
export function RootLayout() {
  const qc = useQueryClient();
  useEventBridge(qc);
  // Touch the router so the component participates in the router tree.
  useRouter();
  return <Outlet />;
}
