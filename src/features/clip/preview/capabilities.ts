import { i18n } from "../../../shared/i18n";

/**
 * What this browser will and will not do, asked once.
 *
 * Every degradation the preview takes is shown rather than silently wrong, and
 * this is where the fact behind the badge is read: whether frames can be
 * decoded, whether the canvas takes a filter, and whether there are elements
 * to fall back on. The probe is injectable so what a browser without a decoder
 * looks like can be tested without one.
 *
 * Package 07's quality tiers and package 12's export dialog read the same
 * answers rather than asking their own questions.
 */

/** What the picture under the playhead is being made with. */
export type PreviewEngine = "webcodecs" | "element" | "image" | "none";

/** Which engine reads one asset's frames. */
export type AssetEngine = "webcodecs" | "element" | "image";

export interface PreviewCapabilities {
  /** A `VideoDecoder` is there: a secure context and a browser new enough. */
  webCodecs: boolean;
  /** The canvas takes a `filter` string, so grades and looks can be shown. */
  filter: boolean;
  /** There is a DOM to hold the `<video>` elements the fallback engine reads. */
  video: boolean;
}

export interface CapabilityProbe {
  webCodecs(): boolean;
  filter(): boolean;
  video(): boolean;
}

function browserProbe(): CapabilityProbe {
  return {
    webCodecs: () => typeof VideoDecoder !== "undefined",
    video: () =>
      typeof document !== "undefined" &&
      typeof HTMLVideoElement !== "undefined",
    filter: () => {
      if (typeof document === "undefined") return false;
      const probe = document.createElement("canvas").getContext("2d");
      return probe !== null && "filter" in probe;
    },
  };
}

export function detectCapabilities(
  probe: CapabilityProbe = browserProbe(),
): PreviewCapabilities {
  const ask = (question: () => boolean): boolean => {
    try {
      return question();
    } catch {
      // A probe that cannot answer has answered: the feature is not there.
      return false;
    }
  };
  return {
    webCodecs: ask(probe.webCodecs),
    filter: ask(probe.filter),
    video: ask(probe.video),
  };
}

let asked: PreviewCapabilities | null = null;

/** The session's answers, read once: capabilities do not change under a page. */
export function previewCapabilities(): PreviewCapabilities {
  if (!asked) asked = detectCapabilities();
  return asked;
}

/** Why the frame on screen is an approximation, or null when it is not. */
export function approximateReason(
  capabilities: PreviewCapabilities,
  engine: PreviewEngine,
  coloursSkipped: boolean,
): string | null {
  const reasons: string[] = [];
  if (engine === "element") {
    reasons.push(
      capabilities.webCodecs
        ? i18n.t("clip:preview.elementFramesOut")
        : i18n.t("clip:preview.noWebCodecs"),
    );
  }
  if (coloursSkipped) {
    reasons.push(i18n.t("clip:preview.noColourFilters"));
  }
  return reasons.length > 0 ? reasons.join(" ") : null;
}
