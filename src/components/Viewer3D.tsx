import {
  Component,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Grid, Center, Bounds, useGLTF, Html } from "@react-three/drei";
import * as THREE from "three";
import {
  RotateCcw,
  Grid3x3,
  Boxes,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Sun,
  Camera,
  Ruler,
  Palette,
} from "lucide-react";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import type { ComponentRef } from "react";

import { saveRender } from "../lib/api";
import { collectMeshStats, type MeshStats } from "../lib/meshStats";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export type { MeshStats };

/** Local lighting presets (no remote HDR — keeps the viewer offline-safe). Each
 *  is scaled by the brightness slider on top. */
const LIGHT_PRESETS = {
  studio: { label: "Studio", ambient: 0.45, hemi: 0.6, key: 1.1, fill: 0.35, bg: "#171411" },
  doux: { label: "Doux", ambient: 0.7, hemi: 0.85, key: 0.6, fill: 0.4, bg: "#1c1a17" },
  vif: { label: "Vif", ambient: 0.35, hemi: 0.5, key: 1.6, fill: 0.5, bg: "#14110e" },
  sombre: { label: "Sombre", ambient: 0.18, hemi: 0.3, key: 0.9, fill: 0.15, bg: "#0b0907" },
} as const;
type PresetKey = keyof typeof LIGHT_PRESETS;

/** Loads a GLTF/GLB and reports geometry stats + wireframe / unlit / box toggles. */
function Model({
  url,
  wireframe,
  unlit,
  showBox,
  onStats,
}: {
  url: string;
  wireframe: boolean;
  unlit: boolean;
  showBox: boolean;
  onStats: (s: MeshStats) => void;
}) {
  const gltf = useGLTF(url);

  const { scene, box, stats } = useMemo(() => {
    const cloned = gltf.scene.clone(true);
    const { stats, box } = collectMeshStats(cloned);
    return { scene: cloned, box, stats };
  }, [gltf.scene]);

  // Apply wireframe + emissive (the texture lights itself a bit so shadow sides
  // are never black; "unlit" pushes it to full albedo) to all standard materials.
  useEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const sm = m as THREE.MeshStandardMaterial;
          sm.wireframe = wireframe;
          if (sm.map) {
            // Self-illuminate from the albedo so the model always reads bright,
            // independent of scene lighting (good for vivid game/Roblox previews).
            // "unlit" cranks it to 1.0 to inspect the raw texture.
            sm.emissiveMap = sm.map;
            sm.emissive = new THREE.Color(0xffffff);
            sm.emissiveIntensity = unlit ? 1.0 : 0.35;
            sm.needsUpdate = true;
          }
        }
      }
    });
  }, [scene, wireframe, unlit]);

  useEffect(() => {
    onStats(stats);
  }, [stats, onStats]);

  return (
    <Bounds fit clip observe margin={1.2}>
      <Center>
        <primitive object={scene} />
        {showBox && <box3Helper args={[box, new THREE.Color(0xe39a4a)]} />}
      </Center>
    </Bounds>
  );
}

/** Drives renderer tone-mapping exposure (the most effective brightness lever).
    Neutral tone mapping avoids ACES's mid-tone darkening, so the slider has real
    range. */
function ExposureControl({ value }: { value: number }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = THREE.NeutralToneMapping;
    gl.toneMappingExposure = value;
  }, [gl, value]);
  return null;
}

function CanvasLoader() {
  return (
    <Html center>
      <div className="viewer-overlay-msg">
        <Loader2 size={28} className="spin" />
        <span>Chargement du modèle 3D…</span>
      </div>
    </Html>
  );
}

/** Error boundary for GLTF load failures. */
class ModelErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

