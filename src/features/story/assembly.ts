/**
 * Laying a telling's shots end to end as one timeline.
 *
 * Everything here is arithmetic over the document: which clips the fourth step
 * has made, in what order they go, where each of them lands, and what one
 * `execute` has to write to put them there. Nothing reads a store or asks a
 * server, so what an assembly will do is the same answer in a test, in the
 * warning a reader is shown, and in the commands that are finally written.
 *
 * A telling is assembled twice over in the ordinary run of things — once when
 * its clips are first cut, and again every time another act is filmed — so what
 * goes on the timeline is planned first and looked at before it is applied, and
 * an assembly with nothing to lay down is refused rather than written empty.
 */

import { CommandError } from "../../shared/domain/commands";
import {
  createClipFromAsset,
  createTextClip,
  createTimeline,
} from "../../shared/domain/factories";
import { findResource } from "../../shared/domain/validate";
import {
  actPlannedMs,
  currentTake,
  timelineSizeForAspect,
} from "../../shared/domain/story";
import type {
  DocumentCommand,
  MokaFile,
  ResourceEntry,
  StoryAct,
  StoryDocument,
  StoryEdit,
  StoryKeyframe,
  StorySlot,
  StoryTake,
  TimelineClip,
  TimelineDocument,
} from "../../shared/domain/types";
import { i18n } from "../../shared/i18n";

/** How a finished cut is framed, whichever telling it came from. */
const ASSEMBLY_FPS = 30;
const ASSEMBLY_BACKGROUND = "#000000";

/** One shot of the finished film, before it becomes a clip. */
export interface AssemblyUnit {
  actId: string;
  keyframeId?: string;
  /** Which episode this is, counted from one. */
  chapterIndex: number;
  /** Which act of that episode, counted from one. */
  actIndex: number;
  /** Where it lands on the timeline, in milliseconds. */
  startMs: number;
  /** How long it runs: what the material measures, or what it was planned for. */
  durationMs: number;
  /** The clip of the fourth step that is laid down. */
  take: StoryTake;
  /** What the shot was planned to run for, which is what its captions share. */
  plannedMs: number;
  /** Whether the reader agreed to this clip, which does not decide inclusion. */
  confirmed: boolean;
}

/** Something about the telling that the reader should know before assembling. */
export interface AssemblyWarning {
  kind: "noVideo" | "unconfirmed" | "assetMissing" | "noDuration";
  chapterId: string;
  actId: string;
  keyframeId?: string;
  /** Where the shot is, in the reader's language: "Episode 2 · Act 3". */
  place: string;
}

/** What an assembly would lay down, and what is worth saying about it. */
export interface AssemblyPlan {
  units: AssemblyUnit[];
  warnings: AssemblyWarning[];
  /** How long the finished cut runs, in the lengths the plan knows. */
  totalPlannedMs: number;
}

/** What one shot of the plan is made of, at the granularity in force. */
interface ShotSlot {
  keyframe?: StoryKeyframe;
  slot: StorySlot;
  plannedMs: number;
  confirmed: boolean;
}

/**
 * The shots of an act as they are laid down, at the granularity in force.
 *
 * One shot per act when clips are made by act, and one per keyframe when they
 * are made by keyframe — the difference between a film of six long takes and
 * one of thirty short ones, decided here and nowhere else.
 */
function shotsOf(story: StoryDocument, act: StoryAct): ShotSlot[] {
  if (story.shotGranularity === "keyframe") {
    return act.keyframes.map((keyframe) => ({
      keyframe,
      slot: keyframe.video,
      plannedMs: keyframe.durationMs,
      confirmed: keyframe.video.confirmed,
    }));
  }
  return [
    {
      slot: act.video,
      plannedMs: actPlannedMs(act),
      confirmed: act.videoConfirmed,
    },
  ];
}

/** How long a clip runs: what the material measures, or what it was planned for. */
function lengthOf(resource: ResourceEntry, plannedMs: number): number {
  return resource.probe?.durationMs ?? plannedMs;
}

/**
 * Every clip the fourth step has made, in the order it is played in.
 *
 * The order is the telling's own: episode, then act, then shot. A shot with no
 * clip is named in the warnings rather than passed over in silence — a reader
 * being shown a film with a hole in it wants to know where the hole is — and a
 * clip the reader has not agreed to is laid down all the same, since agreeing
 * to a clip is saying they like it, not saying it may be shown.
 */
