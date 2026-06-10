import { useState } from "react";
import { FolderPlus, Loader2, Plus, Wallet } from "lucide-react";
import { toast } from "sonner";

import type { ServerStatus } from "../lib/types";
import { useCreateProject } from "../lib/queries";
import { useAppState } from "../lib/appState";
import { ServerPill } from "./ServerPill";
import { QuickSettings } from "./QuickSettings";
import { fmtUsd } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Top bar: identity, the global project switcher, and ambient status
 *  (spend, server, quick settings). Section navigation lives in the rail. */
export function Header({
  projects,
  server,
  spendUsd,
  budgetUsd,
}: {
  projects: string[];
  server: ServerStatus | null;
  spendUsd: number | null;
  budgetUsd: number | null;
}) {
  const { project, setProject } = useAppState();
  const createProject = useCreateProject();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const overBudget =
    budgetUsd != null && spendUsd != null && spendUsd > budgetUsd + 1e-9;

  async function submitNewProject(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const p = await createProject.mutateAsync(name);
    setNewName("");
    setCreating(false);
    toast.success(`Projet « ${p.name} » créé`);
    setProject(p.name);
  }

  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--accent-2)] to-[#b86f2a] shadow-[0_0_18px_var(--accent-glow)]"
          aria-hidden
        >
          <span className="size-3 rotate-45 rounded-[3px] bg-[var(--accent-ink)]" />
        </span>
        <h1 className="font-mono text-[13px] font-semibold tracking-[0.16em] text-foreground uppercase">
          assets_gen
        </h1>

        <span className="h-6 w-px shrink-0 bg-border" aria-hidden />

        <Select
          value={project ?? ""}
          disabled={!projects.length}
          onValueChange={setProject}
        >
          <SelectTrigger
            className="h-8 w-48 border-transparent bg-secondary/50 font-medium"
            aria-label="Projet"
          >
            <SelectValue placeholder="Aucun projet" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Popover open={creating} onOpenChange={setCreating}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Nouveau projet"
              aria-label="Nouveau projet"
            >
              <FolderPlus size={15} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-3">
            <form className="flex items-center gap-2" onSubmit={submitNewProject}>
              <Input
                autoFocus
                placeholder="Nom du projet…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button
                type="submit"
                size="icon-sm"
                className="shrink-0"
                aria-label="Créer le projet"
                disabled={createProject.isPending || !newName.trim()}
              >
                {createProject.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plus size={14} />
                )}
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex items-center gap-2">
        {spendUsd != null && (
          <Badge
            variant={overBudget ? "destructive" : "secondary"}
            className="gap-1.5"
            title="Dépense estimée OpenAI sur ce projet / budget"
          >
            <Wallet size={14} />
            {fmtUsd(spendUsd)}
            {budgetUsd != null && (
              <span className="opacity-70">/ {fmtUsd(budgetUsd)}</span>
            )}
          </Badge>
        )}
        <ServerPill server={server} />
        <QuickSettings />
      </div>
    </header>
  );
}
