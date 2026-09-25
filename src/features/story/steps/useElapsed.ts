import { useEffect, useState } from "react";

/** How long a batch has been out, ticking once a second while it is. */
export function useElapsed(since: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === undefined) return 0;
  return Math.max(0, now - Date.parse(since));
}
