import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";

import { useConfig, useServer, useInstallStatus } from "../lib/queries";
import { Button } from "@/components/ui/button";
import { HunyuanInstaller } from "./HunyuanInstaller";

/**
 * First-run onboarding: when no 3D backend is installed (mv2 path empty) and no
 * Hunyuan server is healthy, invite the user to install it in one click. Hidden
 * once a backend is configured or running. Self-contained — owns the installer
 * dialog state so it can be dropped anywhere in the layout.
 */
export function OnboardingBanner() {
  const configQ = useConfig();
  const serverQ = useServer();
  const installQ = useInstallStatus();
  const [open, setOpen] = useState(false);

  const c = configQ.data;
  if (!c) return null;

  const installed = c.hunyuan.mv2.dir.trim() !== "";
  const healthy = serverQ.data?.status === "healthy";
  const running = installQ.data?.running ?? false;

  // Nothing to onboard once installed or a server is up.
  if (installed || healthy) return null;

  return (
    <>
      {open && <HunyuanInstaller onClose={() => setOpen(false)} />}
      <div
        className="flex flex-wrap items-center gap-3 border-b border-border bg-primary/10 px-5 py-2.5 text-sm text-foreground"
        role="status"
      >
        <Sparkles size={16} className="shrink-0 text-primary" />
        <span>
          La génération 3D n'est pas encore installée. Installe le moteur
          Hunyuan en un clic (GPU NVIDIA requis).
        </span>
        <Button size="sm" className="ml-auto" onClick={() => setOpen(true)}>
          {running ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Installation…
            </>
          ) : (
            "Configurer la génération 3D"
          )}
        </Button>
      </div>
    </>
  );
}
