// Shared app state across the two top-level sections (3D assets / audio).
// Provided by AppShell; consumed by the sidebar lists and the route panes.

import { createContext, useContext } from "react";

export interface AppStateValue {
  /** Currently selected project (shared by both sections). */
  project: string | null;
  setProject: (p: string) => void;
  /** Selected 3D asset id (section "/"). */
  assetId: string | null;
  setAssetId: (id: string | null) => void;
  /** Selected audio item id (section "/audio"). */
  audioId: string | null;
  setAudioId: (id: string | null) => void;
  /** Open the standalone 3D viewer (optionally with a source url). */
  openViewer: (src: string | null) => void;
  /** Open the settings dialog. */
  openSettings: () => void;
}

export const AppStateContext = createContext<AppStateValue | null>(null);

export function useAppState(): AppStateValue {
  const v = useContext(AppStateContext);
  if (!v) throw new Error("useAppState must be used within AppShell");
  return v;
}
