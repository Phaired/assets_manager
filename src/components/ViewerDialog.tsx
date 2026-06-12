import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";

import { LazyViewer3D } from "./LazyViewer3D";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ViewerDialog({
  initialSrc,
  onClose,
}: {
  initialSrc: string | null;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(initialSrc);
  const [over, setOver] = useState(false);
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Resizable modal: start big, drag the bottom-right grip to grow/shrink. The
  // dialog is centre-anchored, so the corner tracks the cursor at 2× the delta.
  const [size, setSize] = useState(() => ({
    w: Math.min(1180, window.innerWidth - 32),
    h: Math.min(820, window.innerHeight - 32),
  }));
  const dragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(
    null,
  );

  function onResizeDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    setSize({
      w: Math.max(560, Math.min(window.innerWidth - 32, d.w + (e.clientX - d.x) * 2)),
      h: Math.max(420, Math.min(window.innerHeight - 32, d.h + (e.clientY - d.y) * 2)),
    });
  }
  function onResizeUp(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Revoke any object URL we created when unmounting or replacing.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  function loadFile(file: File | undefined | null) {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".glb") && !lower.endsWith(".gltf")) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setSrc(url);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="max-w-none grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-none"
        style={{ width: size.w, height: size.h }}
      >
        <DialogHeader>
          <DialogTitle>Visualiseur 3D</DialogTitle>
        </DialogHeader>

        <div
          className={cn(
            "flex items-center gap-2 rounded-md border border-dashed border-border bg-muted px-4 py-3 text-sm text-muted-foreground transition-colors",
            over && "border-primary bg-primary/10 text-foreground"
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            loadFile(e.dataTransfer.files?.[0]);
          }}
        >
          <Upload size={16} />
          <span>
            Glisse un fichier <b className="font-semibold text-foreground">.glb / .gltf</b> ici, ou{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              onClick={() => fileInputRef.current?.click()}
            >
              choisis un fichier
            </Button>
            .
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".glb,.gltf"
            hidden
            onChange={(e) => loadFile(e.target.files?.[0])}
          />
        </div>

        <div className="min-h-0">
          <LazyViewer3D src={src} height="100%" />
        </div>

        {/* Resize grip — drag to enlarge / shrink the modal. */}
        <div
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          title="Glisser pour redimensionner"
          className="absolute bottom-0 right-0 z-50 size-5 cursor-nwse-resize touch-none"
        >
          <svg
            viewBox="0 0 10 10"
            className="absolute bottom-1 right-1 size-2.5 text-muted-foreground"
            aria-hidden
          >
            <path
              d="M9 1 1 9M9 5 5 9"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </DialogContent>
    </Dialog>
  );
}
