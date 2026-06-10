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
      <DialogContent className="max-w-[900px]">
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

        <LazyViewer3D src={src} height={480} />
      </DialogContent>
    </Dialog>
  );
}
