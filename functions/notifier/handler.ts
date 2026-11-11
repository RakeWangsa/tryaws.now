import type { Logger } from "@tc/core";
import { runNotifier, type NotifierDeps, type NotifierReport } from "@tc/notify";

// notifier (3.2): every minute, reads the pending `notifications` rows and sends them through SES or
// the SMS gateway. The scheduler's event is never read. A throw is logged as a fixed reason and
// re-thrown with a fixed message, so the invocation fails visibly and nothing about the cause leaks
// (R3, R14, R16).
export interface NotifierHandlerDeps extends Omit<NotifierDeps, "shouldStop"> {
  readonly log: Logger;
  // Milliseconds left in the invocation (context.getRemainingTimeInMillis in Lambda).
  readonly remainingMs?: () => number;
}

// Stop taking new rows this long before the deadline: a send in flight needs its time limit.
export const STOP_MARGIN_MS = 15_000;

export function createNotifierHandler(
  deps: NotifierHandlerDeps,
): (event?: unknown) => Promise<NotifierReport> {
  const { remainingMs, ...rest } = deps;
  return async (): Promise<NotifierReport> => {
    try {
      return await runNotifier({
        ...rest,
        shouldStop: remainingMs === undefined ? undefined : () => remainingMs() < STOP_MARGIN_MS,
      });
    } catch {
      deps.log({ event: "notifier_run_failed", reason: "run_threw" });
      throw new Error("notifier: run failed");
    }
  };
}
