import React from "react";
import ReactDOM from "react-dom/client";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { AppShell } from "./components/AppShell";
import { Assets3dWorkspace } from "./components/Assets3dWorkspace";
import { AudioWorkspace } from "./components/AudioWorkspace";
import { RootLayout } from "./components/RootLayout";
import "@fontsource-variable/archivo";
import "@fontsource-variable/jetbrains-mono";
import "./styles/index.css";

const queryClient = new QueryClient({
  // Every failed mutation surfaces a toast automatically; components add their
  // own success toasts where a positive confirmation is useful.
  mutationCache: new MutationCache({
    onError: (err) => toast.error(String(err)),
  }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// --- code-based routing (no file-based generation) ----------------------

const rootRoute = createRootRoute({
  component: RootLayout,
});

// Pathless layout route: the shared app shell (sidebar + header) wrapping both
// sections, so the selected project survives navigation between them.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: Assets3dWorkspace,
});

const audioRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/audio",
  component: AudioWorkspace,
});

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([indexRoute, audioRoute]),
]);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
