// Lightweight UI preferences persisted via tauri-plugin-store (JS side).
// Distinct from the Rust-owned settings store ("settings.json") — this file
// ("prefs.json") only holds ephemeral UI state like the last-open project.

import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("prefs.json");

const LAST_PROJECT = "lastProject";

/** The project that was open when the app last closed, if any. */
export async function getLastProject(): Promise<string | null> {
  try {
    return (await store.get<string>(LAST_PROJECT)) ?? null;
  } catch {
    return null;
  }
}

/** Remember (or clear) the currently selected project. Best-effort. */
export async function setLastProject(name: string | null): Promise<void> {
  try {
    if (name) await store.set(LAST_PROJECT, name);
    else await store.delete(LAST_PROJECT);
    await store.save();
  } catch {
    /* preferences are best-effort; ignore store failures */
  }
}