export function Viewer3D({
  src,
  height = 420,
  name = "render",
}: {
  src: string | null;
  /** Pixel height, or a CSS size ("100%" to fill a sized parent). */
  height?: number | string;
  /** Base filename suggested in the screenshot save dialog. */
  name?: string;
}) {
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [grid, setGrid] = useState(true);
  const [brightness, setBrightness] = useState(1.3);
  const [preset, setPreset] = useState<PresetKey>("studio");
  const [unlit, setUnlit] = useState(false);
  const [showDims, setShowDims] = useState(false);
  const [stats, setStats] = useState<MeshStats | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);

  // Reset stats when the source changes.
  useEffect(() => {
    setStats(null);
  }, [src]);

  function resetCamera() {
    controlsRef.current?.reset();
  }

  // Capture the current frame to a PNG via a native "Save As" dialog. The canvas
  // keeps its buffer (preserveDrawingBuffer) so toDataURL always has the frame.
  async function capture() {
    const gl = glRef.current;
    if (!gl) return;
    const dataUrl = gl.domElement.toDataURL("image/png");
    const dest = await save({
      defaultPath: `${name}.png`,
      filters: [{ name: "Image PNG", extensions: ["png"] }],
    });
    if (typeof dest !== "string") return;
    const b64 = dataUrl.split(",")[1] ?? "";
    const bin = atob(b64);
    const bytes = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      await saveRender(dest, bytes);
      toast.success("Capture enregistrée");
    } catch (e) {
      toast.error(`Échec de la capture : ${e}`);
    }
  }

  const p = LIGHT_PRESETS[preset];

  return (
    <div className="viewer3d" style={{ height }}>
      <div className="viewer3d-toolbar">
        <button
          className={"vbtn" + (autoRotate ? " on" : "")}
          onClick={() => setAutoRotate((v) => !v)}
          title="Rotation auto"
          aria-pressed={autoRotate}
        >
          <RefreshCw size={14} /> Rotation
        </button>
        <button
          className={"vbtn" + (wireframe ? " on" : "")}
          onClick={() => setWireframe((v) => !v)}
          title="Fil de fer"
          aria-pressed={wireframe}
        >
          <Boxes size={14} /> Wireframe
        </button>
        <button
          className={"vbtn" + (unlit ? " on" : "")}
          onClick={() => setUnlit((v) => !v)}
          title="Afficher la texture pure (sans éclairage)"
          aria-pressed={unlit}
        >
          <Palette size={14} /> Texture
        </button>
        <button
          className={"vbtn" + (grid ? " on" : "")}
          onClick={() => setGrid((v) => !v)}
          title="Grille"
          aria-pressed={grid}
        >
          <Grid3x3 size={14} /> Grille
        </button>
        <button
          className={"vbtn" + (showDims ? " on" : "")}
          onClick={() => setShowDims((v) => !v)}
          title="Boîte englobante + dimensions"
          aria-pressed={showDims}
        >
          <Ruler size={14} /> Cotes
        </button>
        <button className="vbtn" onClick={resetCamera} title="Recentrer">
          <RotateCcw size={14} /> Recadrer
        </button>
        <button className="vbtn" onClick={capture} title="Capture PNG du rendu">
          <Camera size={14} /> Capture
        </button>
        <label
          className="vbtn"
          title="Éclairage"
          style={{ display: "flex", alignItems: "center", gap: 6, cursor: "default" }}
        >
          <Sun size={14} />
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as PresetKey)}
            title="Preset d'éclairage"
            style={{ background: "transparent", color: "inherit", border: "none", cursor: "pointer", outline: "none" }}
          >
            {Object.entries(LIGHT_PRESETS).map(([key, v]) => (
              <option key={key} value={key} style={{ color: "#000" }}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label
          className="vbtn vslider"
          title={`Luminosité ×${brightness.toFixed(2)}`}
          style={{ display: "flex", alignItems: "center", gap: 6, cursor: "default" }}
        >
          <Sun size={14} />
          <input
            type="range"
            min={0.3}
            max={4}
            step={0.05}
            value={brightness}
            onChange={(e) => setBrightness(parseFloat(e.target.value))}
            onDoubleClick={() => setBrightness(1.3)}
            title="Glisser pour ajuster · double-clic pour réinitialiser"
            style={{ width: 90, cursor: "pointer", accentColor: "#e39a4a" }}
          />
        </label>
      </div>

      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: [2.4, 1.8, 2.4], fov: 45, near: 0.01, far: 100 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
          glRef.current = gl;
        }}
      >
        <color attach="background" args={[p.bg]} />
        <ExposureControl value={brightness} />
        {/* Local lights only — no <Environment preset> (it fetches a remote HDR,
            which stalls offline / in the packaged app). Driven by the preset. */}
        <ambientLight intensity={(unlit ? 0.05 : p.ambient) * brightness} />
        <hemisphereLight
          intensity={(unlit ? 0.05 : p.hemi) * brightness}
          groundColor="#0f0c09"
        />
        <directionalLight
          position={[5, 8, 5]}
          intensity={(unlit ? 0 : p.key) * brightness}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight
          position={[-5, 3, -4]}
          intensity={(unlit ? 0 : p.fill) * brightness}
        />

        <Suspense fallback={<CanvasLoader />}>
          {src ? (
            <ModelErrorBoundary
              fallback={
                <Html center>
                  <div className="viewer-overlay-msg error">
                    <AlertTriangle size={26} />
                    <span>Impossible de charger le modèle.</span>
                  </div>
                </Html>
              }
            >
              <Model
                key={src}
                url={src}
                wireframe={wireframe}
                unlit={unlit}
                showBox={showDims}
                onStats={setStats}
              />
            </ModelErrorBoundary>
          ) : (
            <Html center>
              <div className="viewer-overlay-msg muted">
                <Boxes size={28} />
                <span>Aucun modèle chargé.</span>
              </div>
            </Html>
          )}
        </Suspense>

        {grid && (
          <Grid
            args={[20, 20]}
            position={[0, -0.001, 0]}
            cellSize={0.25}
            cellThickness={0.6}
            cellColor="#332c23"
            sectionSize={1}
            sectionThickness={1}
            sectionColor="#4a4033"
            fadeDistance={18}
            fadeStrength={1.5}
            infiniteGrid
            followCamera={false}
          />
        )}

        <OrbitControls
          ref={controlsRef}
          makeDefault
          autoRotate={autoRotate}
          autoRotateSpeed={1.2}
          enableDamping
          dampingFactor={0.08}
          minDistance={0.4}
          maxDistance={20}
        />
      </Canvas>

      {stats && (
        <div className="viewer3d-stats">
          <span>{stats.faces.toLocaleString("fr-FR")} faces</span>
          <span className="sep">·</span>
          <span>{stats.vertices.toLocaleString("fr-FR")} sommets</span>
          {showDims && (
            <>
              <span className="sep">·</span>
              <span>
                {stats.size.x.toFixed(2)} × {stats.size.y.toFixed(2)} ×{" "}
                {stats.size.z.toFixed(2)}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