export function planAssembly(
  story: StoryDocument,
  moka: MokaFile,
): AssemblyPlan {
  const units: AssemblyUnit[] = [];
  const warnings: AssemblyWarning[] = [];
  let at = 0;

  story.chapters.forEach((chapter, chapterAt) => {
    chapter.acts.forEach((act, actAt) => {
      const place = i18n.t("story:edit.place", {
        chapter: chapterAt + 1,
        act: actAt + 1,
      });
      for (const shot of shotsOf(story, act)) {
        const where = {
          chapterId: chapter.id,
          actId: act.id,
          ...(shot.keyframe === undefined
            ? {}
            : { keyframeId: shot.keyframe.id }),
          place,
        };
        const take = currentTake(shot.slot);
        if (take === undefined) {
          warnings.push({ kind: "noVideo", ...where });
          continue;
        }
        const resource = findResource(moka, take.assetId);
        if (resource === undefined) {
          // An asset the document no longer holds cannot be laid on a track:
          // the clip would be a hole with a name. Saying which one is the
          // useful part of finding out.
          warnings.push({ kind: "assetMissing", ...where });
          continue;
        }
        if (!shot.confirmed) warnings.push({ kind: "unconfirmed", ...where });
        if (resource.probe?.durationMs === undefined) {
          warnings.push({ kind: "noDuration", ...where });
        }
        const durationMs = lengthOf(resource, shot.plannedMs);
        units.push({
          actId: act.id,
          ...(shot.keyframe === undefined
            ? {}
            : { keyframeId: shot.keyframe.id }),
          chapterIndex: chapterAt + 1,
          actIndex: actAt + 1,
          startMs: at,
          durationMs,
          take,
          plannedMs: shot.plannedMs,
          confirmed: shot.confirmed,
        });
        at += durationMs;
      }
    });
  });

  return {
    units,
    warnings,
    totalPlannedMs: units.reduce((sum, unit) => sum + unit.durationMs, 0),
  };
}

/**
 * What assembling writes, as the one batch of commands it is.
 *
 * A telling assembled for the first time brings a timeline of its own with it;
 * one assembled again edits that same timeline — taking back only the clips it
 * laid down itself, so a reader's own work on the same track is left where it
 * stands. Either way it is one step of the history, because it is one thing the
 * reader asked for.
 */
export function assemblyCommands(
  story: StoryDocument,
  moka: MokaFile,
  plan: AssemblyPlan,
  options: { withSubtitles: boolean; timelineId?: string },
): {
  commands: DocumentCommand[];
  clipByAct: NonNullable<StoryEdit["clipByAct"]>;
} {
  if (plan.units.length === 0) {
    throw new CommandError(
      "VALIDATION_FAILED",
      i18n.t("story:edit.nothingToAssemble"),
    );
  }
  const size = timelineSizeForAspect(story.brief.aspect);
  const target =
    options.timelineId === undefined
      ? undefined
      : (moka.timelines ?? []).find((held) => held.id === options.timelineId);

  if (target === undefined) {
    const timeline = createTimeline(
      i18n.t("story:edit.timelineName", { name: story.name }),
      {
        width: size.width,
        height: size.height,
        fps: ASSEMBLY_FPS,
        background: ASSEMBLY_BACKGROUND,
      },
    );
    const { clips, clipByAct } = layDown(story, moka, plan, {
      tracks: timeline.tracks,
      withSubtitles: options.withSubtitles,
    });
    return {
      commands: [{ type: "addTimeline", timeline: { ...timeline, clips } }],
      clipByAct,
    };
  }

  // A timeline that has lost its video row cannot carry a film: a fresh one is
  // made rather than a telling quietly laid down on the sound track.
  if (target.tracks.every((track) => track.kind !== "video")) {
    const timeline = createTimeline(
      i18n.t("story:edit.timelineName", { name: story.name }),
      {
        width: size.width,
        height: size.height,
        fps: ASSEMBLY_FPS,
        background: ASSEMBLY_BACKGROUND,
      },
    );
    return {
      commands: [{ type: "addTimeline", timeline: { ...timeline, clips: [] } }],
      clipByAct: [],
    };
  }

  const { clips, clipByAct } = layDown(story, moka, plan, {
    tracks: target.tracks,
    withSubtitles: options.withSubtitles,
  });

  const commands: DocumentCommand[] = [];
  // Only what this telling put there: a clip the reader added by hand, or
  // another telling laid down, is not this one's to take away.
  const mine = (story.edit.clipByAct ?? [])
    .map((entry) => entry.clipId)
    .filter((clipId) => target.clips.some((clip) => clip.id === clipId));
  if (mine.length > 0) {
    commands.push({
      type: "removeClips",
      timelineId: target.id,
      clipIds: mine,
    });
  }
  commands.push({ type: "addClips", timelineId: target.id, clips });
  const { width, height } = target.settings;
  if (width !== size.width || height !== size.height) {
    commands.push({
      type: "updateTimelineSettings",
      timelineId: target.id,
      settings: { width: size.width, height: size.height },
    });
  }
  return { commands, clipByAct };
}

