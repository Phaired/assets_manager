import type { StageKey } from "./types";

export interface StageDef {
  key: StageKey;
  label: string;
  hint: string;
}

export const STAGES: StageDef[] = [
  {
    key: "multiview",
    label: "Multivue (OpenAI)",
    hint: "Génère la planche 4 vues via l'API OpenAI.",
  },
  {
    key: "model3d",
    label: "3D (Hunyuan)",
    hint: "Reconstruction + texture sur GPU — peut prendre 1 à 3 min.",
  },
  {
    key: "export",
    label: "Export OBJ",
    hint: "Convertit le .glb en .obj + .mtl + texture.",
  },
];

export const ALL_STAGES: StageKey[] = ["multiview", "model3d", "export"];

export const VIEW_FILES = ["front", "back", "left", "right"] as const;

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
