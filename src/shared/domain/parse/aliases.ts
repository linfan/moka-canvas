/**
 * The words a board comes back with, read as the words the document keeps.
 *
 * The prompt hands the model the exact keys — `mediumClose`, `pushIn`,
 * `eyeLevel` — and asks it to choose from them. It usually does, and when it
 * does not it writes what a person would: `medium close-up`, `slow push in`,
 * and in a Chinese answer `近景`, `缓慢推进`, `俯视`. Refusing those would throw
 * away an answer that says exactly what was asked for, so each table holds the
 * spellings that mean the same key, and the key itself is checked first.
 *
 * A word none of them know is not guessed at: the caller keeps its own default
 * and says what it could not read, which is a board the reader can fix in one
 * cell rather than a shot drawn from the wrong framing.
 */

import {
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_SHOT_SIZES,
  type StoryCameraAngle,
  type StoryCameraMove,
  type StoryShotSize,
} from "../types";

/** How a word is compared: lowercase, no punctuation, single spaces. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[,.，。、]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The key a list of spellings means, one spelling per line. */
function tableOf<K extends string>(
  keys: readonly K[],
  aliases: Record<string, K>,
): Map<string, K> {
  const table = new Map<string, K>();
  for (const key of keys) table.set(normalize(key), key);
  for (const [word, key] of Object.entries(aliases)) {
    table.set(normalize(word), key);
  }
  return table;
}

const SHOT_SIZE_WORDS = tableOf<StoryShotSize>(STORY_SHOT_SIZES, {
  "extreme close": "extremeClose",
  "extreme close up": "extremeClose",
  "extreme closeup": "extremeClose",
  ecu: "extremeClose",
  大特写: "extremeClose",
  极特写: "extremeClose",
  close: "close",
  "close up": "close",
  closeup: "close",
  cu: "close",
  特写: "close",
  近景: "mediumClose",
  中近景: "mediumClose",
  "medium close": "mediumClose",
  "medium close up": "mediumClose",
  mcu: "mediumClose",
  medium: "medium",
  "medium shot": "medium",
  ms: "medium",
  中景: "medium",
  "medium full": "mediumFull",
  "medium long": "mediumFull",
  中全景: "mediumFull",
  中远景: "mediumFull",
  full: "full",
  "full shot": "full",
  "long shot": "full",
  全景: "full",
  wide: "wide",
  "wide shot": "wide",
  ws: "wide",
  远景: "wide",
  大远景: "wide",
  "extreme wide": "extremeWide",
  "extreme long": "extremeWide",
  ews: "extremeWide",
  极远景: "extremeWide",
  超远景: "extremeWide",
});

const CAMERA_MOVE_WORDS = tableOf<StoryCameraMove>(STORY_CAMERA_MOVES, {
  fixed: "static",
  locked: "static",
  "locked off": "static",
  still: "static",
  固定: "static",
  静止: "static",
  handheld: "handheld",
  "handheld follow": "handheld",
  follow: "handheld",
  手持: "handheld",
  跟拍: "handheld",
  push: "pushIn",
  "push in": "pushIn",
  "slow push in": "pushIn",
  "dolly in": "pushIn",
  缓慢推进: "pushIn",
  推近: "pushIn",
  推镜: "pushIn",
  pull: "pullOut",
  "pull out": "pullOut",
  "slow pull out": "pullOut",
  "dolly out": "pullOut",
  缓慢拉远: "pullOut",
  拉远: "pullOut",
  "pan left": "panLeft",
  "slow pan left": "panLeft",
  向左横摇: "panLeft",
  左摇: "panLeft",
  "pan right": "panRight",
  "slow pan right": "panRight",
  向右横摇: "panRight",
  右摇: "panRight",
  "tilt up": "tiltUp",
  "slow tilt up": "tiltUp",
  向上摇: "tiltUp",
  上摇: "tiltUp",
  "tilt down": "tiltDown",
  "slow tilt down": "tiltDown",
  向下摇: "tiltDown",
  下摇: "tiltDown",
  "track left": "trackLeft",
  向左平移: "trackLeft",
  左移: "trackLeft",
  "track right": "trackRight",
  向右平移: "trackRight",
  右移: "trackRight",
  arc: "arc",
  环绕: "arc",
  "crane up": "craneUp",
  升起: "craneUp",
  上升: "craneUp",
  "zoom in": "zoomIn",
  变焦推近: "zoomIn",
  推焦: "zoomIn",
  "zoom out": "zoomOut",
  变焦拉远: "zoomOut",
  拉焦: "zoomOut",
});

const CAMERA_ANGLE_WORDS = tableOf<StoryCameraAngle>(STORY_CAMERA_ANGLES, {
  "eye level": "eyeLevel",
  "straight on": "eyeLevel",
  neutral: "eyeLevel",
  平视: "eyeLevel",
  水平视角: "eyeLevel",
  high: "high",
  "high angle": "high",
  "looking down": "high",
  俯视: "high",
  高角度: "high",
  low: "low",
  "low angle": "low",
  "looking up": "low",
  仰视: "low",
  低角度: "low",
  overhead: "overhead",
  "birds eye": "overhead",
  "bird s eye": "overhead",
  "top down": "overhead",
  aerial: "overhead",
  俯瞰: "overhead",
  鸟瞰: "overhead",
  dutch: "dutch",
  canted: "dutch",
  斜角: "dutch",
  倾斜: "dutch",
  "over the shoulder": "overTheShoulder",
  ots: "overTheShoulder",
  过肩: "overTheShoulder",
  越肩: "overTheShoulder",
  pov: "pointOfView",
  "point of view": "pointOfView",
  "first person": "pointOfView",
  主观视角: "pointOfView",
  第一人称: "pointOfView",
});

/** The shot size this word means, if it means one. */
export function matchShotSize(word: string): StoryShotSize | undefined {
  return SHOT_SIZE_WORDS.get(normalize(word));
}

/** The camera move this word means, if it means one. */
export function matchCameraMove(word: string): StoryCameraMove | undefined {
  return CAMERA_MOVE_WORDS.get(normalize(word));
}

/** The angle this word means, if it means one. */
export function matchCameraAngle(word: string): StoryCameraAngle | undefined {
  return CAMERA_ANGLE_WORDS.get(normalize(word));
}
