import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
        <h3>{t("clip:mediaCard.file")}</h3>
        {probe?.width !== undefined && probe.height !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.size")}</span>
            <span>
              {probe.width} × {probe.height}
            </span>
          </div>
        )}
        {probe?.durationMs !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.length")}</span>
            <span>{formatDuration(probe.durationMs)}</span>
          </div>
        )}
        {entry.bytes !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.bytes")}</span>
            <span>{formatBytes(entry.bytes)}</span>
          </div>
        )}
        {(probe?.mime ?? entry.mime) !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.format")}</span>
            <span>{probe?.mime ?? entry.mime}</span>
          </div>
        )}
        {probe?.codecSummary !== undefined && (
          <div className="inspector-row">
            <span>{t("clip:mediaCard.codec")}</span>
            <span>{probe.codecSummary}</span>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <h3>{t("clip:mediaCard.words")}</h3>
        <label className="clip-inspector-field">
          <span>{t("clip:mediaCard.tags")}</span>
          <input
            onChange={(event) => setTags(event.target.value)}
            placeholder={t("clip:mediaCard.tagsHint")}
            value={tags}
          />
        </label>
        <label className="clip-inspector-field">
          <span>{t("clip:mediaCard.note")}</span>
          <textarea
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("clip:mediaCard.noteHint")}
            rows={2}
            value={note}
          />
        </label>
        <button onClick={save} type="button">
          {t("clip:mediaCard.saveWords")}
        </button>
      </section>

      <section className="inspector-section">
        <h3>{t("clip:mediaCard.actions")}</h3>
        <div className="clip-inspector-actions">
          <button
            aria-label={t("clip:mediaCard.keeperAria")}
            aria-pressed={entry.favorite === true}
            className="clip-inspector-keeper"
            onClick={() => void markAssetKeeper(entry, entry.favorite !== true)}
            type="button"
          >
            <StarIcon filled={entry.favorite === true} size={14} />{" "}
            {t("clip:mediaCard.keeper")}
          </button>
          <button
            disabled={timeline === null}
            onClick={() => addAssetAtPlayhead(entry.id)}
            title={
              timeline === null
                ? t("clip:mediaCard.noTimeline")
                : t("clip:common.addAtPlayhead")
            }
            type="button"
          >
            {t("clip:common.addAtPlayhead")}
          </button>
          <button
            className="danger"
            onClick={() => void requestDeleteAsset(entry.id)}
            type="button"
          >
            <TrashIcon size={14} /> {t("clip:common.delete")}
          </button>
        </div>
      </section>
    </div>
  );
}
