// Aborts `controller` when the process is interrupted, terminated or hung up (used by pnpm verify).
// `on`, not `once`: pnpm forwards the signal as well, and a second SIGINT with no handler would kill
// the command before it writes its report. Returns a function that removes the handlers.
export const ABORT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function abortOnSignals(controller, proc = process) {
  const handler = () => controller.abort();
  for (const name of ABORT_SIGNALS) proc.on(name, handler);
  return () => {
    for (const name of ABORT_SIGNALS) proc.off(name, handler);
  };
}
