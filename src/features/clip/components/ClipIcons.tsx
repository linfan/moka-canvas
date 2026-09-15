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
