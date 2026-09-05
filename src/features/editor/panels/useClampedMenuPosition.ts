import { useLayoutEffect, useRef, useState } from "react";

/**
 * Anchors a fixed-position popup at (x, y) but shifts it into the viewport
 * when it would overflow, keeping an 8px margin from the window edges.
 */
export function useClampedMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);
  return { ref, pos };
}
