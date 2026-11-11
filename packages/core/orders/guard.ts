import type { Tx } from "@tc/db";
import type { Result } from "../types";
import type { OrdersDeps } from "./draft";

/** The five-character SQLSTATE of an error or of its cause chain, if there is one. */
export function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null ? sqlState(cause) : undefined;
}

// A SQLSTATE is five characters of digits and capitals. Anything else is not logged as a code.
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** What every refused transaction of the orders code answers: no text, no id, no statement. */
export const INTERNAL: Result<never> = Object.freeze({ ok: false, error: "internal" });

export type Guarded<T> = { readonly done: true; readonly value: T } | { readonly done: false };

/**
 * Runs one transaction of the orders code. Anything it throws becomes `{ done: false }`, and the
 * caller answers `INTERNAL`. What leaves is never the error: its message can hold the statement and
 * its parameters (R14). The log gets a fixed event and the SQLSTATE, or null when the error carries
 * none. The transaction has rolled back before this returns.
 */
export async function runGuarded<T>(
  deps: Pick<OrdersDeps, "run" | "log">,
  fn: (tx: Tx) => Promise<T>,
): Promise<Guarded<T>> {
  try {
    return { done: true, value: await deps.run(fn) };
  } catch (error) {
    const state = sqlState(error);
    deps.log?.({
      event: "orders.db_error",
      sqlState: state !== undefined && SQLSTATE.test(state) ? state : null,
    });
    return { done: false };
  }
}
