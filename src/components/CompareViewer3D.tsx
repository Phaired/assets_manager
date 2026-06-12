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
import { OrbitControls, Grid, Center, useGLTF, Html } from "@react-three/drei";
import * as THREE from "three";
import { AlertTriangle, Boxes, Loader2, Palette } from "lucide-react";
import type { ComponentRef, MutableRefObject } from "react";

import { collectMeshStats, type MeshStats } from "../lib/meshStats";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

/** Same "studio" rig as Viewer3D, fixed brightness — the point of this view is
 *  comparing the two meshes, not tuning lights. */
const LIGHTS = { ambient: 0.45, hemi: 0.6, key: 1.1, fill: 0.35, bg: "#171411" };
const BRIGHTNESS = 1.3;

function ExposureControl({ value }: { value: number }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = THREE.NeutralToneMapping;
    gl.toneMappingExposure = value;
  }, [gl, value]);
  return null;
}

/** Loads one GLB. No <Bounds fit> on purpose: both panes normalise the model to
 *  the same world size from its own bbox (raw and reduced share the same bbox),
 *  so the two fixed cameras frame them identically. */
function CompareModel({
  url,
  wireframe,
  unlit,
  onStats,
}: {
  url: string;
  wireframe: boolean;
  unlit: boolean;
  onStats: (s: MeshStats) => void;
}) {
  const gltf = useGLTF(url);

  const { scene, stats, scale } = useMemo(() => {
    const cloned = gltf.scene.clone(true);
    const { stats, box } = collectMeshStats(cloned);
    const diag = box.getSize(new THREE.Vector3()).length();
    return { scene: cloned, stats, scale: diag > 1e-6 ? 2.5 / diag : 1 };
  }, [gltf.scene]);

  useEffect(() => {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const sm = m as THREE.MeshStandardMaterial;
          sm.wireframe = wireframe;
          if (sm.map) {
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
    <Center scale={scale}>
      <primitive object={scene} />
    </Center>
  );
}

class ModelErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError)
      return (
        <Html center>
          <div className="viewer-overlay-msg error">
            <AlertTriangle size={22} />
            <span>Impossible de charger le modèle.</span>
          </div>
        </Html>
      );
    return this.props.children;
  }
}

function CanvasLoader() {
  return (
    <Html center>
      <div className="viewer-overlay-msg">
        <Loader2 size={24} className="spin" />
        <span>Chargement…</span>
      </div>
    </Html>
  );
}

function Pane({
  url,
  label,
  wireframe,
  unlit,
  controlsRef,
  onControlsChange,
  onStats,
}: {
  url: string;
  label: string;
  wireframe: boolean;
  unlit: boolean;
  controlsRef: MutableRefObject<OrbitControlsImpl | null>;
  onControlsChange: () => void;
  onStats: (s: MeshStats) => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border">
      <span className="absolute left-2 top-2 z-10 rounded-md bg-black/50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-white/85">
        {label}
      </span>
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [2.4, 1.8, 2.4], fov: 45, near: 0.01, far: 100 }}
        gl={{ antialias: true }}
      >
        <color attach="background" args={[LIGHTS.bg]} />
        <ExposureControl value={BRIGHTNESS} />
        <ambientLight intensity={(unlit ? 0.05 : LIGHTS.ambient) * BRIGHTNESS} />
        <hemisphereLight
          intensity={(unlit ? 0.05 : LIGHTS.hemi) * BRIGHTNESS}
          groundColor="#0f0c09"
        />
        <directionalLight
          position={[5, 8, 5]}
          intensity={(unlit ? 0 : LIGHTS.key) * BRIGHTNESS}
        />
        <directionalLight
          position={[-5, 3, -4]}
          intensity={(unlit ? 0 : LIGHTS.fill) * BRIGHTNESS}
        />

        <Suspense fallback={<CanvasLoader />}>
          <ModelErrorBoundary>
            <CompareModel
              key={url}
              url={url}
              wireframe={wireframe}
              unlit={unlit}
              onStats={onStats}
            />
          </ModelErrorBoundary>
        </Suspense>

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

        {/* Damping off in compare mode: mutual mirroring + damping would
            ping-pong corrections between the two controls. */}
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping={false}
          minDistance={0.4}
          maxDistance={20}
          onChange={onControlsChange}
        />
      </Canvas>
    </div>
  );
}

