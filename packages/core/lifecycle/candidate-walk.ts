// WPU-Z12. The pure rules of the lifecycle pass's walk over its candidate list (engine.ts, runLifecycle). The list is
// read page after page with a keyset cursor over (period_end, id) until a page is short, so the held subscriptions at
// its head never hide the rows behind them. Keys in, a decision out; the engine reads the pages and processes the rows.
import { isCandidateKey, type CandidateKey } from "@tc/db";

/** A page that does not move strictly past its cursor: the list is unsound, so the walk stops there (R16). */
export class CandidateCursorError extends Error {
  constructor() {
    // Fixed words only (R14): no id and no date.
    super("lifecycle: the candidate list did not move past its cursor");
    this.name = "CandidateCursorError";
  }
}

/** -1, 0 or 1: the order of the list (period end, then id). Keys in the form of the list compare as text. */
export function compareCandidateKeys(a: CandidateKey, b: CandidateKey): number {
  if (a.periodEnd !== b.periodEnd) return a.periodEnd < b.periodEnd ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * The cursor of the page after `page`, or null when the walk is over: a page shorter than `pageSize` (an empty one
 * too) is the last. Every key of the page must be in the exact form of the list and strictly after the cursor and the
 * key before it, so the cursor only moves forward: no row is read twice or skipped by the cursor, and the walk ends.
 * A page that breaks this throws CandidateCursorError, short or not (R16).
 */
export function nextCandidateCursor(
  after: CandidateKey | null,
  page: readonly CandidateKey[],
  pageSize: number,
): CandidateKey | null {
  let last = after;
  for (const key of page) {
    if (!isCandidateKey(key) || (last !== null && compareCandidateKeys(last, key) >= 0)) {
      throw new CandidateCursorError();
    }
    last = key;
  }
  return page.length < pageSize ? null : last;
}

export interface CandidateWalk {
  /** The rows of a full page: a page with fewer is the last. */
  readonly pageSize: number;
  /** At most `pageSize` keys of the list strictly after `after` (null: from the head), in the order of the list. */
  readonly readPage: (after: CandidateKey | null) => Promise<readonly CandidateKey[]>;
  /** One candidate. It handles the failure of its own row; an error that escapes it stops the walk. */
  readonly visit: (id: string) => Promise<void>;
}

/**
 * Visits every candidate of the list once, one at a time, in the order of the list, and returns how many it visited.
 * A row whose period end moved forward during the walk (a renewal) can come back on a later page under its new key; it
 * is not visited twice. The rows of a page are visited before the page is checked, so a list that turns out unsound
 * stops the walk after them; a page that cannot be read stops it with its own error. No cursor outlives a walk: the
 * next one starts at the head again.
 */
export async function walkCandidates(walk: CandidateWalk): Promise<number> {
  const seen = new Set<string>();
  let after: CandidateKey | null = null;
  for (;;) {
    const page = await walk.readPage(after);
    for (const { id } of page) {
      if (seen.has(id)) continue;
      seen.add(id);
      await walk.visit(id);
    }
    after = nextCandidateCursor(after, page, walk.pageSize);
    if (after === null) return seen.size;
  }
}
