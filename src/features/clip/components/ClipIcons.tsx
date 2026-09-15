/**
 * The marks the cutting room speaks in.
 *
 * Drawn here rather than taken from a set, one per face of the left column and
 * one per thing the room itself is made of, so a rail of nine reads as nine
 * different drawers rather than nine copies of the same glyph. All of them are
 * the same hand: a 24 box, one and a half strokes, round ends.
 */

interface IconProps {
  size?: number;
}

/** A folder: the files on this machine. */
export function LocalIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M3.5 6.5h5.4l2 2.5h9.6v9.4a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6V6.5Z" />
    </svg>
  );
}

/** A crate: what the project itself holds. */
export function ProjectIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2V8.2Z" />
      <path d="M4 8.2 12 12.4l8-4.2M12 12.4V20" />
    </svg>
  );
}

/** A bolt: what a generation run made. */
export function RunsIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M13 3 5.5 13h5.4l-.9 8 7.5-10h-5.4l.9-8Z" />
    </svg>
  );
}

/** A framed picture: material that came off the boards. */
export function ClipCanvasIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <rect height="15" rx="2" width="17" x="3.5" y="4.5" />
      <circle cx="9.4" cy="10.4" r="1.8" />
      <path d="M6.5 16.6 10 13.2l3 2.6 2.6-2.1 1.9 1.9" />
    </svg>
  );
}

/** Books on a shelf: the library of pieces the app can lay in. */
export function LibraryIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.5 5.5h3v14h-3zM9.5 5.5h3v14h-3z" />
      <path d="m15.4 6.3 2.9-.8 3.5 13.2-2.9.8z" />
    </svg>
  );
}

/** A waveform: music, voice and effects. */
export function AudioIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 10.5v3M8 7v10M12 4.5v15M16 7v10M20 10.5v3" />
    </svg>
  );
}

/** A serif T: words laid over the cut. */
export function TextIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M5 6.5h14M12 6.5V18M9 18h6" />
    </svg>
  );
}

/** A funnel: the looks a clip can be poured through. */
export function FiltersIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 5.5h16l-6.2 7.4v5.6l-3.6 2v-7.6L4 5.5Z" />
    </svg>
  );
}

/** Sliders: speed, volume, opacity and the rest of the knobs. */
export function AdjustIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 8.5h8.6M17.4 8.5h2.6M4 15.5h2.6M11.4 15.5h8.6" />
      <circle cx="15" cy="8.5" r="2.2" />
      <circle cx="9" cy="15.5" r="2.2" />
    </svg>
  );
}

/** Three tracks under a playhead: the timeline itself. */
export function TimelineIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M3.5 7h17M3.5 12h17M3.5 17h17" />
      <path d="M12 4.5v15" />
    </svg>
  );
}

/** An arrow off a tray: the cut leaving as a file. */
export function ExportIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 3.6v10.8M8.4 7.2 12 3.6l3.6 3.6" />
      <path d="M4.5 13.5v5.4a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-5.4" />
    </svg>
  );
}

/** A star: the file kept to hand, filled in once it is. */
export function StarIcon({
  filled = false,
  size = 18,
}: IconProps & { filled?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="m12 4.4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 10l5.4-.8L12 4.4Z" />
    </svg>
  );
}

/** A pointer: what the inspector waits for. */
export function SelectIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M7 4l10 8.5-4.4.6 2.2 4.8-2 .9-2.2-4.8L7 17.4V4Z" />
    </svg>
  );
}

/** A glass with a minus: the timeline pulled further away. */
export function ZoomOutIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4.4 4.4" />
      <path d="M8.4 11h5.2" />
    </svg>
  );
}

/** The same glass with a plus. */
export function ZoomInIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4.4 4.4" />
      <path d="M8.4 11h5.2M11 8.4v5.2" />
    </svg>
  );
}

/** Arrows into the corners: the whole cut on screen. */
export function FitIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
    </svg>
  );
}

/** Scissors: the cut made where the playhead stands. */
export function ScissorsIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <circle cx="6.4" cy="7" r="2.5" />
      <circle cx="6.4" cy="17" r="2.5" />
      <path d="m8.5 8.4 11 6.1M8.5 15.6l11-6.1" />
    </svg>
  );
}

/** Two sheets: the chosen clip laid down again behind its own tail. */
export function DuplicateIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <rect height="11.5" rx="1.8" width="11.5" x="8.5" y="4.5" />
      <path d="M15.5 19.5h-11v-11" />
    </svg>
  );
}

/** A bin: the chosen clips taken off the cut. */
export function TrashIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.6c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3V7" />
      <path d="m6.7 7 .8 11.7c0 .7.7 1.3 1.4 1.3h6.2c.7 0 1.4-.6 1.4-1.3L17.3 7" />
      <path d="M10.3 10.6v5.6M13.7 10.6v5.6" />
    </svg>
  );
}

/** An arrow curving back: the last step taken off the history. */
export function UndoIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M5 9h9.5a5 5 0 0 1 0 10H9" />
      <path d="M8.5 5.5 5 9l3.5 3.5" />
    </svg>
  );
}

/** The same arrow, put back on: the step undone. */
export function RedoIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M19 9H9.5a5 5 0 0 0 0 10H15" />
      <path d="M15.5 5.5 19 9l-3.5 3.5" />
    </svg>
  );
}

