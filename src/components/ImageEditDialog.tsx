import { useEffect, useRef, useState } from "react";
import { Wand2, Eraser, Loader2, AlertTriangle } from "lucide-react";

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
import { useEditImage } from "../lib/queries";

/**
 * Edit an asset's source image via OpenAI. The prompt describes the change; the
 * optional brush paints the region to edit (everything else is preserved). The
 * exported mask is a PNG where painted pixels are transparent — OpenAI inpainting
 * semantics. Overwrites source.png and resets the 3D stages.
 */
export function ImageEditDialog({
  project,
  assetId,
  onClose,
}: {
  project: string;
  assetId: string;
  onClose: () => void;
}) {
  const edit = useEditImage(project);
  const [prompt, setPrompt] = useState("");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [triedFront, setTriedFront] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [hasMask, setHasMask] = useState(false);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const stamp = useRef(Date.now());

  // Resolve the source image (fall back to the multiview front view).
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const base = await assetFileUrl(project, assetId, "source.png");
        if (active) setImgUrl(`${base}?t=${stamp.current}`);
      } catch {
        if (active) setImgError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [project, assetId]);

  async function onImgError() {
    if (triedFront) {
      setImgError(true);
      return;
    }
    setTriedFront(true);
    try {
      const base = await assetFileUrl(project, assetId, "multiview/front.png");
      setImgUrl(`${base}?t=${stamp.current}`);
    } catch {
      setImgError(true);
    }
  }

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
    edit.mutate(
      { assetId, prompt: prompt.trim(), maskBytes },
      { onSuccess: () => onClose() },
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
          <DialogTitle>Modifier l'image</DialogTitle>
          <DialogDescription>
            Décris la modification. Peins (optionnel) la zone à modifier — le
            reste de l'image est préservé.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-[120px] justify-center">
          {imgError ? (
            <div className="flex flex-col items-center gap-2.5 whitespace-nowrap text-sm text-destructive">
              <AlertTriangle size={24} />
              <span>Aucune image source à éditer.</span>
            </div>
          ) : (
            <div className="relative inline-block max-h-[52vh] max-w-full leading-[0]">
              {imgUrl && (
                <img
                  ref={imgRef}
                  src={imgUrl}
                  alt="source"
                  onLoad={onImgLoad}
                  onError={onImgError}
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
          placeholder="ex. rends la cape rouge, garde le reste identique"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        {edit.isError && (
          <p className="text-sm text-destructive">
            {(edit.error as Error)?.message ?? "échec de l'édition"}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={clearMask}
            disabled={!hasMask || edit.isPending}
          >
            <Eraser size={14} /> Effacer le masque
          </Button>
          <Button
            size="sm"
            onClick={onApply}
            disabled={!prompt.trim() || imgError || edit.isPending}
          >
            {edit.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Wand2 size={14} />
            )}
            Appliquer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
