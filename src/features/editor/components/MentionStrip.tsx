import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  findNode,
  mentionNodeIds,
  type AssetId,
  type CanvasDocument,
  type ResourceEntry,
  type WorkflowNode,
} from "../../../shared/domain";
import {
  mediaInfoForNode,
  type MediaCardInfo,
  type MediaState,
} from "../canvas/mediaCards";
import { MentionPreview } from "./MentionPreview";

/** The mark a reference wears when it has no picture of its own. */
const KIND_ICONS: Record<string, string> = {
  text: "¶",
  audio: "♪",
  group: "▢",
  image: "▣",
  video: "▶",
};

/** The width a look is held to, and how close to an edge of the screen it may come. */
const LOOK_WIDTH = 336;
const LOOK_EDGE = 8;

/** The nodes a prompt names, in the order it names them and once each. */
function namedNodeIds(prompt: string): string[] {
  const out: string[] = [];
  for (const id of mentionNodeIds(prompt)) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * A reference as the thing it holds: the picture itself where there is one,
 * and the mark of its kind where there is nothing to look at — a text and an
 * audio are read and heard rather than seen, so a thumbnail of either is a
 * mark rather than a lie.
 */
function Thumb({
  node,
  media,
}: {
  node: WorkflowNode | undefined;
  media: MediaCardInfo | null;
}) {
  if (!node) return <span className="mention-strip-icon">?</span>;
  if ((node.kind === "image" || node.kind === "video") && media?.url) {
    return <img alt="" className="mention-strip-thumb" src={media.url} />;
  }
  if (node.kind === "video" && media?.playable) {
    return (
      <video
        className="mention-strip-thumb"
        muted
        playsInline
        preload="metadata"
        src={media.playable}
      />
    );
  }
  return (
    <span className="mention-strip-icon">{KIND_ICONS[node.kind] ?? "?"}</span>
  );
}

/**
 * What the prompt points at, under the words that point at it.
 *
 * One entry per card named, in the order it is named: the picture for what has
 * one, and the mark of the kind for what has not. Hovering an entry shows the
 * whole of what it is — the words of a text, the file of an audio playing, the
 * picture of a picture — since a thumbnail is an invitation to look closer and
 * a reader that has to open another panel to look has been sent away.
 *
 * The look is hung on the page rather than in the panel: it holds a picture
 * larger than the strip, and a panel that scrolls would cut it off at its own
 * edge. It waits a moment before leaving, so a pointer on its way from a
 * thumbnail to an audio's own controls finds them still there.
 */
export function MentionStrip({
  canvas,
  issues,
  prompt,
  resources,
}: {
  canvas: CanvasDocument;
  issues: ReadonlyMap<AssetId, MediaState>;
  prompt: string;
  resources: ReadonlyMap<AssetId, ResourceEntry>;
}) {
  const { t } = useTranslation();
  const [looked, setLooked] = useState<{
    id: string;
    left: number;
    /** Hung under the thumbnail, or over it where the screen ends first. */
    top: number | null;
    bottom: number | null;
  } | null>(null);
  /** The wait a pointer is given to cross from a thumbnail onto the look. */
  const leaving = useRef<number | null>(null);

  const keep = () => {
    if (leaving.current !== null) {
      window.clearTimeout(leaving.current);
      leaving.current = null;
    }
  };
  const drop = () => {
    keep();
    leaving.current = window.setTimeout(() => setLooked(null), 140);
  };
  useEffect(() => keep, []);

  const ids = namedNodeIds(prompt);
  if (ids.length === 0) return null;

  const look = (event: React.MouseEvent<HTMLLIElement>, id: string) => {
    if (looked?.id === id) return;
    const item = event.currentTarget.getBoundingClientRect();
    const wide = window.innerWidth || 0;
    const tall = window.innerHeight || 0;
    // A look holding a picture stands about this tall; less room than that
    // below the thumbnail means the room is above it.
    const overhead = 300;
    const above = tall - item.bottom < overhead;
    setLooked({
      id,
      left: Math.max(
        LOOK_EDGE,
        Math.min(item.left, wide - LOOK_WIDTH - LOOK_EDGE),
      ),
      top: above ? null : item.bottom + 6,
      bottom: above ? tall - item.top + 6 : null,
    });
  };

  const shown = looked ? findNode(canvas, looked.id) : undefined;
  const shownMedia = shown ? mediaInfoForNode(shown, resources, issues) : null;

  return (
    <div className="mention-strip-wrap" onMouseLeave={drop}>
      <ul aria-label={t("editor:mention.referenced")} className="mention-strip">
        {ids.map((id) => {
          const node = findNode(canvas, id);
          const media = node ? mediaInfoForNode(node, resources, issues) : null;
          return (
            <li
              className={
                node ? "mention-strip-item" : "mention-strip-item is-gone"
              }
              data-node-id={id}
              key={id}
              onMouseOver={(event) => look(event, id)}
              title={node?.title ?? t("editor:mention.gone")}
            >
              <Thumb media={media} node={node} />
            </li>
          );
        })}
      </ul>

      {looked &&
        createPortal(
          <div
            className="mention-look is-wide is-floating"
            data-testid="mention-strip-look"
            onMouseEnter={keep}
            onMouseLeave={drop}
            style={{
              bottom: looked.bottom === null ? "auto" : `${looked.bottom}px`,
              left: `${looked.left}px`,
              top: looked.top === null ? "auto" : `${looked.top}px`,
            }}
          >
            {shown ? (
              <MentionPreview media={shownMedia} node={shown} />
            ) : (
              <p className="mention-look-label">{t("editor:mention.gone")}</p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
