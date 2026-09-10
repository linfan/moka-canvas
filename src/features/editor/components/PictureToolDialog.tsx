import { useEffect, useState } from "react";
import { assetUrl } from "../../../api";
import type {
  PictureFit,
  PictureRegion,
  PictureTool,
  PictureToolParams,
} from "../../../api/tools";
import { MAX_OPERATED_PIXELS, MAX_TILT_DEGREES } from "../../../shared/domain";
import { buildResourceIndex } from "../canvas/mediaCards";
import { applyPictureTool } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import {
  CROP_RATIOS,
  MAX_DIVISIONS_PER_SIDE,
  SPLIT_GRIDS,
  TOOL_LABELS,
  useToolPrefs,
} from "../stores/toolPrefs";

/** The size of the picture itself, in its own pixels. */
interface Size {
  width: number;
  height: number;
}

/**
 * What the four tools can be asked for, held together.
 *
 * Numbers stay as words until they are sent: a field being typed into is empty
 * more often than it is zero, and an empty field that read as zero would be an
 * ask for a region no picture has.
 */
interface Draft {
  /** Whether a cut is an exact region rather than a proportion. */
  exact: boolean;
  ratio: string;
  x: string;
  y: string;
  width: string;
  height: string;
  rows: string;
  cols: string;
  /** A size by name, or one asked for exactly. */
  size: "k2" | "k4" | "box";
  boxWidth: string;
  boxHeight: string;
  fit: PictureFit;
  yaw: number;
  pitch: number;
}

/** What each tool is for, said before it is used rather than after. */
const PURPOSE: Record<PictureTool, string> = {
  crop: "Cuts a region out and files it as a picture of its own. The picture this node holds is left exactly as it is.",
  split:
    "Divides the picture into pieces and files each one, in reading order.",
  resize:
    "Resamples the pixels that are here. It can make a picture smaller cleanly, and larger only by guessing — a model is what adds detail.",
  tilt: "Turns the picture in perspective and files the plate, with the words that describe the shot beside it.",
};

const FIT_LABELS: Record<PictureFit, string> = {
  contain: "Fit inside",
  cover: "Fill, cutting",
  fill: "Fill, stretching",
};

const FIT_HINTS: Record<PictureFit, string> = {
  contain: "The whole picture, as large as the box allows.",
  cover:
    "The whole box, from the middle of the picture. What overflows is cut.",
  fill: "The whole box, whatever that does to the shape.",
};

/** The long edge a named size stands for. */
const NAMED_PIXELS: Record<"k2" | "k4", number> = { k2: 2048, k4: 4096 };

/** A whole number of pixels, or null when the field is not one. */
function whole(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** What a proportion says, as wide over tall, or null when it says nothing. */
function ratioOf(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length !== 2) return null;
  const across = Number(parts[0]);
  const down = Number(parts[1]);
  if (!Number.isFinite(across) || !Number.isFinite(down)) return null;
  if (across <= 0 || down <= 0) return null;
  return across / down;
}

/**
 * The largest region of a proportion that fits in a picture, centred.
 *
 * Rounded down and then centred, so a region this makes is always inside the
 * picture it was made for: rounding the far edge up would put it a pixel
 * outside, and there is no pixel there to cut.
 */
function regionForRatio(
  ratio: number | null,
  size: Size,
): PictureRegion | null {
  if (ratio === null) return null;
  const tall = size.width / ratio;
  const width = Math.floor(
    tall > size.height ? size.height * ratio : size.width,
  );
  const height = Math.floor(width / ratio);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.floor((size.width - width) / 2),
    y: Math.floor((size.height - height) / 2),
    width,
    height,
  };
}

/** The exact region the fields hold, when they hold one that is inside. */
function regionOf(draft: Draft, size: Size | null): PictureRegion | null {
  const x = whole(draft.x);
  const y = whole(draft.y);
  const width = whole(draft.width);
  const height = whole(draft.height);
  if (x === null || y === null || width === null || height === null)
    return null;
  if (width < 1 || height < 1) return null;
  if (size && (x + width > size.width || y + height > size.height)) return null;
  return { x, y, width, height };
}

/** The box a resample is asked to meet. */
function boxOf(draft: Draft): Size | null {
  if (draft.size !== "box") {
    const edge = NAMED_PIXELS[draft.size];
    return { width: edge, height: edge };
  }
  const width = whole(draft.boxWidth);
  const height = whole(draft.boxHeight);
  if (width === null || height === null || width < 1 || height < 1) return null;
  return { width, height };
}

