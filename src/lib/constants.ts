import type { AssetKind, AudioKind, AudioStatus, StageKey } from "./types";

export interface StageDef {
  key: StageKey;
  label: string;
  hint: string;
  /** Rough typical duration, shown as an ETA hint while the stage runs. */
  eta: string;
}

export const STAGES: StageDef[] = [
  {
    key: "multiview",
    label: "Multivue (OpenAI)",
    hint: "Génère la planche 4 vues via l'API OpenAI.",
    eta: "~20–60 s",
  },
  {
    key: "model3d",
    label: "3D (Hunyuan)",
    hint: "Reconstruction + texture sur GPU — peut prendre 1 à 3 min.",
    eta: "~1–3 min",
  },
  {
    key: "export",
    label: "Export OBJ",
    hint: "Convertit le .glb en .obj + .mtl + texture.",
    eta: "~10–30 s",
  },
];

export const ALL_STAGES: StageKey[] = ["multiview", "model3d", "export"];

/** Unique stage of a `kind === "texture"` asset. */
export const TEXTURE_STAGE: StageDef = {
  key: "texture",
  label: "Texture (OpenAI)",
  hint: "Génère une texture seamless tileable via l'API OpenAI.",
  eta: "~20–60 s",
};

export const TEXTURE_STAGES: StageDef[] = [TEXTURE_STAGE];

/** Stage definitions of an asset, by kind + source. Native text-to-3D
 *  (source "text") drops the OpenAI multiview stage entirely. */
export function stageDefsForKind(kind: AssetKind, source?: string): StageDef[] {
  if (kind === "texture") return TEXTURE_STAGES;
  if (source === "text") return [STAGES[1], STAGES[2]]; // model3d, export — no OpenAI
  return STAGES;
}

/** Stage keys of an asset, by kind + source. */
export function stagesForKind(kind: AssetKind, source?: string): StageKey[] {
  if (kind === "texture") return ["texture"];
  if (source === "text") return ["model3d", "export"];
  return ALL_STAGES;
}

export const VIEW_FILES = ["front", "back", "left", "right"] as const;

// --- audio --------------------------------------------------------------

export const AUDIO_KIND_LABELS: Record<AudioKind, string> = {
  voice: "Voix",
  sfx: "Son (SFX)",
  music: "Musique",
};

/** Status dot color classes (shared by the audio list + detail). */
export const AUDIO_STATUS_COLOR: Record<AudioStatus, string> = {
  pending: "bg-muted-foreground/40",
  queued: "bg-run",
  running: "bg-run animate-pulse",
  done: "bg-ok",
  error: "bg-destructive",
};

/** Per-kind accent hue (hex) — drives the player glow, icon chips and EQ bars.
 *  Deliberately distinct from the app's blue (#6ea8fe) and from each other so
 *  the three kinds read at a glance. */
export const AUDIO_KIND_ACCENT: Record<AudioKind, string> = {
  voice: "#fb7185", // rose
  sfx: "#38bdf8", // cyan
  music: "#34d399", // emerald
};

// --- multiview prompt templates -------------------------------------------
// `{subject}` = description de l'asset (ou son nom) ; `{style}` = style du
// projet. « character » DOIT rester identique a DEFAULT_MULTIVIEW_TEMPLATE
// dans src-tauri/src/config.rs (c'est le defaut applique quand le reglage est
// vide). « object » est une variante neutre pour les props/objets.

export const MULTIVIEW_TEMPLATES = {
  character: `Create one production-ready 2x2 orthographic character turnaround sheet for multi-view image-to-3D reconstruction.
CHARACTER: {subject}.
{style}
PANEL ORDER: top-left exact front view; top-right exact back view; bottom-left exact left profile; bottom-right exact right profile.
CONSISTENCY: depict the exact same single character in all four panels. Lock identical body proportions, colors, matte materials, accessories and neutral relaxed A-pose. Front and back must match. Left and right profiles must be true mirrored orthographic profiles, not three-quarter views.
FRAMING: show the complete character from highest point to soles in every panel. The character must occupy only about 60 percent of each panel height, centered horizontally and vertically, with at least 15 percent empty background above, below, left and right. Keep a clearly visible gap below the feet. Nothing may touch or cross a panel edge or the sheet midpoint.
STYLE: appealing original stylized game character, simple polished low-poly 3D render, broad readable volumes, a few large flat color regions, very simple matte textures, no tiny details. Keep arms, legs and accessories clearly separated from the torso.
BACKGROUND: perfectly uniform solid light gray in all panels. No floor, horizon, cast shadow, ambient shadow, reflection, gradient, scenery or props.
STRICTLY AVOID: cropping, labels, letters, text, panel borders, extra objects, extra characters, perspective view, three-quarter view, dynamic pose or inconsistent design.`,
  object: `Create one production-ready 2x2 orthographic turnaround sheet of a single object for multi-view image-to-3D reconstruction.
SUBJECT: {subject}.
{style}
PANEL ORDER: top-left exact front view; top-right exact back view; bottom-left exact left side view; bottom-right exact right side view.
CONSISTENCY: depict the exact same single object in all four panels. Lock identical proportions, colors, matte materials and orientation. Front and back must match. Left and right sides must be true mirrored orthographic side views, not three-quarter views.
FRAMING: show the complete object in every panel. The object must occupy only about 60 percent of each panel height, centered horizontally and vertically, with at least 15 percent empty background above, below, left and right. Nothing may touch or cross a panel edge or the sheet midpoint.
STYLE: stylized game prop, simple polished low-poly 3D render, broad readable volumes, a few large flat color regions, very simple matte textures, no tiny details.
BACKGROUND: perfectly uniform solid light gray in all panels. No floor, horizon, cast shadow, ambient shadow, reflection, gradient, scenery or props.
STRICTLY AVOID: cropping, labels, letters, text, panel borders, extra objects, extra characters, perspective view, three-quarter view or inconsistent design.`,
} as const;

// Prompts d'exemple — meme style que tools/brainrot_manifest.py : syntagme nominal
// anglais, concis et concret (type de creature + couleurs/matieres/accessoires),
// SANS mots de style (le gabarit prompt_for ajoute deja low-poly / matte / flat colors).
export interface Preset {
  name: string;
  text: string;
}

export const PRESETS: Preset[] = [
  {
    name: "Crusher Bot",
    text: "a stocky steel-blue mining robot with massive metal jaws and chunky tank treads",
  },
  {
    name: "Mushling",
    text: "a cheerful mushroom creature with a big red cap dotted white, round eyes and short stubby legs",
  },
  {
    name: "Frog Wizard",
    text: "a round green frog wizard with a tall pointy purple hat and a small glowing staff",
  },
  {
    name: "Lava Golem",
    text: "a chunky stone golem with glowing orange cracks and mossy boulder shoulders",
  },
  {
    name: "Banana Diver",
    text: "a banana creature wearing a round brass diving helmet and small flippers",
  },
  {
    name: "Cat Ninja",
    text: "a sleek black cat ninja with a red headband and two tiny toy daggers",
  },
  {
    name: "Mushroom Tank",
    text: "a red-capped mushroom fused with chunky toy tank treads and a stubby turret",
  },
  {
    name: "Snow Yeti",
    text: "a fluffy white yeti with rounded blue horns and big mittened hands",
  },
];
