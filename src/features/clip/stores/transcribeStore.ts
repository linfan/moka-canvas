import { create } from "zustand";
import { generateApi, type GenerateResponse } from "../../../api";
import { errorText, isConfigurationTrouble } from "../../../api/client";
import type { TextClipStyle } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { useAppStore } from "../../editor/stores/appStore";
import { useModelStore } from "../../settings/modelStore";
import {
  activeTimeline,
  materialHoldsSound,
} from "../interactions/clipActions";
import { landTranscribedCues } from "../interactions/textActions";
import { parseSrt } from "../subtitles/srt";
import {
  sourceClip,
  timelineCues,
  windowOfClip,
  type ClipWindow,
} from "../subtitles/transcribe";
import { useClipStore } from "./clipStore";

/**
 * A recording read back as words, and the words put on the cut.
 *
 * The whole errand lives here rather than in the page that asks for it: an
 * hour of speech takes minutes to recognize, and the page is a face of the
 * left column — turned away from while the reading goes on. What the page
 * holds is the ask; what this holds is the wait, and the transcript that ends
 * it, and whether any of it is still about the same cut.
 *
 * Nothing is remembered between sessions: a recognition has no life outside
 * the process that asked for it, so a reload starts from nothing.
 */

/** How long a recognition is waited on before the wait itself is the failure. */
export const TRANSCRIBE_CEILING_MS = 15 * 60 * 1000;
/** How often a job is looked at when the provider names no pace of its own. */
const POLL_MS = 1500;
/** However fast a provider says it will be looked at, it is not hammered. */
const POLL_FLOOR_MS = 500;

/** Where a recognition has got to, as far as a reader of the panel is told. */
export type TranscribePhase = "idle" | "submitting" | "recognizing" | "landing";

/** One errand: what to listen to is the selection's business, this is the rest. */
export interface TranscribeAsk {
  /** How the words are written down once they land. */
  style: TextClipStyle;
  /** The language the recording is in; empty lets the recognizer decide. */
  language: string;
  /** What a diarized sentence is prefixed with; empty means no diarizing. */
  speakerLabel: string;
}

interface TranscribeState {
  phase: TranscribePhase;
  /** What went wrong, when nothing landed; the panel says it where it stands. */
  error: string | null;
  start: (ask: TranscribeAsk) => Promise<void>;
  reset: () => void;
}

function toast(
  kind: "info" | "success" | "error",
  message: string,
  choice?: { label: string; go: () => void },
  detail?: string,
): void {
  useAppStore.getState().pushToast(kind, message, choice, detail);
}

/** The parameters a recognizer is asked with, absent ones left out. */
function askedParams(ask: TranscribeAsk): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (ask.language !== "") params.language = ask.language;
  if (ask.speakerLabel !== "") params.speakerLabel = ask.speakerLabel;
  return params;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The job's answer, once it has one.
 *
 * A job that ends badly does not come back at all — the poll is the failure —
 * so what is left here is waiting out the pending answers, at the provider's
 * own pace when it named one, until the deadline makes the wait itself the
 * thing to report.
 */
async function waitForTask(id: string): Promise<GenerateResponse> {
  const deadline = Date.now() + TRANSCRIBE_CEILING_MS;
  for (;;) {
    const answer = await generateApi.pollTask(id);
    if (answer.status === "succeeded") return answer;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(i18n.t("clip:textPanel.transcribeTimeout"));
    }
    const pace = answer.task?.retryAfterMs ?? POLL_MS;
    await wait(Math.max(POLL_FLOOR_MS, Math.min(pace, left)));
  }
}

/** Whether the audio that was sent is still the audio this clip stands for. */
function sameWindow(a: ClipWindow, b: ClipWindow): boolean {
  return a.startMs === b.startMs && a.durationMs === b.durationMs;
}

export const useTranscribeStore = create<TranscribeState>()((set, get) => ({
  phase: "idle",
  error: null,

  reset() {
    set({ phase: "idle", error: null });
  },

  async start(ask) {
    // One reading at a time: a second press while the first is out would put
    // two transcripts on the same window.
    if (get().phase !== "idle") return;
    const timeline = activeTimeline();
    if (!timeline) return;
    const clip = sourceClip(
      timeline,
      useClipStore.getState().selection.clipIds,
      useClipStore.getState().playheadMs,
      materialHoldsSound,
    );
    if (!clip) {
      toast("info", i18n.t("clip:textPanel.noSourceClip"));
      return;
    }
    const sent = windowOfClip(clip);
    set({ phase: "submitting", error: null });
    try {
      const started = await generateApi.asr({
        capability: "asr",
        params: askedParams(ask),
        inputs: [{ role: "controlAudio", assetId: clip.assetId, window: sent }],
      });
      const handle = started.task;
      if (!handle) {
        throw new Error(i18n.t("clip:textPanel.transcribeNoTask"));
      }
      set({ phase: "recognizing" });
      const answer = await waitForTask(handle.id);

      const parsed = parseSrt(answer.text ?? "");
      if (!parsed.ok) throw new Error(parsed.message);

      // The cut may have been edited while the reading was out. The times the
      // recognizer gave are measured against the window that was sent, so the
      // clip has to still be that window — moving or re-timing it is fine,
      // because the transcript is put in terms of where the clip is now.
      const now = activeTimeline();
      const standing = now?.clips.find((each) => each.id === clip.id) ?? null;
      if (!now || !standing) {
        throw new Error(i18n.t("clip:textPanel.clipGone"));
      }
      if (!sameWindow(windowOfClip(standing), sent)) {
        throw new Error(i18n.t("clip:textPanel.windowChanged"));
      }

      const cues = timelineCues(parsed.cues, standing, now.settings.fps);
      if (cues.length === 0) {
        toast("info", i18n.t("clip:textPanel.heardNothing"));
        return;
      }
      set({ phase: "landing" });
      const landed = landTranscribedCues(cues, ask.style);
      if (!landed) return;
      if (!landed.ok) throw new Error(landed.message);
      const first = landed.clips[0];
      useClipStore
        .getState()
        .select({ clipIds: [first.id], transitionId: null });
      useClipStore.getState().setPlayhead(first.startMs);
      // What the reader is told counts both kinds of dropped cue: the ones the
      // subtitle file itself left out, and the ones the window could not hold.
      const skipped = parsed.skipped + (parsed.cues.length - cues.length);
      toast(
        "success",
        skipped > 0
          ? i18n.t("clip:textPanel.transcribedWithSkipped", {
              cues: cues.length,
              skipped,
            })
          : i18n.t("clip:textPanel.transcribed", { cues: cues.length }),
      );
    } catch (problem) {
      if (isConfigurationTrouble(problem)) {
        // The reason under the setup line: a model that is missing its key
        // says so, in the reader's language, rather than only that none is set.
        const trouble = errorText(problem);
        toast(
          "error",
          i18n.t("clip:textPanel.noAsrModelReason", {
            reason: trouble.message,
          }),
          {
            label: i18n.t("clip:textPanel.openSettings"),
            go: () => useModelStore.getState().openSettings("asr"),
          },
          trouble.detail,
        );
      } else {
        set({
          error: problem instanceof Error ? problem.message : String(problem),
        });
      }
    } finally {
      set({ phase: "idle" });
    }
  },
}));
