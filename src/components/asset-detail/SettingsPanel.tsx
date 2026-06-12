import { X } from "lucide-react";

import type { Asset, StageState } from "@/lib/types";
import type { AssetImagePlan } from "@/lib/assetStatus";
import { LinkedAudioSection } from "../LinkedAudioSection";
import { GenerationTab } from "./GenerationTab";
import { DecimateTab } from "./DecimateTab";
import { PromptTab } from "./PromptTab";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Right-hand settings panel of the workbench: every parameter surface that
 *  used to be a stacked collapsible, flattened into tabs. Tab contents stay
 *  mounted (forceMount) so unsaved drafts survive tab switches. */
export function SettingsPanel({
  project,
  asset,
  profile,
  plan,
  model3dState,
  decimateState,
  jobBusy,
  textured,
  onClose,
}: {
  project: string;
  asset: Asset;
  profile: "text3d" | "image3d" | "texture";
  plan: AssetImagePlan | null;
  model3dState: StageState | undefined;
  decimateState: StageState | undefined;
  jobBusy: boolean;
  textured: boolean;
  /** Present in compact (slide-over) mode only. */
  onClose?: () => void;
}) {
  const isTexture = profile === "texture";

  const tabClass =
    "min-h-0 flex-1 data-[state=inactive]:hidden";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Réglages
        </span>
        <span className="flex-1" />
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fermer les réglages"
            onClick={onClose}
          >
            <X size={16} />
          </Button>
        )}
      </div>

      <Tabs
        defaultValue={isTexture ? "prompt" : "generation"}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="shrink-0 px-3 pt-3 pb-2">
          <TabsList
            className={
              isTexture ? "grid w-full grid-cols-2" : "grid w-full grid-cols-4"
            }
          >
            {!isTexture && (
              <TabsTrigger value="generation" className="px-1 text-xs">
                Génération
              </TabsTrigger>
            )}
            {!isTexture && (
              <TabsTrigger value="decimate" className="px-1 text-xs">
                Décimation
              </TabsTrigger>
            )}
            <TabsTrigger value="prompt" className="px-1 text-xs">
              Prompt
            </TabsTrigger>
            <TabsTrigger value="audio" className="px-1 text-xs">
              Audio
            </TabsTrigger>
          </TabsList>
        </div>

        {!isTexture && (
          <TabsContent value="generation" forceMount className={tabClass}>
            <ScrollArea className="h-full">
              <div className="px-3 pb-4 pt-1">
                <GenerationTab
                  project={project}
                  asset={asset}
                  plan={plan}
                  jobBusy={jobBusy}
                />
              </div>
            </ScrollArea>
          </TabsContent>
        )}

        {!isTexture && (
          <TabsContent value="decimate" forceMount className={tabClass}>
            <ScrollArea className="h-full">
              <div className="px-3 pb-4 pt-1">
                <DecimateTab
                  project={project}
                  asset={asset}
                  model3dState={model3dState}
                  decimateState={decimateState}
                  jobBusy={jobBusy}
                  textured={textured}
                />
              </div>
            </ScrollArea>
          </TabsContent>
        )}

        <TabsContent value="prompt" forceMount className={tabClass}>
          <ScrollArea className="h-full">
            <div className="px-3 pb-4 pt-1">
              <PromptTab project={project} asset={asset} profile={profile} />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="audio" forceMount className={tabClass}>
          <ScrollArea className="h-full">
            <div className="px-3 pb-4 pt-1">
              <LinkedAudioSection project={project} asset={asset} />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