function PaneStats({
  stats,
  fileSize,
}: {
  stats: MeshStats | null;
  fileSize?: number;
}) {
  if (!stats)
    return <div className="h-5 text-center text-xs text-muted-foreground">…</div>;
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <span className="font-mono text-foreground">
        {stats.faces.toLocaleString("fr-FR")}
      </span>
      <span>faces</span>
      <span>·</span>
      <span className="font-mono text-foreground">
        {stats.vertices.toLocaleString("fr-FR")}
      </span>
      <span>sommets</span>
      {typeof fileSize === "number" && (
        <>
          <span>·</span>
          <span className="font-mono text-foreground">{formatMb(fileSize)}</span>
        </>
      )}
    </div>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toLocaleString("fr-FR", {
    maximumFractionDigits: 1,
  })} Mo`;
}

/** Side-by-side raw vs reduced comparison with mirrored cameras: orbiting one
 *  pane drives the other, so fidelity can be judged from any angle. */
export function CompareViewer3D({
  rawSrc,
  reducedSrc,
  height = 400,
  meta,
}: {
  rawSrc: string;
  reducedSrc: string;
  /** Pixel height of the panes, or "100%" to fill a sized parent. */
  height?: number | string;
  meta?: {
    fidelity?: number;
    fileSizeBefore?: number;
    fileSizeAfter?: number;
  };
}) {
  const [wireframe, setWireframe] = useState(false);
  const [unlit, setUnlit] = useState(false);
  const [rawStats, setRawStats] = useState<MeshStats | null>(null);
  const [reducedStats, setReducedStats] = useState<MeshStats | null>(null);
  const leftControls = useRef<OrbitControlsImpl | null>(null);
  const rightControls = useRef<OrbitControlsImpl | null>(null);
  const syncing = useRef(false);

  function mirror(
    from: MutableRefObject<OrbitControlsImpl | null>,
    to: MutableRefObject<OrbitControlsImpl | null>,
  ) {
    return () => {
      if (syncing.current || !from.current || !to.current) return;
      syncing.current = true;
      to.current.object.position.copy(from.current.object.position);
      to.current.target.copy(from.current.target);
      to.current.object.updateProjectionMatrix();
      to.current.update();
      syncing.current = false;
    };
  }

  const reductionPct =
    rawStats && reducedStats && rawStats.faces > 0
      ? ((rawStats.faces - reducedStats.faces) / rawStats.faces) * 100
      : null;

  // Fill mode: the panes flex into the parent's height instead of a fixed px
  // height (toolbar + stats rows keep their natural size).
  const fill = typeof height === "string";

  return (
    <div className={"flex flex-col gap-2" + (fill ? " h-full" : "")}>
      <div className="flex items-center gap-2">
        <button
          className={"vbtn" + (wireframe ? " on" : "")}
          onClick={() => setWireframe((v) => !v)}
          title="Fil de fer (idéal pour comparer la densité)"
          aria-pressed={wireframe}
        >
          <Boxes size={14} /> Wireframe
        </button>
        <button
          className={"vbtn" + (unlit ? " on" : "")}
          onClick={() => setUnlit((v) => !v)}
          title="Texture pure (sans éclairage)"
          aria-pressed={unlit}
        >
          <Palette size={14} /> Texture
        </button>
        <span className="ml-auto text-xs text-muted-foreground">
          ↻ caméras synchronisées
        </span>
      </div>

      <div
        className={"grid grid-cols-2 gap-2" + (fill ? " min-h-0 flex-1" : "")}
        style={fill ? undefined : { height }}
      >
        <Pane
          url={rawSrc}
          label="Original (brut)"
          wireframe={wireframe}
          unlit={unlit}
          controlsRef={leftControls}
          onControlsChange={mirror(leftControls, rightControls)}
          onStats={setRawStats}
        />
        <Pane
          url={reducedSrc}
          label="Réduit"
          wireframe={wireframe}
          unlit={unlit}
          controlsRef={rightControls}
          onControlsChange={mirror(rightControls, leftControls)}
          onStats={setReducedStats}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <PaneStats stats={rawStats} fileSize={meta?.fileSizeBefore} />
        <PaneStats stats={reducedStats} fileSize={meta?.fileSizeAfter} />
      </div>

      {(reductionPct != null || typeof meta?.fidelity === "number") && (
        <div className="flex items-center justify-center gap-3 text-xs">
          {reductionPct != null && (
            <span className="text-muted-foreground">
              <span className="font-mono text-foreground">
                −{reductionPct.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}
                {" "}%
              </span>{" "}
              polygones
            </span>
          )}
          {typeof meta?.fidelity === "number" && (
            <span className="text-muted-foreground">
              fidélité{" "}
              <span className="font-mono text-ok">
                {meta.fidelity.toLocaleString("fr-FR", {
                  maximumFractionDigits: 2,
                })}
                {" "}%
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
