/**
 * The marks the toolstrip speaks in.
 *
 * Drawn here rather than taken from a set, one per control, so each says what
 * its control does at the size the strip has room for: an arrowhead for
 * choosing, an open hand for moving the paper, corners pulling in for fitting
 * the view, and a dashed frame under a glass for fitting what is chosen.
 */

interface IconProps {
  size?: number;
}

/** An arrowhead: the tool that points at things. */
export function ArrowIcon({ size = 15 }: IconProps) {
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
      <path d="M5 3.5 18.5 12 12 13.4 9.8 19.8 5 3.5Z" />
    </svg>
  );
}

/** An open hand: the tool that moves the paper under the pen. */
export function HandIcon({ size = 15 }: IconProps) {
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
      <path d="M9 11V5.6a1.3 1.3 0 0 1 2.6 0V11" />
      <path d="M11.6 10.4V4.9a1.3 1.3 0 0 1 2.6 0v5.5" />
      <path d="M14.2 10.8V6.6a1.3 1.3 0 0 1 2.6 0v7.6c0 3.6-2.3 6.4-6 6.4-2.4 0-3.8-.9-5.2-3L3.4 14c-.5-.8-.2-1.8.6-2.2.7-.4 1.6-.2 2.1.5L9 15.4V11" />
    </svg>
  );
}

/** Corners pulling in: fit everything the board holds into the view. */
export function FitIcon({ size = 15 }: IconProps) {
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
      <path d="M4 8.5V4.5h4M15.5 4.5h4v4M19.5 15.5v4h-4M8.5 19.5h-4v-4" />
      <rect height="6" rx="1" width="6" x="9" y="9" />
    </svg>
  );
}

/** A dashed frame under a glass: fit what is chosen into the view. */
export function SelectionIcon({ size = 15 }: IconProps) {
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
      <path
        d="M4 8V4.5h3.5M16.5 4.5H20V8M20 12.5v1M8 19.5H4.5V16"
        strokeDasharray="3 2.6"
      />
      <circle cx="13.5" cy="13.5" r="4.6" />
      <path d="m17 17 3.2 3.2" />
    </svg>
  );
}