/** The clips a plan makes, and where each of them came from. */
function layDown(
  story: StoryDocument,
  moka: MokaFile,
  plan: AssemblyPlan,
  options: {
    tracks: TimelineDocument["tracks"];
    withSubtitles: boolean;
  },
): {
  clips: TimelineClip[];
  clipByAct: NonNullable<StoryEdit["clipByAct"]>;
} {
  const clips: TimelineClip[] = [];
  const clipByAct: NonNullable<StoryEdit["clipByAct"]> = [];
  const videoTrack = options.tracks.find((track) => track.kind === "video");
  if (videoTrack === undefined) return { clips, clipByAct };
  const textTrack = options.tracks.find((track) => track.kind === "text");

  for (const unit of plan.units) {
    const resource = findResource(moka, unit.take.assetId);
    if (resource === undefined) continue;
    const clip = createClipFromAsset(resource, videoTrack.id, unit.startMs);
    clips.push({
      ...clip,
      durationMs: unit.durationMs,
      inPointMs: 0,
      outPointMs: unit.durationMs,
    });
    clipByAct.push({
      actId: unit.actId,
      ...(unit.keyframeId === undefined ? {} : { keyframeId: unit.keyframeId }),
      clipId: clip.id,
    });
  }

  if (options.withSubtitles && textTrack !== undefined) {
    for (const line of captions(story, plan, textTrack.id)) {
      clips.push(line.clip);
      clipByAct.push({
        actId: line.actId,
        // An empty id says this clip is what the whole act says rather than
        // one shot of it, which is what a re-assembly has to take back too.
        keyframeId: "",
        clipId: line.clip.id,
      });
    }
  }
  return { clips, clipByAct };
}

/**
 * Every line of the telling, as a caption inside the shot it is said in.
 *
 * A caption sits where its shot does, and several lines of one shot share the
 * length that shot was planned to run for. The plan is deliberate: a clip that
 * came back longer than it was asked for must not drag the last line of a shot
 * into the mouth of the next one.
 */
function captions(
  story: StoryDocument,
  plan: AssemblyPlan,
  trackId: string,
): Array<{ actId: string; clip: TimelineClip }> {
  const lines: Array<{ actId: string; clip: TimelineClip }> = [];
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      const starts = shotStarts(story, act, plan);
      for (const keyframe of act.keyframes) {
        const start = starts.get(keyframe.id);
        const told = keyframe.dialogue;
        if (start === undefined || told.length === 0) continue;
        const share = Math.round(keyframe.durationMs / told.length);
        told.forEach((line, at) => {
          const words =
            line.speaker.trim() === ""
              ? line.text
              : i18n.t("story:edit.line", {
                  speaker: line.speaker,
                  text: line.text,
                });
          lines.push({
            actId: act.id,
            clip: createTextClip(words, trackId, start + share * at, share),
          });
        });
      }
    }
  }
  return lines;
}

/**
 * Where each shot of an act begins on the timeline.
 *
 * A shot made by act has its own place; a shot made by keyframe begins where
 * its own clip does. A shot the plan left out is not in the answers, and its
 * words are not placed either — a caption with no picture under it is worse
 * than a missing one.
 */
function shotStarts(
  story: StoryDocument,
  act: StoryAct,
  plan: AssemblyPlan,
): Map<string, number> {
  const starts = new Map<string, number>();
  const perShot = story.shotGranularity === "keyframe";
  const actUnit = plan.units.find(
    (unit) => unit.actId === act.id && unit.keyframeId === undefined,
  );
  let planned = 0;
  for (const keyframe of act.keyframes) {
    if (perShot) {
      const unit = plan.units.find((held) => held.keyframeId === keyframe.id);
      if (unit !== undefined) starts.set(keyframe.id, unit.startMs);
    } else if (actUnit !== undefined) {
      starts.set(keyframe.id, actUnit.startMs + planned);
    }
    planned += keyframe.durationMs;
  }
  return starts;
}

/**
 * One line beside the assemble button: what this plan would do.
 *
 * The order is said out loud because it is the telling's own and not the
 * reader's to arrange here — a story is laid down episode by episode, and the
 * cutting room is where it is argued with.
 */
export function assemblySummary(
  story: StoryDocument,
  plan: AssemblyPlan,
): string {
  return i18n.t(
    story.shotGranularity === "keyframe"
      ? "story:edit.summaryByShot"
      : "story:edit.summary",
    {
      name: story.name,
      count: plan.units.length,
      seconds: (plan.totalPlannedMs / 1000).toFixed(1),
    },
  );
}
