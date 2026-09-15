import { useEffect, useRef, useState } from "react";
import {
  MAX_ASSET_NOTE_LENGTH,
  MAX_ASSET_TAGS,
  MAX_ASSET_TAG_LENGTH,
  type AssetId,
  type ResourceEntry,
  type TimelineDocument,
} from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { formatBytes, formatDuration } from "../../editor/canvas/mediaCards";
import {
  editShelfEntry,
  markAssetKeeper,
  requestDeleteAsset,
} from "../../editor/interactions/actions";
import { StarIcon, TrashIcon } from "../components/ClipIcons";
import { addAssetAtPlayhead } from "../interactions/clipActions";
import {
  firstFrameThumb,
  onFirstFrame,
  THUMB_HEIGHT,
  THUMB_WIDTH,
} from "../preview/thumbs";

/**
 * A file read on its own: what it is, and what can be done with it.
 *
 * The material card of the cutting room, and the same facts the shelf's own
 * inspector shows, said where a reader is already working: the size of the
 * picture, how long the sound runs, the words it is filed under, the star
 * that keeps it to hand, and the two things worth doing with it now — adding
 * it at the playhead and letting it go.
 */

/** The picture a video leads with: its own first frame, once one has been made. */
function FirstFrame({ assetId }: { assetId: AssetId }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => onFirstFrame(() => setVersion((current) => current + 1)), []);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    const frame = firstFrameThumb(assetId);
    if (frame) ctx.drawImage(frame, 0, 0);
  }, [assetId, version]);
  return (
    <canvas
      className="clip-inspector-thumb"
      height={THUMB_HEIGHT}
      ref={canvasRef}
      width={THUMB_WIDTH}
    />
  );
}

/** The still picture a file leads with, when the file is one. */
function stillUrl(entry: ResourceEntry): string | null {
  if (entry.mime === "image/png" || entry.mime === "image/jpeg")
    return assetUrl(entry.id);
  const poster = entry.probe?.posterAssetId;
  return entry.mime === "video/mp4" && poster ? assetUrl(poster) : null;
}

export interface MediaCardProps {
  entry: ResourceEntry;
  /** The cut the file would land on, or null when the project has none. */
  timeline: TimelineDocument | null;
}

export function MediaCard({ entry, timeline }: MediaCardProps) {
  const still = stillUrl(entry);
  const [tags, setTags] = useState(() => (entry.tags ?? []).join(", "));
  const [note, setNote] = useState(entry.note ?? "");
  const probe = entry.probe;

  useEffect(() => {
    setTags((entry.tags ?? []).join(", "));
    setNote(entry.note ?? "");
  }, [entry.id, entry.tags, entry.note]);

  const save = () => {
    const words = tags
      .split(",")
      .map((word) => word.trim())
      .filter((word) => word.length > 0 && word.length <= MAX_ASSET_TAG_LENGTH);
    void editShelfEntry(entry, {
      tags: [...new Set(words)].slice(0, MAX_ASSET_TAGS),
      note: note.slice(0, MAX_ASSET_NOTE_LENGTH).trim(),
    });
  };

  return (
    <div className="clip-inspector-body" data-testid="clip-media-card">
      <section className="inspector-section">
        <h3 className="inspector-asset-name">{entry.name}</h3>
        {still ? (
          <img alt="" className="clip-inspector-still" src={still} />
        ) : (
          entry.mime?.startsWith("video/") && <FirstFrame assetId={entry.id} />
        )}
      </section>

      <section className="inspector-section">
        <h3>File</h3>
        {probe?.width !== undefined && probe.height !== undefined && (
          <div className="inspector-row">
            <span>Size</span>
            <span>
              {probe.width} × {probe.height}
            </span>
          </div>
        )}
        {probe?.durationMs !== undefined && (
          <div className="inspector-row">
            <span>Length</span>
            <span>{formatDuration(probe.durationMs)}</span>
          </div>
        )}
        {entry.bytes !== undefined && (
          <div className="inspector-row">
            <span>Bytes</span>
            <span>{formatBytes(entry.bytes)}</span>
          </div>
        )}
        {(probe?.mime ?? entry.mime) !== undefined && (
          <div className="inspector-row">
            <span>Format</span>
            <span>{probe?.mime ?? entry.mime}</span>
          </div>
        )}
        {probe?.codecSummary !== undefined && (
          <div className="inspector-row">
            <span>Codec</span>
            <span>{probe.codecSummary}</span>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <h3>Words</h3>
        <label className="clip-inspector-field">
          <span>Tags</span>
          <input
            onChange={(event) => setTags(event.target.value)}
            placeholder="Words, comma separated"
            value={tags}
          />
        </label>
        <label className="clip-inspector-field">
          <span>Note</span>
          <textarea
            onChange={(event) => setNote(event.target.value)}
            placeholder="What is worth remembering"
            rows={2}
            value={note}
          />
        </label>
        <button onClick={save} type="button">
          Save words
        </button>
      </section>

      <section className="inspector-section">
        <h3>Actions</h3>
        <div className="clip-inspector-actions">
          <button
            aria-label="Keep to hand"
            aria-pressed={entry.favorite === true}
            className="clip-inspector-keeper"
            onClick={() => void markAssetKeeper(entry, entry.favorite !== true)}
            type="button"
          >
            <StarIcon filled={entry.favorite === true} size={14} /> Keeper
          </button>
          <button
            disabled={timeline === null}
            onClick={() => addAssetAtPlayhead(entry.id)}
            title={
              timeline === null
                ? "This project has no timeline yet"
                : "Add at the playhead"
            }
            type="button"
          >
            Add at the playhead
          </button>
          <button
            className="danger"
            onClick={() => void requestDeleteAsset(entry.id)}
            type="button"
          >
            <TrashIcon size={14} /> Delete
          </button>
        </div>
      </section>
    </div>
  );
}
