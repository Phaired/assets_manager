import { useEffect, useRef, useState } from "react";
import { X, Upload } from "lucide-react";

import { Viewer3D } from "./Viewer3D";
import { Modal } from "./Modal";

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
    <Modal onClose={onClose} className="modal-box wide" labelledBy="viewer-title">
      <div className="modal-head">
        <h2 id="viewer-title">Visualiseur 3D</h2>
        <button className="btn icon ghost" onClick={onClose} aria-label="Fermer">
          <X size={16} />
        </button>
      </div>

      <div
        className={"drop" + (over ? " over" : "")}
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
          Glisse un fichier <b>.glb / .gltf</b> ici, ou{" "}
          <button
            type="button"
            className="linklike"
            onClick={() => fileInputRef.current?.click()}
          >
            choisis un fichier
          </button>
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

      <Viewer3D src={src} height={480} />
    </Modal>
  );
}
