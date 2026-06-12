import { useEffect, useRef, useState } from "react";
import { GitBranch, Eraser, Loader2, AlertTriangle } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { assetFileUrl } from "../lib/api";
import { useDeriveAsset } from "../lib/queries";
import type { Asset } from "../lib/types";

/**
 * Derive a variant asset: edit the parent's full multiview sheet via OpenAI so
 * the 4 views stay coherent. The prompt describes the change; the optional
 * brush paints the region to edit (transparent pixels in the exported mask —
 * OpenAI inpainting semantics). Creates a NEW asset linked to the parent with
 * its multiview done; the 3D stages stay pending for the user to review first.
 */
export function DeriveAssetDialog({
  project,
  assetId,
  onClose,
  onCreated,
}: {
  project: string;
  assetId: string;
  onClose: () => void;
  onCreated: (asset: Asset) => void;
}) {
  const derive = useDeriveAsset(project);
  const [prompt, setPrompt] = useState("");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  const [hasMask, setHasMask] = useState(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const stamp = useRef(Date.now());

  // The derivation requires the parent's 2x2 sheet — no fallback.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const base = await assetFileUrl(project, assetId, "multiview/sheet.png");
        if (active) setImgUrl(`${base}?t=${stamp.current}`);
      } catch {
        if (active) setImgError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [project, assetId]);

  // Size the overlay canvas to the image's natural resolution once it loads.
  function onImgLoad() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    setHasMask(false);
  }

  function toCanvasCoords(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
      // Brush radius in canvas px, scaled from a ~22px screen brush.
      r: (22 / rect.width) * canvas.width,
    };
  }

  function paint(e: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { x, y, r } = toCanvasCoords(e);
    ctx.fillStyle = "rgba(255,64,64,0.55)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    setHasMask(true);
  }

  function clearMask() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasMask(false);
  }

  /** Build the OpenAI mask: painted pixels -> transparent, rest -> opaque white. */
  function buildMaskBytes(): Promise<number[] | null> {
    return new Promise((resolve) => {
      const src = canvasRef.current;
      if (!src || !hasMask) return resolve(null);
      const w = src.width;
      const h = src.height;
      const srcData = src.getContext("2d")!.getImageData(0, 0, w, h).data;

      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const octx = out.getContext("2d")!;
      const outImg = octx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const painted = srcData[i * 4 + 3] > 0; // any drawn alpha
        const o = i * 4;
        if (painted) {
          outImg.data[o] = 0;
          outImg.data[o + 1] = 0;
          outImg.data[o + 2] = 0;
          outImg.data[o + 3] = 0; // transparent => edit here
        } else {
          outImg.data[o] = 255;
          outImg.data[o + 1] = 255;
          outImg.data[o + 2] = 255;
          outImg.data[o + 3] = 255; // opaque => keep
        }
      }
      octx.putImageData(outImg, 0, 0);
      out.toBlob(async (blob) => {
        if (!blob) return resolve(null);
        const buf = new Uint8Array(await blob.arrayBuffer());
        resolve(Array.from(buf));
      }, "image/png");
    });
  }

  async function onApply() {
    if (!prompt.trim()) return;
    const maskBytes = await buildMaskBytes();
    derive.mutate(
      { assetId, prompt: prompt.trim(), maskBytes },
      {
        onSuccess: (created) => {
          onCreated(created);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Créer une variante</DialogTitle>
          <DialogDescription>
            Décris la modification appliquée à la planche multivue. Peins
            (optionnel) la zone à modifier. La variante sera créée comme nouvel
            asset lié — le 3D reste à lancer après vérification.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[120px] justify-center">
          {imgError ? (
            <div className="flex flex-col items-center gap-2.5 whitespace-nowrap text-sm text-destructive">
              <AlertTriangle size={24} />
              <span>La planche multivue du parent est requise.</span>
            </div>
          ) : (
            <div className="relative inline-block max-h-[52vh] max-w-full leading-[0]">
              {imgUrl && (
                <img
                  ref={imgRef}
                  src={imgUrl}
                  alt="planche multivue"
                  onLoad={onImgLoad}
                  onError={() => setImgError(true)}
                  draggable={false}
                  className="block max-h-[52vh] max-w-full select-none rounded-md"
                />
              )}
              <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                onPointerDown={(e) => {
                  drawing.current = true;
                  (e.target as HTMLElement).setPointerCapture(e.pointerId);
                  paint(e);
                }}
                onPointerMove={(e) => drawing.current && paint(e)}
                onPointerUp={() => (drawing.current = false)}
                onPointerLeave={() => (drawing.current = false)}
              />
            </div>
          )}
        </div>

        <Textarea
          rows={2}
          placeholder="ex. rends l'armure dorée, garde le reste identique"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        {derive.isError && (
          <p className="text-sm text-destructive">
            {(derive.error as Error)?.message ?? "échec de la dérivation"}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={clearMask}
            disabled={!hasMask || derive.isPending}
          >
            <Eraser size={14} /> Effacer le masque
          </Button>
          <Button
            size="sm"
            onClick={onApply}
            disabled={!prompt.trim() || imgError || derive.isPending}
          >
            {derive.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <GitBranch size={14} />
            )}
            Créer la variante
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