/** What a resample would make of the picture it is given. */
function resampled(draft: Draft, size: Size, box: Size): Size {
  if (draft.fit !== "contain") return box;
  const scale = Math.min(box.width / size.width, box.height / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** What the dialog holds: the ask it would send, or the reason it is not one. */
type Asking =
  | { ask: PictureToolParams[PictureTool]; refusal: null }
  | { ask: null; refusal: string };

/**
 * One reading of the fields rather than two.
 *
 * A check that says an ask is acceptable and a builder that then builds
 * something else is a disagreement waiting to happen, so what is refused and
 * what would be sent are worked out together: an ask that cannot be built is the
 * refusal. Refused here rather than left to the server wherever the dialog can
 * see it, because a refusal that arrives as a failed request reads as something
 * the program did rather than as something missing in the fields.
 */
function askedFor(tool: PictureTool, draft: Draft, size: Size | null): Asking {
  if (size && size.width * size.height > MAX_OPERATED_PIXELS) {
    const ceiling = MAX_OPERATED_PIXELS.toLocaleString();
    return {
      ask: null,
      refusal: `This picture is ${size.width.toLocaleString()} by ${size.height.toLocaleString()}, which is past the ${ceiling} pixels one tool works on — make it smaller first`,
    };
  }
  switch (tool) {
    case "crop": {
      if (!draft.exact) {
        const ratio = ratioOf(draft.ratio);
        if (ratio === null) {
          return {
            ask: null,
            refusal:
              "A proportion is two numbers with a colon between them, like 16:9",
          };
        }
        if (size && regionForRatio(ratio, size) === null) {
          return {
            ask: null,
            refusal: `A picture ${size.width} by ${size.height} has no room for that proportion`,
          };
        }
        return { ask: { ratio: draft.ratio.trim() }, refusal: null };
      }
      const region = regionOf(draft, size);
      if (region === null) {
        return {
          ask: null,
          refusal: size
            ? `A region is four whole numbers inside the picture, which is ${size.width} by ${size.height}`
            : "A region is four whole numbers of pixels: how far in, how far down, how wide, how tall",
        };
      }
      return { ask: { region }, refusal: null };
    }
    case "split": {
      const rows = whole(draft.rows);
      const cols = whole(draft.cols);
      if (rows === null || cols === null || rows < 1 || cols < 1) {
        return {
          ask: null,
          refusal: "A division is one whole number of rows and one of columns",
        };
      }
      if (rows > MAX_DIVISIONS_PER_SIDE || cols > MAX_DIVISIONS_PER_SIDE) {
        return {
          ask: null,
          refusal: `${MAX_DIVISIONS_PER_SIDE} is as far as one division goes each way`,
        };
      }
      return { ask: { rows, cols }, refusal: null };
    }
    case "resize": {
      const box = boxOf(draft);
      if (!box) {
        return {
          ask: null,
          refusal:
            "A size is two whole numbers of pixels, at least one each way",
        };
      }
      if (box.width * box.height > MAX_OPERATED_PIXELS) {
        const ceiling = MAX_OPERATED_PIXELS.toLocaleString();
        return {
          ask: null,
          refusal: `${box.width.toLocaleString()} by ${box.height.toLocaleString()} is past the ${ceiling} pixels one tool works on`,
        };
      }
      return {
        ask:
          draft.size === "box"
            ? { target: box, fit: draft.fit }
            : { target: draft.size, fit: draft.fit },
        refusal: null,
      };
    }
    case "tilt": {
      if (draft.yaw === 0 && draft.pitch === 0) {
        return { ask: null, refusal: "Nothing to turn yet" };
      }
      if (
        Math.abs(draft.yaw) > MAX_TILT_DEGREES ||
        Math.abs(draft.pitch) > MAX_TILT_DEGREES
      ) {
        return {
          ask: null,
          refusal: `${MAX_TILT_DEGREES} degrees is as far as this turns`,
        };
      }
      return { ask: { yaw: draft.yaw, pitch: draft.pitch }, refusal: null };
    }
  }
}

/** What a tool's fields start at, which is what they were last asked for. */
function starting(): Draft {
  const { cropRatio, grid } = useToolPrefs.getState();
  return {
    exact: false,
    ratio: cropRatio ?? "1:1",
    x: "0",
    y: "0",
    width: "",
    height: "",
    rows: `${grid?.rows ?? 2}`,
    cols: `${grid?.cols ?? 2}`,
    size: "k2",
    boxWidth: "",
    boxHeight: "",
    fit: "contain",
    yaw: 0,
    pitch: 0,
  };
}

/**
 * Asks one picture tool what it is to do, over a preview of the picture it is to
 * do it to.
 *
 * One frame for all four, with the parameters inside it, because what changes
 * between them is the middle and not the shape: a reader who has learnt where the
 * picture is and where the button is has learnt it for all of them.
 *
 * Every number here is in the picture's own pixels and never in the node's. A
 * node can be drawn at any size and still hold one picture, so a region measured
 * against the node would mean something different from the same region measured
 * against the picture — and the picture is what is worked on.
 */
export function PictureToolDialog() {
  const opened = useEditorStore((state) => state.pictureTool);
  // Standing aside for the marking entry has to be complete, keys included: an
  // Escape listener left running here would close the dialog that is open as
  // well as the one that is not.
  const asked = opened?.tool === "repaint" ? null : opened;
  const moka = useProjectStore((state) => state.moka);
  const [draft, setDraft] = useState<Draft>(starting);
  const [size, setSize] = useState<Size | null>(null);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);

  const tool = asked?.tool ?? null;
  const key = asked ? `${asked.nodeId}:${asked.assetId}:${asked.tool}` : null;

  useEffect(() => {
    if (!asked) return;
    setSize(null);
    setUnread(false);
    setBusy(false);
    setDraft(starting());
    // The key is the ask: what is typed belongs to the node, the picture and the
    // tool this dialog came up for, and not to the one before it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Escape closes it. The editor's own map is quiet while the dialog is open, so
  // the key cannot both close it and let go of the node behind it.
  useEffect(() => {
    if (!asked) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      useEditorStore.getState().closePictureTool();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [asked]);

  // A region is offered already filled in rather than left empty for somebody to
  // guess four numbers into: the largest region of the proportion now showing,
  // centred, which is the cut most of them meant.
  useEffect(() => {
    if (!size) return;
    setDraft((state) => {
      if (state.width.trim() !== "") return state;
      const region = regionForRatio(ratioOf(state.ratio), size);
      if (!region) return state;
      return {
        ...state,
        x: `${region.x}`,
        y: `${region.y}`,
        width: `${region.width}`,
        height: `${region.height}`,
      };
    });
  }, [size]);

  // The marking entry has a dialog of its own, since what it asks for is a region
  // drawn on the picture rather than one written in numbers.
  if (!asked || tool === null || tool === "repaint") return null;
  const entry = moka ? buildResourceIndex(moka).get(asked.assetId) : undefined;
  if (!entry) return null;

  const close = () => useEditorStore.getState().closePictureTool();
  const set = (patch: Partial<Draft>) =>
    setDraft((state) => ({ ...state, ...patch }));
  const asking = askedFor(tool, draft, size);
  const refusal = asking.refusal;

  const submit = async () => {
    if (busy || asking.ask === null) return;
    setBusy(true);
    // What was just asked for is what the dialog comes up with next time, which
    // is the whole of what remembering it means.
    const { rememberCrop, rememberGrid } = useToolPrefs.getState();
    if (tool === "crop" && !draft.exact) rememberCrop(draft.ratio.trim());
    if (tool === "split") {
      const rows = whole(draft.rows);
      const cols = whole(draft.cols);
      if (rows && cols) rememberGrid({ rows, cols });
    }
    const made = await applyPictureTool(
      asked.nodeId,
      asked.assetId,
      tool,
      asking.ask,
    );
    setBusy(false);
    if (made) close();
  };

  const rows = whole(draft.rows);
  const cols = whole(draft.cols);
  const pieces = rows !== null && cols !== null ? rows * cols : null;
  // Drawn as parts of the picture rather than as pixels of it, because what is on
  // screen is the picture scaled to fit, and a part is the same at any size.
  const outlined =
    tool === "crop" && size
      ? draft.exact
        ? regionOf(draft, size)
        : regionForRatio(ratioOf(draft.ratio), size)
      : null;
  const box = boxOf(draft);
  const outcome =
    tool === "resize" && size && box ? resampled(draft, size, box) : null;
  const guessed =
    outcome !== null && size !== null
      ? outcome.width * outcome.height > size.width * size.height
      : false;

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <form
        aria-labelledby="picture-tool-title"
        aria-modal="true"
        className="dialog tool-dialog"
        data-testid="picture-tool-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        role="dialog"
      >
        <h2 id="picture-tool-title">
          {TOOL_LABELS[tool]} — {entry.name}
        </h2>
        <p className="dialog-note">{PURPOSE[tool]}</p>

        <div className="tool-stage">
          <div className="tool-frame">
            <img
              alt=""
              onError={() => setUnread(true)}
              onLoad={(event) =>
                setSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              src={assetUrl(asked.assetId)}
              style={
                tool === "tilt"
                  ? {
                      transform: `perspective(900px) rotateY(${draft.yaw}deg) rotateX(${draft.pitch}deg)`,
                    }
                  : undefined
              }
            />
            {outlined && size && (
              <div
                className="tool-outline"
                style={{
                  left: `${(outlined.x / size.width) * 100}%`,
                  top: `${(outlined.y / size.height) * 100}%`,
                  width: `${(outlined.width / size.width) * 100}%`,
                  height: `${(outlined.height / size.height) * 100}%`,
                }}
              />
            )}
            {tool === "split" && pieces !== null && (
              <div
                className="tool-grid"
                style={{
                  backgroundImage:
                    "linear-gradient(to right, var(--primary) 1px, transparent 1px)," +
                    "linear-gradient(to bottom, var(--primary) 1px, transparent 1px)",
                  backgroundSize: `${100 / Math.max(1, cols ?? 1)}% ${
                    100 / Math.max(1, rows ?? 1)
                  }%`,
                }}
              />
            )}
          </div>
        </div>

        <p className="dialog-note">
          {unread
            ? "The picture cannot be shown here. The numbers are still in its own pixels, and the tool works on the file itself."
            : size
              ? `${size.width.toLocaleString()} × ${size.height.toLocaleString()} pixels. Every number here is in them, not in the size the node is drawn at.`
              : "Reading the picture…"}
        </p>

        {tool === "crop" && (
          <div className="tool-params">
            <div
              aria-label="How the region is given"
              className="tool-choices"
              role="group"
            >
              <button
                aria-pressed={!draft.exact}
                onClick={() => set({ exact: false })}
                type="button"
              >
                A proportion
              </button>
              <button
                aria-pressed={draft.exact}
                onClick={() => set({ exact: true })}
                type="button"
              >
                An exact region
              </button>
            </div>
            {draft.exact ? (
              <div className="settings-columns">
                {(
                  [
                    ["x", "How far in"],
                    ["y", "How far down"],
                    ["width", "How wide"],
                    ["height", "How tall"],
                  ] as const
                ).map(([field, label]) => (
                  <label className="dialog-field" key={field}>
                    <span>{label}</span>
                    <input
                      aria-label={label}
                      inputMode="numeric"
                      onChange={(event) => set({ [field]: event.target.value })}
                      value={draft[field]}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <>
                <div
                  aria-label="Proportions offered"
                  className="tool-choices"
                  role="group"
                >
                  {CROP_RATIOS.map((ratio) => (
                    <button
                      aria-pressed={draft.ratio === ratio}
                      key={ratio}
                      onClick={() => set({ ratio })}
                      type="button"
                    >
                      {ratio}
                    </button>
                  ))}
                </div>
                <label className="dialog-field">
                  <span>Or written out</span>
                  <input
                    onChange={(event) => set({ ratio: event.target.value })}
                    placeholder="16:9"
                    value={draft.ratio}
                  />
                </label>
              </>
            )}
          </div>
        )}

        {tool === "split" && (
          <div className="tool-params">
            <div
              aria-label="Divisions offered"
              className="tool-choices"
              role="group"
            >
              {SPLIT_GRIDS.map((grid) => (
                <button
                  aria-pressed={
                    draft.rows === `${grid.rows}` &&
                    draft.cols === `${grid.cols}`
                  }
                  key={`${grid.rows}x${grid.cols}`}
                  onClick={() =>
                    set({ rows: `${grid.rows}`, cols: `${grid.cols}` })
                  }
                  type="button"
                >
                  {grid.rows} × {grid.cols}
                </button>
              ))}
            </div>
            <div className="settings-columns">
              <label className="dialog-field">
                <span>Rows</span>
                <input
                  aria-label="Rows"
                  inputMode="numeric"
                  max={MAX_DIVISIONS_PER_SIDE}
                  min={1}
                  onChange={(event) => set({ rows: event.target.value })}
                  value={draft.rows}
                />
              </label>
              <label className="dialog-field">
                <span>Columns</span>
                <input
                  aria-label="Columns"
                  inputMode="numeric"
                  max={MAX_DIVISIONS_PER_SIDE}
                  min={1}
                  onChange={(event) => set({ cols: event.target.value })}
                  value={draft.cols}
                />
              </label>
            </div>
            <p className="dialog-note">
              {pieces === null
                ? "How many pieces, across and down."
                : `${pieces} ${pieces === 1 ? "piece" : "pieces"}, filed in reading order and selected together, so they can be grouped the moment they land.`}
            </p>
          </div>
        )}

        {tool === "resize" && (
          <div className="tool-params">
            <div
              aria-label="The size to meet"
              className="tool-choices"
              role="group"
            >
              <button
                aria-pressed={draft.size === "k2"}
                onClick={() => set({ size: "k2" })}
                type="button"
              >
                2k
              </button>
              <button
                aria-pressed={draft.size === "k4"}
                onClick={() => set({ size: "k4" })}
                type="button"
              >
                4k
              </button>
              <button
                aria-pressed={draft.size === "box"}
                onClick={() => set({ size: "box" })}
                type="button"
              >
                Exact
              </button>
            </div>
            {draft.size === "box" && (
              <div className="settings-columns">
                <label className="dialog-field">
                  <span>Pixels wide</span>
                  <input
                    aria-label="Pixels wide"
                    inputMode="numeric"
                    onChange={(event) => set({ boxWidth: event.target.value })}
                    value={draft.boxWidth}
                  />
                </label>
                <label className="dialog-field">
                  <span>Pixels tall</span>
                  <input
                    aria-label="Pixels tall"
                    inputMode="numeric"
                    onChange={(event) => set({ boxHeight: event.target.value })}
                    value={draft.boxHeight}
                  />
                </label>
              </div>
            )}
            <div
              aria-label="How it meets the box"
              className="tool-choices"
              role="group"
            >
              {(["contain", "cover", "fill"] as const).map((fit) => (
                <button
                  aria-pressed={draft.fit === fit}
                  key={fit}
                  onClick={() => set({ fit })}
                  title={FIT_HINTS[fit]}
                  type="button"
                >
                  {FIT_LABELS[fit]}
                </button>
              ))}
            </div>
            <p className="dialog-note">
              {outcome === null
                ? "The size it will be resampled to."
                : `${outcome.width.toLocaleString()} × ${outcome.height.toLocaleString()} pixels — ${FIT_HINTS[draft.fit]}`}
              {guessed &&
                " That is larger than the picture that is there, so the extra is guessed rather than remembered."}
            </p>
          </div>
        )}

        {tool === "tilt" && (
          <div className="tool-params">
            <div className="settings-columns">
              <label className="dialog-field">
                <span>Turn — {draft.yaw}°</span>
                <input
                  aria-label="Turn"
                  max={MAX_TILT_DEGREES}
                  min={-MAX_TILT_DEGREES}
                  onChange={(event) => set({ yaw: Number(event.target.value) })}
                  step={1}
                  type="range"
                  value={draft.yaw}
                />
              </label>
              <label className="dialog-field">
                <span>Tip — {draft.pitch}°</span>
                <input
                  aria-label="Tip"
                  max={MAX_TILT_DEGREES}
                  min={-MAX_TILT_DEGREES}
                  onChange={(event) =>
                    set({ pitch: Number(event.target.value) })
                  }
                  step={1}
                  type="range"
                  value={draft.pitch}
                />
              </label>
            </div>
            <p className="dialog-note">
              A sketch of the turn rather than the pixels it will make. The
              plate keeps the picture's own size, and what the turn leaves
              see-through stays see-through — which is why it is filed as a PNG.
            </p>
          </div>
        )}

        {refusal && <p className="dialog-error">{refusal}</p>}

        <div className="dialog-actions">
          <button disabled={busy} onClick={close} type="button">
            Cancel
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy || refusal !== null}
            title={refusal ?? undefined}
            type="submit"
          >
            {busy ? "Working…" : TOOL_LABELS[tool]}
          </button>
        </div>
      </form>
    </div>
  );
}
