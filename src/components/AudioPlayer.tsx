import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";

/** Deterministic per-bar animation delays (seconds) for the equalizer — a fixed
 *  pseudo-random spread so the bars feel organic but render identically. */
const EQ_BARS = Array.from({ length: 40 }, (_, i) => -(((i * 53) % 90) / 100));

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Custom audio player: play/pause, scrubbable progress, and a live equalizer
 *  that pulses while playing. `accent` (hex) tints the whole control. */
export function AudioPlayer({ src, accent }: { src: string; accent: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onTime = () => setCurrent(a.currentTime);
    const onMeta = () => setDuration(a.duration);
    const onEnd = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, []);

  // Reset transport when the source changes (e.g. after a regen).
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setDuration(0);
  }, [src]);

  function toggle() {
    const a = ref.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = ref.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setCurrent(a.currentTime);
  }

  const pct = duration ? (current / duration) * 100 : 0;

  return (
    <div
      className="flex items-center gap-4 rounded-xl border p-4"
      style={{
        borderColor: `color-mix(in srgb, ${accent} 28%, var(--border))`,
        background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 7%, var(--panel)) 0%, var(--panel) 70%)`,
      }}
    >
      <audio ref={ref} src={src} preload="metadata" />

      <button
        type="button"
        onClick={toggle}
        className="grid size-12 shrink-0 place-items-center rounded-full transition-transform hover:scale-105 active:scale-95"
        style={{
          background: accent,
          color: "var(--accent-ink)",
          boxShadow: `0 0 26px -6px ${accent}`,
        }}
        aria-label={playing ? "Pause" : "Lecture"}
      >
        {playing ? (
          <Pause size={20} fill="currentColor" />
        ) : (
          <Play size={20} fill="currentColor" className="ml-0.5" />
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* Equalizer */}
        <div className="flex h-7 items-center gap-[3px] overflow-hidden" aria-hidden>
          {EQ_BARS.map((delay, i) => (
            <span
              key={i}
              className="h-full flex-1 rounded-full"
              style={{
                background: accent,
                opacity: playing ? 0.9 : 0.22,
                transformOrigin: "center",
                transform: playing ? undefined : "scaleY(0.22)",
                animation: playing
                  ? `eq 0.85s ${delay}s ease-in-out infinite alternate`
                  : "none",
              }}
            />
          ))}
        </div>

        {/* Scrubber */}
        <div
          onClick={seek}
          className="group relative h-1.5 cursor-pointer rounded-full bg-[var(--panel-3)]"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${pct}%`, background: accent }}
          />
          <div
            className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
            style={{ left: `calc(${pct}% - 6px)` }}
          />
        </div>

        <div className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
          <span>{fmtTime(current)}</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