/** A padlock: the row that will not be moved. */
export function LockIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <rect height="8.5" rx="2" width="12" y="10.5" x="6" />
      <path d="M8.8 10.5V8a3.2 3.2 0 0 1 6.4 0v2.5" />
    </svg>
  );
}

/** An eye struck through: the row that keeps its sound but not its picture. */
export function EyeOffIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="m4 4.8 16 14.4" />
      <path d="M9.7 5.7A9.4 9.4 0 0 1 12 5.4c5 0 8.5 4.2 8.5 6.6a7.9 7.9 0 0 1-2.6 4" />
      <path d="M6.2 7.5A9.7 9.7 0 0 0 3.5 12c0 2.4 3.5 6.6 8.5 6.6a9.3 9.3 0 0 0 4-.9" />
      <path d="M10.2 10.2a2.5 2.5 0 0 0 3.5 3.5" />
    </svg>
  );
}

/** The open eye: the row that draws its picture and its sound again. */
export function EyeIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 5.4c5 0 8.5 4.2 8.5 6.6 0 2.4-3.5 6.6-8.5 6.6S3.5 14.4 3.5 12c0-2.4 3.5-6.6 8.5-6.6Z" />
      <circle cx="12" cy="12" r="2.7" />
    </svg>
  );
}

/** A padlock with its shackle open: the row that may be written on again. */
export function UnlockIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <rect height="8.5" rx="2" width="12" x="6" y="10.5" />
      <path d="M8.8 10.5V8a3.2 3.2 0 0 1 6.2-.6" />
    </svg>
  );
}

/** A plus: the corner that grows the cut another row. */
export function PlusIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 5.5v13M5.5 12h13" />
    </svg>
  );
}

/** A horseshoe magnet: the edges that catch on each other. */
export function MagnetIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M6.4 19.5v-6.8a5.6 5.6 0 0 1 11.2 0v6.8" />
      <path d="M9.8 19.5v-6.6a2.2 2.2 0 0 1 4.4 0v6.6" />
    </svg>
  );
}

/** A speaker crossed out: the row that keeps its picture but not its sound. */
export function MutedIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.5 9.5h3l4-3.2v11.4l-4-3.2h-3z" />
      <path d="m15.5 9.5 4 4M19.5 9.5l-4 4" />
    </svg>
  );
}

/** A bar and a triangle: back to the head of the cut. */
export function SkipStartIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M5.5 5.6v12.8" />
      <path d="M18.5 5.6v12.8L8.2 12l10.3-6.4Z" />
    </svg>
  );
}

/** The same triangle the other way: to the tail of the cut. */
export function SkipEndIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M18.5 5.6v12.8" />
      <path d="M5.5 5.6v12.8L15.8 12 5.5 5.6Z" />
    </svg>
  );
}

/** A triangle leaning forward: run the cut. */
export function PlayIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M8.5 5.6v12.8L18.8 12 8.5 5.6Z" />
    </svg>
  );
}

/** Two bars: hold the cut where it stands. */
export function PauseIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.9"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M9.6 5.6v12.8M14.4 5.6v12.8" />
    </svg>
  );
}

/** Two arrows chasing each other: the cut comes round again at its tail. */
export function LoopIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M7.4 9.4A4.6 4.6 0 0 1 11.6 7h5" />
      <path d="m14.4 4.8 2.4 2.2-2.4 2.2" />
      <path d="M16.6 14.6A4.6 4.6 0 0 1 12.4 17h-5" />
      <path d="m9.6 19.2-2.4-2.2 2.4-2.2" />
    </svg>
  );
}

/** A speaker with sound coming off it: the cut's master level. */
export function VolumeIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.5 9.5h3l4-3.2v11.4l-4-3.2h-3z" />
      <path d="M14.6 9.8a3.4 3.4 0 0 1 0 4.4" />
      <path d="M17.1 7.4a6.6 6.6 0 0 1 0 9.2" />
    </svg>
  );
}

/** A camera: the frame under the playhead, saved as a picture. */
export function SnapshotIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 9.1c0-.9.7-1.6 1.6-1.6h1.9l1.4-2.3h6.2l1.4 2.3h1.9c.9 0 1.6.7 1.6 1.6v7.3c0 .9-.7 1.6-1.6 1.6H5.6c-.9 0-1.6-.7-1.6-1.6V9.1Z" />
      <circle cx="12" cy="12.6" r="3.1" />
    </svg>
  );
}

/** Corners opening out: the preview given the whole window. */
export function FullscreenIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.5 9V6.1c0-.9.7-1.6 1.6-1.6H9" />
      <path d="M15 4.5h2.9c.9 0 1.6.7 1.6 1.6V9" />
      <path d="M19.5 15v2.9c0 .9-.7 1.6-1.6 1.6H15" />
      <path d="M9 19.5H6.1c-.9 0-1.6-.7-1.6-1.6V15" />
    </svg>
  );
}

/** The same corners turned inward: back to the pane. */
export function ExitFullscreenIcon({ size = 18 }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M9.5 4.5V9H5" />
      <path d="M19.5 9.5H15V5" />
      <path d="M14.5 19.5V15h4.5" />
      <path d="M4.5 14.5H9v4.5" />
    </svg>
  );
}
