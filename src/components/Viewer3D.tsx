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
import {
  OrbitControls,
  Grid,
  Center,
  Bounds,
  useGLTF,
  Html,
} from "@react-three/drei";
import * as THREE from "three";
import {
  RotateCcw,
  Grid3x3,
  Boxes,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Sun,
} from "lucide-react";
import type { ComponentRef } from "react";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

export interface MeshStats {
  faces: number;
  vertices: number;
}

/** Loads a GLTF/GLB and reports geometry stats + wireframe toggle. */
function Model({
  url,
  wireframe,
  onStats,
}: {
  url: string;
  wireframe: boolean;
  onStats: (s: MeshStats) => void;
}) {
  const gltf = useGLTF(url);

  const { scene, stats } = useMemo(() => {
    let faces = 0;
    let vertices = 0;
    const cloned = gltf.scene.clone(true);
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) {
        const g = mesh.geometry as THREE.BufferGeometry;
        const pos = g.getAttribute("position");
        if (pos) vertices += pos.count;
        if (g.index) faces += g.index.count / 3;
        else if (pos) faces += pos.count / 3;
      }
    });
    return { scene: cloned, stats: { faces: Math.round(faces), vertices } };
  }, [gltf.scene]);

  // Apply wireframe + an emissive floor (the texture lights itself a bit so shadow
  // sides are never black) to all standard materials.
  useEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        const mats = Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material];
        for (const m of mats) {
          const sm = m as THREE.MeshStandardMaterial;
          sm.wireframe = wireframe;
          if (sm.map) {
            // Self-illuminate from the albedo so the model always reads bright,
            // independent of scene lighting (good for vivid game/Roblox previews).
            sm.emissiveMap = sm.map;
            sm.emissive = new THREE.Color(0xffffff);
            sm.emissiveIntensity = 0.35;
            sm.needsUpdate = true;
          }
        }
      }
    });
  }, [scene, wireframe]);

  useEffect(() => {
    onStats(stats);
  }, [stats, onStats]);

  return (
    <Bounds fit clip observe margin={1.2}>
      <Center>
        <primitive object={scene} />
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
}: {
  src: string | null;
  height?: number;
}) {
  const [wireframe, setWireframe] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [grid, setGrid] = useState(true);
  const [brightness, setBrightness] = useState(1.3);
  const [stats, setStats] = useState<MeshStats | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  // Reset stats when the source changes.
  useEffect(() => {
    setStats(null);
  }, [src]);

  function resetCamera() {
    controlsRef.current?.reset();
  }

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
          className={"vbtn" + (grid ? " on" : "")}
          onClick={() => setGrid((v) => !v)}
          title="Grille"
          aria-pressed={grid}
        >
          <Grid3x3 size={14} /> Grille
        </button>
        <button className="vbtn" onClick={resetCamera} title="Recentrer">
          <RotateCcw size={14} /> Recadrer
        </button>
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
      >
        <color attach="background" args={["#171411"]} />
        <ExposureControl value={brightness} />
        {/* Local lights only — no <Environment preset> (it fetches a remote HDR,
            which stalls offline / in the packaged app). */}
        <ambientLight intensity={0.45 * brightness} />
        <hemisphereLight intensity={0.6 * brightness} groundColor="#0f0c09" />
        <directionalLight
          position={[5, 8, 5]}
          intensity={1.1 * brightness}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight position={[-5, 3, -4]} intensity={0.35 * brightness} />

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
        </div>
      )}
    </div>
  );
}
