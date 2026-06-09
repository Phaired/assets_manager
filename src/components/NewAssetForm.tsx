import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import type { Backend } from "../lib/types";
import { PRESETS } from "../lib/constants";
import { useCreateAsset } from "../lib/queries";

export function NewAssetForm({
  project,
  onCreated,
}: {
  project: string | null;
  onCreated: (id: string) => void;
}) {
  const createAsset = useCreateAsset(project);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [backend, setBackend] = useState<Backend>("auto");
  const [error, setError] = useState<string | null>(null);

  function applyPreset(text: string) {
    if (!text) return;
    setDescription(text);
    const chosen = PRESETS.find((p) => p.text === text);
    if (chosen && !name.trim()) setName(chosen.name);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!project) {
      setError("Crée d'abord un projet.");
      return;
    }
    if (!name.trim()) return;
    try {
      const a = await createAsset.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        tags: [],
        backend,
      });
      setName("");
      setDescription("");
      onCreated(a.id);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form className="card new-asset" onSubmit={submit}>
      <h3>Nouvel asset</h3>

      <input
        className="input"
        placeholder="Nom (ex. crusher)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <select
        className="input preset-select"
        value=""
        onChange={(e) => {
          applyPreset(e.target.value);
          e.currentTarget.selectedIndex = 0;
        }}
        aria-label="Exemples de prompt"
      >
        <option value="">💡 Exemples de prompt…</option>
        {PRESETS.map((p) => (
          <option key={p.name} value={p.text}>
            {p.name}
          </option>
        ))}
      </select>

      <textarea
        className="input"
        placeholder="Description (style, couleurs, forme…)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <select
        className="input"
        value={backend}
        onChange={(e) => setBackend(e.target.value as Backend)}
        aria-label="Backend"
      >
        <option value="auto">Backend: auto</option>
        <option value="v21">Hunyuan 2.1 (image unique)</option>
        <option value="mv2">Hunyuan 2mv (4 vues)</option>
      </select>

      {error && <p className="form-error">{error}</p>}

      <button
        type="submit"
        className="btn primary"
        disabled={createAsset.isPending || !project}
      >
        {createAsset.isPending ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Sparkles size={15} />
        )}
        Créer l'asset
      </button>
    </form>
  );
}
