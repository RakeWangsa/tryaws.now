import type { Clock } from "../types";

// A clock that only moves when a test says so. now() returns a new Date each time.
export function createManualClock(
  start: Date,
): Clock & { advance(seconds: number): void; set(at: Date): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(seconds: number) {
      current += seconds * 1000;
    },
    set(at: Date) {
      current = at.getTime();
    },
  };
}
