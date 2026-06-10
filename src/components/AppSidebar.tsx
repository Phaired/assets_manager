import { useRouterState } from "@tanstack/react-router";

import type { ProjectBundle } from "../lib/types";
import { Assets3dSidebar } from "./Assets3dSidebar";
import { AudioSidebar } from "./AudioSidebar";

/** Contextual sidebar: the active section's list and its quick actions.
 *  Project switching lives in the header; section switching in the rail. */
export function AppSidebar({
  bundle,
  loading,
}: {
  bundle: ProjectBundle | null;
  loading: boolean;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAudio = pathname.startsWith("/audio");

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 border-r border-border bg-card p-4">
      {isAudio ? (
        <AudioSidebar />
      ) : (
        <Assets3dSidebar bundle={bundle} loading={loading} />
      )}
    </aside>
  );
}
