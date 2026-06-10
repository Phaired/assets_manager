import { AudioLines, Box, Boxes, Settings } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";

import { useAppState } from "../lib/appState";
import { cn } from "@/lib/utils";

/** Far-left rail: app sections on top, global utilities at the bottom.
 *  This is the primary navigation — the sidebar only carries the contextual
 *  list of the active section. */
export function ActivityRail() {
  const { openViewer, openSettings } = useAppState();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAudio = pathname.startsWith("/audio");

  return (
    <nav
      aria-label="Sections"
      className="flex w-[68px] shrink-0 flex-col items-center gap-1.5 border-r border-border bg-card/60 px-2 py-3"
    >
      <RailLink to="/" label="3D" title="Assets 3D" active={!isAudio}>
        <Boxes size={20} />
      </RailLink>
      <RailLink to="/audio" label="Audio" title="Audio" active={isAudio}>
        <AudioLines size={20} />
      </RailLink>

      <div className="grow" />

      <RailAction label="Viewer" title="Visualiseur 3D" onClick={() => openViewer(null)}>
        <Box size={20} />
      </RailAction>
      <RailAction label="Réglages" title="Réglages" onClick={openSettings}>
        <Settings size={20} />
      </RailAction>
    </nav>
  );
}

const itemClass = (active: boolean) =>
  cn(
    "relative flex w-13 flex-col items-center gap-1 rounded-lg py-2 text-[10px] font-medium tracking-wide transition-colors",
    active
      ? "bg-primary/15 text-[var(--accent-2)]"
      : "text-[var(--text-2)]/75 hover:bg-muted hover:text-foreground",
  );

function ActiveIndicator() {
  return (
    <span
      aria-hidden
      className="absolute inset-y-2.5 -left-2 w-[3px] rounded-full bg-primary"
    />
  );
}

function RailLink({
  to,
  label,
  title,
  active,
  children,
}: {
  to: string;
  label: string;
  title: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      title={title}
      aria-label={title}
      aria-current={active ? "page" : undefined}
      className={itemClass(active)}
    >
      {active && <ActiveIndicator />}
      {children}
      <span>{label}</span>
    </Link>
  );
}

function RailAction({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={itemClass(false)}
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}
