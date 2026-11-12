import type { Result } from "../types";

/**
 * Spec 12: "No refunds on registrations. Require a second confirmation that repeats the exact domain
 * name." The customer types the name again before the order is placed. The comparison is exact (after
 * trimming the ends): another case, another dot or another name is a mismatch. The typed text is never
 * echoed (R14).
 */
export function checkSecondConfirmation(name: string, typed: unknown): Result<true> {
  if (name.length === 0 || typeof typed !== "string" || typed.trim() !== name) {
    return { ok: false, error: "validation", fields: { confirmName: "mismatch" } };
  }
  return { ok: true, value: true };
}
