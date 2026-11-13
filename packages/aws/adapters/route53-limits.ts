import type { R53Change } from "./route53-port";

// WPU-Z19: the limits of one ChangeResourceRecordSets batch, from the Route 53 quotas page
// (https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html, read 2026-11-14):
//   "A request cannot contain more than 1,000 ResourceRecord elements (including alias records). When the value of
//   the Action element is UPSERT, each ResourceRecord element is counted twice."
//   "The sum of the number of characters (including spaces) in all Value elements in a request cannot exceed 32,000
//   characters. When the value of the Action element is UPSERT, each character in a Value element is counted twice."
// MAX_BATCH_CHANGES is the platform's own extra cap on the number of changes, not an AWS limit.

export const MAX_BATCH_ELEMENTS = 1_000;
export const MAX_BATCH_VALUE_CHARS = 32_000;
export const MAX_BATCH_CHANGES = 500;

/** What one change counts against the batch limits: an UPSERT counts its elements and characters twice. */
export function changeCost(change: R53Change): { elements: number; chars: number } {
  const weight = change.action === "UPSERT" ? 2 : 1;
  let chars = 0;
  for (const value of change.set.values) chars += value.length;
  return { elements: weight * change.set.values.length, chars: weight * chars };
}

/** True when the changes fit in one ChangeResourceRecordSets request. */
export function withinBatchLimits(changes: readonly R53Change[]): boolean {
  if (changes.length > MAX_BATCH_CHANGES) return false;
  let elements = 0;
  let chars = 0;
  for (const change of changes) {
    const cost = changeCost(change);
    elements += cost.elements;
    chars += cost.chars;
  }
  return elements <= MAX_BATCH_ELEMENTS && chars <= MAX_BATCH_VALUE_CHARS;
}

/**
 * Splits independent changes (the DELETEs of a zone destroy) into batches that each fit the limits, in order. A
 * change that is over the limits on its own stays a batch of its own, which the client refuses (R16). Only for
 * changes that do not need to be atomic together: a record edit stays one batch.
 */
export function splitChangeBatches(changes: readonly R53Change[]): R53Change[][] {
  const batches: R53Change[][] = [];
  let current: R53Change[] = [];
  for (const change of changes) {
    if (current.length > 0 && !withinBatchLimits([...current, change])) {
      batches.push(current);
      current = [];
    }
    current.push(change);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
