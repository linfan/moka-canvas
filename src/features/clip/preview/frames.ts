import type { AssetId, TimelineClip } from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { decodeFrameAt, isElementOnly, mp4IndexFor } from "./decode";
import { elementEngine } from "./elementFrames";
import type { AssetEngine, PreviewEngine } from "./capabilities";
import type { FramePicture, FrameSources } from "./compositor";

/**
 * Where each clip's picture comes from.
 *
 * Three ways in, decided once per asset and held for the session: a picture is
 * an image decoded once, a video is frames from the file's own samples when a
 * decoder and a readable MP4 are both there, and otherwise a video element
 * walked to the moment. The choice is one asset's, not one frame's — a file
 * read two ways across a cut would show two different pictures — and the
 * engine an asset landed on is what the stage's badge is written from.
 *
 * A file the browser will not give up is reported once by name: a toast says
 * which one, rather than a frame that is quietly the background.
 */

export interface PreviewFrameSources extends FrameSources {
  /** Which engine an asset landed on, once it has been asked for. */
  engineOf(assetId: AssetId): AssetEngine | undefined;
  /** Subscribes to pictures arriving late, which is when the preview repaints. */
  onArrive(listener: () => void): () => void;
}

/** The asset's entry in the project, which is what says what kind of file it is. */
function entryFor(assetId: AssetId) {
  const resources = useProjectStore.getState().moka?.resources;
  if (!resources) return undefined;
  for (const entries of Object.values(resources)) {
    const found = entries.find((entry) => entry.id === assetId);
    if (found) return found;
  }
  return undefined;
}

const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

function looksLikeImage(name: string, mime: string | undefined): boolean {
  if (mime?.startsWith("image/")) return true;
  // A document written before a file was probed carries no mime; the name is
  // the only thing left that says what it is.
  return mime === undefined && IMAGE_SUFFIX.test(name);
}

/** What the picture under the playhead is being made with, for the stage's own account. */
export function frameEngine(
  clips: TimelineClip[],
  engineOf: (assetId: AssetId) => AssetEngine | undefined,
): PreviewEngine {
  if (clips.length === 0) return "none";
  let element = false;
  let coded = false;
  for (const clip of clips) {
    if (clip.kind !== "video" || !clip.assetId) continue;
    const engine = engineOf(clip.assetId);
    if (engine === "element") element = true;
    else if (engine === "webcodecs") coded = true;
  }
  // The weakest engine in the frame is the one worth saying: an approximate
  // picture is approximate whatever else is drawn over it.
  if (element) return "element";
  if (coded) return "webcodecs";
  return "image";
}

export function createFrameSources(): PreviewFrameSources {
  const images = new Map<AssetId, HTMLImageElement>();
  const started = new Set<AssetId>();
  const engines = new Map<AssetId, AssetEngine>();
  const reported = new Set<AssetId>();
  let arrivals: (() => void)[] = [];

  const notifyArrive = (): void => {
    for (const listener of arrivals) listener();
  };

  const reportMissing = (assetId: AssetId): void => {
    if (reported.has(assetId)) return;
    reported.add(assetId);
    const name = entryFor(assetId)?.name ?? "A file";
    useAppStore.getState().pushToast("error", `${name} cannot be read.`);
  };

  // A file the browser could not play is one to say so about, exactly once.
  elementEngine().onProblem(reportMissing);
  elementEngine().onArrive(notifyArrive);

  /** An image decoded once, which is all a still frame ever needs. */
  const imageFor = (assetId: AssetId): HTMLImageElement | null => {
    const kept = images.get(assetId);
    if (kept) return kept;
    // A test without a DOM never makes an image, the same way the shelf never
    // makes a sound in one.
    if (started.has(assetId) || typeof Image === "undefined") return null;
    started.add(assetId);
    const image = new Image();
    image.onload = () => {
      images.set(assetId, image);
      notifyArrive();
    };
    image.onerror = () => reportMissing(assetId);
    image.src = assetUrl(assetId);
    return null;
  };

  const engineFor = async (assetId: AssetId): Promise<AssetEngine | null> => {
    const kept = engines.get(assetId);
    if (kept) return kept;
    const entry = entryFor(assetId);
    if (!entry) {
      // The document no longer holds the file: there is nothing to read.
      reportMissing(assetId);
      return null;
    }
    if (looksLikeImage(entry.name, entry.mime)) {
      engines.set(assetId, "image");
      return "image";
    }
    if (typeof VideoDecoder !== "undefined" && !isElementOnly(assetId)) {
      const index = await mp4IndexFor(assetId);
      if (index?.video) {
        engines.set(assetId, "webcodecs");
        return "webcodecs";
      }
    }
    engines.set(assetId, "element");
    return "element";
  };

  const pictureOf = async (
    clip: TimelineClip,
    materialMs: number,
  ): Promise<FramePicture | null> => {
    const assetId = clip.assetId;
    if (!assetId) return null;
    const engine = await engineFor(assetId);
    if (engine === null) return null;
    if (engine === "image") {
      const image = imageFor(assetId);
      if (!image) return { kind: "waiting" };
      return {
        kind: "picture",
        picture: {
          source: image,
          width: image.naturalWidth,
          height: image.naturalHeight,
          rotationDeg: 0,
        },
      };
    }
    if (engine === "webcodecs") {
      try {
        const decoded = await decodeFrameAt(assetId, materialMs);
        if (decoded) {
          return {
            kind: "picture",
            picture: {
              source: decoded.frame,
              width: decoded.frame.displayWidth,
              height: decoded.frame.displayHeight,
              rotationDeg: decoded.rotationDeg,
            },
          };
        }
      } catch {
        // A decode that failed after the engine was chosen sends the file to
        // the elements rather than failing the frame.
      }
      engines.set(assetId, "element");
    }
    const element = elementEngine().elementFor(clip.id, assetId, materialMs);
    if (!element) return { kind: "waiting" };
    // An element stands its own picture up: the browser applies the file's own
    // display matrix, so nothing is turned here.
    return {
      kind: "picture",
      picture: {
        source: element,
        width: element.videoWidth,
        height: element.videoHeight,
        rotationDeg: 0,
      },
    };
  };

  return {
    frameFor: pictureOf,
    engineOf: (assetId) => engines.get(assetId),
    onArrive(listener) {
      arrivals.push(listener);
      return () => {
        arrivals = arrivals.filter((kept) => kept !== listener);
      };
    },
  };
}

let shared: PreviewFrameSources | null = null;

/** The one set of frame sources, made on first use so a test without a DOM makes nothing. */
export function previewFrames(): PreviewFrameSources {
  if (!shared) shared = createFrameSources();
  return shared;
}
