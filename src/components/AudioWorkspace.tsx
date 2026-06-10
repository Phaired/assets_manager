import { AudioLines } from "lucide-react";

import { useAudio } from "../lib/queries";
import { useAppState } from "../lib/appState";
import { AudioItemDetail } from "./AudioItemDetail";
import { NewAudioForm } from "./NewAudioForm";

/** Main pane of the audio section (route `/audio`): the selected item's detail,
 *  or the create-and-generate hub when nothing is selected. */
export function AudioWorkspace() {
  const { project, audioId, setAudioId } = useAppState();
  const audioQ = useAudio(project);
  const items = audioQ.data?.items ?? [];
  const item = audioId ? (items.find((i) => i.id === audioId) ?? null) : null;

  if (!project) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
        <div
          className="flex size-20 items-center justify-center rounded-lg border border-border bg-card"
          aria-hidden
        >
          <AudioLines size={28} className="text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground">
          Sélectionne ou crée un projet pour générer de l'audio.
        </p>
      </div>
    );
  }

  if (item) {
    return (
      <AudioItemDetail
        project={project}
        item={item}
        onDeleted={() => setAudioId(null)}
      />
    );
  }

  return (
    <div className="flex min-h-full p-8">
      <div className="m-auto flex w-full max-w-2xl flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">Nouvel audio</h2>
          <p className="text-sm text-muted-foreground">
            Génère un son, une voix ou une musique via ElevenLabs.
          </p>
        </div>
        <NewAudioForm project={project} onCreated={setAudioId} />
      </div>
    </div>
  );
}
