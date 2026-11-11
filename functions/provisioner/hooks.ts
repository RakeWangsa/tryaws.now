import type { OperationHooks } from "./types";

// Runs the hooks one after the other, in the order given, inside the same transaction. The first
// that throws stops the rest, and the error reaches the caller, which rolls everything back. A slot
// exists in the result only when at least one given hook has it.
export function composeHooks(...hooks: readonly OperationHooks[]): OperationHooks {
  const succeeded = hooks.filter((h) => h.succeeded !== undefined);
  const failed = hooks.filter((h) => h.failed !== undefined);
  const attention = hooks.filter((h) => h.needsAttention !== undefined);
  const composed: OperationHooks = {
    ...(succeeded.length > 0 && {
      succeeded: async (tx, event) => {
        for (const hook of succeeded) await hook.succeeded?.(tx, event);
      },
    }),
    ...(failed.length > 0 && {
      failed: async (tx, event) => {
        for (const hook of failed) await hook.failed?.(tx, event);
      },
    }),
    ...(attention.length > 0 && {
      needsAttention: async (tx, event) => {
        for (const hook of attention) await hook.needsAttention?.(tx, event);
      },
    }),
  };
  return composed;
}
