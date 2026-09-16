import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  type TimelineDocument,
  type TimelineTransition,
} from "../../../shared/domain";
import { followerOf } from "../../../shared/domain/timeline";
import { execute } from "../../editor/commands/execute";
import { drawTransition, type SeamKind } from "../preview/blend";
import {
  clampSeamMs,
  seamEditCommands,
  seamRemoveCommands,
} from "../interactions/transitions";
import { useClipStore } from "../stores/clipStore";
import { formatTimecode } from "../timeline/timecode";

/**
 * The seam a reader has chosen, as an editor.
 *
 * Every change goes through the same chain command the badge drag uses: the
 * suffix of seams from this one down is taken apart left to right and laid
 * back with the new kind or window in one `execute`, so a change is one step
 * of history and one undo regardless of how many seams follow. Because the
 * command keeps every id, the transition stays chosen across the change and
 * the card keeps editing the same seam.
 *
 * The window slider does not preview mid-drag: `execute` applies locally and
 * synchronously, so the release is instant — the live path is the badge drag
 * on the seam itself, and a second draft here would be a second truth.
 */

const KIND_LABELS: Record<SeamKind, string> = {
  crossfade: "clip:transitionCard.kindCrossfade",
  dipToBlack: "clip:transitionCard.kindDipToBlack",
  dipToWhite: "clip:transitionCard.kindDipToWhite",
  slideLeft: "clip:transitionCard.kindSlideLeft",
  slideUp: "clip:transitionCard.kindSlideUp",
  wipe: "clip:transitionCard.kindWipe",
  zoomIn: "clip:transitionCard.kindZoomIn",
};

const SEAM_KINDS: SeamKind[] = [
  "crossfade",
  "dipToBlack",
  "dipToWhite",
  "slideLeft",
  "slideUp",
  "wipe",
  "zoomIn",
];

/** One loop of a tile's animation, in milliseconds. */
const LOOP_MS = 1_000;
/** The two placeholder frames the tiles blend: warm into cool, and back. */
const WARM: [string, string] = ["#e8913c", "#b0332f"];
const COOL: [string, string] = ["#3d6fd1", "#2f9fa0"];

/** A tile's picture: a gradient the page paints, standing in for a frame. */
function paintBlock(
  ctx: CanvasRenderingContext2D,
  colours: [string, string],
): void {
  const gradient = ctx.createLinearGradient(
    0,
    0,
    ctx.canvas.width,
    ctx.canvas.height,
  );
  gradient.addColorStop(0, colours[0]);
  gradient.addColorStop(1, colours[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/**
 * One kind, shown as the blend it is.
 *
 * The tile's canvas animates one loop of the kind's own drawing while the
 * pointer rests on it, and holds still otherwise: seven tiles running rAF
 * would be seven canvases burning a frame each for a picture nobody is
 * looking at. `drawTransition` is the preview's own function, so the tile
 * cannot drift from what the seam will do.
 */
function KindTile({
  kind,
  current,
  onPick,
}: {
  kind: SeamKind;
  current: boolean;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const draw = (progress: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawTransition(
        ctx,
        kind,
        progress,
        (target) => paintBlock(target, WARM),
        (target) => paintBlock(target, COOL),
      );
    };
    if (!hovered) {
      // A tile at rest shows the kind's own middle as one still frame: seven
      // canvases burning a rAF each for a picture nobody is looking at would
      // be seven animations, but one drawn frame is just a picture.
      draw(0.5);
      return;
    }
    let raf: number | null = null;
    const started = performance.now();
    const frame = () => {
      draw(((performance.now() - started) % LOOP_MS) / LOOP_MS);
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [hovered, kind]);

  return (
    <button
      aria-pressed={current}
      className="clip-seam-tile"
      data-testid={`transition-kind-${kind}`}
      onClick={onPick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={t(KIND_LABELS[kind])}
      type="button"
    >
      <canvas
        aria-hidden="true"
        className="clip-seam-tile-canvas"
        height={30}
        ref={canvasRef}
        width={48}
      />
      <span>{t(KIND_LABELS[kind])}</span>
    </button>
  );
}

export interface TransitionCardProps {
  timeline: TimelineDocument;
  transition: TimelineTransition;
}

export function TransitionCard({ timeline, transition }: TransitionCardProps) {
  const { t } = useTranslation();
  const leader =
    timeline.clips.find((clip) => clip.id === transition.afterClipId) ?? null;
  const follower = leader ? followerOf(timeline, leader) : null;
  const seamMs = leader ? leader.startMs + leader.durationMs : null;
  const [heldWindow, setHeldWindow] = useState<number | null>(null);

  const upperMs = Math.max(
    MIN_TRANSITION_MS,
    clampSeamMs(timeline, transition.id, MAX_TRANSITION_MS),
  );
  const shownWindow = heldWindow ?? transition.durationMs;

  /** One chain edit, one history step; the selection does not move. */
  const commitWindow = (durationMs: number) => {
    if (durationMs === transition.durationMs) return;
    const commands = seamEditCommands(timeline, transition.id, { durationMs });
    if (commands) execute(t("clip:history.changeTransition"), commands);
  };

  const pickKind = (kind: SeamKind) => {
    if (kind === transition.kind) return;
    const commands = seamEditCommands(timeline, transition.id, { kind });
    if (commands) execute(t("clip:history.changeTransition"), commands);
  };

  const remove = () => {
    const commands = seamRemoveCommands(timeline, transition.id);
    if (commands.length === 0) return;
    if (!execute(t("clip:history.removeTransition"), commands)) return;
    // With the seam gone there is nothing for the card to be about.
    useClipStore.getState().select({ clipIds: [], transitionId: null });
  };

  return (
    <div className="clip-inspector-body" data-testid="clip-transition-card">
      <section className="inspector-section">
        <h3>{t("clip:transitionCard.title")}</h3>
        <div className="inspector-row">
          <span>{t("clip:transitionCard.between")}</span>
          <span>
            {leader?.label ?? t("clip:transitionCard.goneClip")} →{" "}
            {follower?.label ?? t("clip:transitionCard.nothing")}
          </span>
        </div>
        {seamMs !== null && (
          <div className="inspector-row">
            <span>{t("clip:transitionCard.seam")}</span>
            <span>{formatTimecode(seamMs, timeline.settings.fps)}</span>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <h3>{t("clip:transitionCard.kind")}</h3>
        <div className="clip-seam-tiles">
          {SEAM_KINDS.map((kind) => (
            <KindTile
              current={kind === transition.kind}
              key={kind}
              kind={kind}
              onPick={() => pickKind(kind)}
            />
          ))}
        </div>
      </section>

      <section className="inspector-section">
        <h3>{t("clip:transitionCard.window")}</h3>
        <div className="clip-inspector-slider clip-seam-window">
          <input
            aria-label={t("clip:transitionCard.window")}
            max={upperMs}
            min={MIN_TRANSITION_MS}
            onBlur={() => {
              if (heldWindow !== null) commitWindow(heldWindow);
              setHeldWindow(null);
            }}
            onChange={(event) => setHeldWindow(Number(event.target.value))}
            onPointerUp={() => {
              if (heldWindow !== null) commitWindow(heldWindow);
              setHeldWindow(null);
            }}
            step={10}
            type="range"
            value={shownWindow}
          />
          <span>{t("clip:transitionCard.ms", { ms: shownWindow })}</span>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-actions">
          <button
            className="danger"
            data-testid="transition-remove"
            onClick={remove}
            type="button"
          >
            {t("clip:transitionCard.remove")}
          </button>
        </div>
      </section>
    </div>
  );
}
