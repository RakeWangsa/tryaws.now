import { createHash } from "node:crypto";

// R7 for the reconciler: one run per day. A finding row gets an id made from the day, the kind and the
// subject, so a second run of the same day meets the primary key and writes nothing new.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DHAKA_OFFSET_MS = 6 * 3_600_000;

/** `YYYY-MM-DD` of the clock in Dhaka (UTC+6, no daylight saving), as metering does. */
export function dayKeyOf(now: Date): string {
  return new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

/** A version 5 style UUID over `reconcile:<day>:<kind>:<subject>`. */
export function findingId(dayKey: string, kind: string, subject: string): string {
  if (!DAY.test(dayKey)) throw new TypeError("reconcile: the day key is YYYY-MM-DD");
  const h = createHash("sha1").update(`reconcile:${dayKey}:${kind}:${subject}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
