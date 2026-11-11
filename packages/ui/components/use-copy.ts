import { useCallback, useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

/** How long "copied" stays before the status returns to idle. */
const COPIED_MS = 2000;

/**
 * Copies text to the clipboard. No clipboard, or a rejected write, is `failed`; `copied` returns to
 * `idle` after 2000 ms and the timer is cleared on unmount. Imported by Client Components only; this
 * file has no JSX and carries no directive.
 */
export function useCopy(): { status: CopyStatus; copy: (text: string) => Promise<void> } {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async (text: string): Promise<void> => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    let next: CopyStatus;
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clipboard === undefined) throw new Error("no clipboard");
      await clipboard.writeText(text);
      next = "copied";
    } catch {
      next = "failed";
    }
    if (!mounted.current) return;
    setStatus(next);
    if (next === "copied") {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setStatus("idle");
      }, COPIED_MS);
    }
  }, []);

  return { status, copy };
}
