import type { CandidateKey } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  CandidateCursorError,
  compareCandidateKeys,
  nextCandidateCursor,
  walkCandidates,
} from "./candidate-walk";

// WPU-Z12. The pure rules of the lifecycle pass's walk over its candidates, no database: the list is read page after
// page with a keyset cursor over (period_end, id) until a page is short, and every row is visited once.

const END = "2026-11-10T06:00:00.000000Z";
const LATER = "2026-12-10T06:00:00.000000Z";
// Ids in increasing order: the number is the last group of the id, in hex, so text order is number order.
const id = (n: number): string => `0190aaaa-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const key = (n: number, periodEnd = END): CandidateKey => ({ id: id(n), periodEnd });
const keys = (from: number, to: number, periodEnd = END): CandidateKey[] =>
  Array.from({ length: to - from + 1 }, (_, i) => key(from + i, periodEnd));

// The candidate list as the database answers it: `sorted` is already in (period_end, id) order, written by hand, and
// a page is the rows after the position of the cursor, so the fake does not depend on compareCandidateKeys.
function listOf(sorted: readonly CandidateKey[], pageSize: number) {
  const reads: (CandidateKey | null)[] = [];
  const readPage = async (after: CandidateKey | null): Promise<CandidateKey[]> => {
    reads.push(after);
    const from =
      after === null
        ? 0
        : sorted.findIndex((k) => k.id === after.id && k.periodEnd === after.periodEnd) + 1;
    if (from === 0 && after !== null) throw new Error("fake: the cursor is not a row of the list");
    return sorted.slice(from, from + pageSize);
  };
  return { reads, readPage };
}

// Pages answered in order, whatever the cursor: for the cases where the list changes during the walk.
function scripted(pages: readonly (readonly CandidateKey[])[]) {
  const reads: (CandidateKey | null)[] = [];
  const readPage = async (after: CandidateKey | null): Promise<readonly CandidateKey[]> => {
    reads.push(after);
    const page = pages[reads.length - 1];
    if (page === undefined) throw new Error("fake: no page left");
    return page;
  };
  return { reads, readPage };
}

function recorder() {
  const visited: string[] = [];
  return { visited, visit: async (rowId: string) => void visited.push(rowId) };
}

// No deadline: the time of the walk is never up.
const never = (): boolean => false;

// A deadline that is past once `n` rows were visited. `asked` holds, for each question, how many rows were visited
// when it was asked.
function deadlineAfter(rows: { readonly visited: readonly string[] }, n: number) {
  const asked: number[] = [];
  const pastDeadline = (): boolean => {
    asked.push(rows.visited.length);
    return rows.visited.length >= n;
  };
  return { asked, pastDeadline };
}

describe("the order of the candidate list (compareCandidateKeys)", () => {
  it("an earlier period end comes first, whatever the ids", () => {
    expect(compareCandidateKeys(key(9, END), key(1, LATER))).toBe(-1);
    expect(compareCandidateKeys(key(1, LATER), key(9, END))).toBe(1);
  });

  it("the same period end is ordered by the id, as PostgreSQL orders uuids (byte order of the lower-case hex)", () => {
    expect(compareCandidateKeys(key(1), key(2))).toBe(-1);
    expect(compareCandidateKeys(key(2), key(1))).toBe(1);
    // a digit sorts before a letter: 0x9 < 0xa in bytes, "9" < "a" in text
    expect(compareCandidateKeys(key(0x9), key(0xa))).toBe(-1);
    expect(compareCandidateKeys(key(7), key(7))).toBe(0);
  });

  it("a microsecond counts: two period ends that a JavaScript Date would see as equal are not", () => {
    const a = key(9, "2026-11-10T06:00:00.123000Z");
    const b = key(1, "2026-11-10T06:00:00.123001Z");
    expect(compareCandidateKeys(a, b)).toBe(-1);
    expect(new Date("2026-11-10T06:00:00.123000Z").getTime()).toBe(
      new Date("2026-11-10T06:00:00.123001Z").getTime(),
    );
  });
});

describe("the cursor of the next page (nextCandidateCursor)", () => {
  it("is the key of the last row of a full page", () => {
    expect(nextCandidateCursor(null, keys(1, 3), 3)).toEqual(key(3));
    expect(nextCandidateCursor(key(3), keys(4, 6), 3)).toEqual(key(6));
  });

  it("is null after a short page, an empty one included: the walk is over", () => {
    expect(nextCandidateCursor(null, keys(1, 2), 3)).toBeNull();
    expect(nextCandidateCursor(key(6), [], 3)).toBeNull();
    expect(nextCandidateCursor(null, [], 3)).toBeNull();
  });

  it("an empty page ends the walk whatever the page size: a cursor that is not null always moved forward", () => {
    for (const pageSize of [0, -1, Number.NaN]) {
      expect(nextCandidateCursor(key(6), [], pageSize)).toBeNull();
    }
  });

  it("ties on the period end are broken by the id, so a page may end inside a tie", () => {
    expect(nextCandidateCursor(key(2), [key(3), key(4), key(1, LATER)], 3)).toEqual(key(1, LATER));
  });

  it("refuses a page that does not move strictly past the cursor (R16): no row is read twice or skipped", () => {
    const refusals: [CandidateKey | null, CandidateKey[]][] = [
      [key(3), [key(3), key(4)]], // the cursor row again
      [key(3), [key(2), key(4)]], // a row before the cursor
      [null, [key(2), key(2)]], // the same row twice
      [null, [key(2), key(1)]], // out of order
      [null, [key(1, LATER), key(2, END)]], // out of order on the period end
    ];
    for (const [after, page] of refusals) {
      expect(() => nextCandidateCursor(after, page, 2)).toThrow(CandidateCursorError);
      // a short page is checked too: the list is unsound whether or not the walk goes on
      expect(() => nextCandidateCursor(after, page, 3)).toThrow(CandidateCursorError);
    }
  });

  it("refuses a key that is not in the exact form of the list, which could not be compared (R16)", () => {
    const bad: CandidateKey[] = [
      { id: id(2), periodEnd: "2026-11-10T06:00:00.123Z" }, // milliseconds only
      { id: id(2), periodEnd: "2026-11-10T12:00:00.000000+06" }, // not UTC
      { id: id(2), periodEnd: "" }, // an infinite period end has no text
      { id: id(2).toUpperCase(), periodEnd: END }, // text order of upper case is not the uuid order
      { id: "not-a-uuid", periodEnd: END },
    ];
    for (const k of bad) {
      expect(() => nextCandidateCursor(key(1), [k], 1)).toThrow(CandidateCursorError);
    }
    const error = new CandidateCursorError();
    expect(error.name).toBe("CandidateCursorError");
    // fixed words only (R14): the message names no id and no date
    expect(error.message).toBe("lifecycle: the candidate list did not move past its cursor");
  });
});

describe("the walk over every candidate (walkCandidates)", () => {
  it("reads page after page until a page is short, each from the last key of the page before", async () => {
    const list = listOf(keys(1, 7), 3);
    const rows = recorder();
    const walked = await walkCandidates({
      pageSize: 3,
      readPage: list.readPage,
      visit: rows.visit,
      pastDeadline: never,
    });
    expect(walked).toEqual({ visited: 7, complete: true });
    expect(rows.visited).toEqual(keys(1, 7).map((k) => k.id));
    expect(list.reads).toEqual([null, key(3), key(6)]);
  });

  it("a list that is an exact multiple of the page size ends with one empty page", async () => {
    const list = listOf(keys(1, 6), 3);
    const rows = recorder();
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: never,
      }),
    ).toEqual({ visited: 6, complete: true });
    expect(list.reads).toEqual([null, key(3), key(6)]);
  });

  it("an empty list reads one page and visits nothing", async () => {
    const list = listOf([], 500);
    const rows = recorder();
    expect(
      await walkCandidates({
        pageSize: 500,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: never,
      }),
    ).toEqual({ visited: 0, complete: true });
    expect(list.reads).toEqual([null]);
    expect(rows.visited).toEqual([]);
  });

  it("more held rows than one page at the head no longer hide the row behind them (the WPU-Z1 review finding)", async () => {
    // 501 held subscriptions keep their old period end (all the same one); a renewable one ends later.
    const held = keys(1, 501, END);
    const renewable = key(1000, LATER); // a subscription of its own: an id that no held row has
    const list = listOf([...held, renewable], 500);
    const rows = recorder();
    const walked = await walkCandidates({
      pageSize: 500,
      readPage: list.readPage,
      visit: rows.visit,
      pastDeadline: never,
    });
    expect(walked).toEqual({ visited: 502, complete: true });
    expect(rows.visited.at(-1)).toBe(renewable.id);
    expect(new Set(rows.visited).size).toBe(502);
    // the second page starts inside the tie of the held rows, after the 500th id
    expect(list.reads).toEqual([null, key(500, END)]);
  });

  it("a row that comes back in the same walk under a new key (its period end moved forward) is visited once", async () => {
    // b is renewed while the first page is processed: its period end moves forward and the list returns it again.
    const [a, b, c, d] = keys(1, 4);
    const movedB: CandidateKey = { id: b!.id, periodEnd: LATER };
    const walk = scripted([
      [a!, b!, c!],
      [d!, movedB],
    ]);
    const rows = recorder();
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: walk.readPage,
        visit: rows.visit,
        pastDeadline: never,
      }),
    ).toEqual({ visited: 4, complete: true });
    expect(rows.visited).toEqual([a!.id, b!.id, c!.id, d!.id]);
    expect(walk.reads).toEqual([null, c]);
  });

  it("a page that does not move past its cursor stops the walk (R16) once its rows were visited", async () => {
    const walk = scripted([
      [key(1), key(2)],
      [key(2), key(3)], // the cursor row again: the list is unsound
      [key(4)],
    ]);
    const rows = recorder();
    await expect(
      walkCandidates({
        pageSize: 2,
        readPage: walk.readPage,
        visit: rows.visit,
        pastDeadline: never,
      }),
    ).rejects.toThrow(CandidateCursorError);
    // key 2 was visited on the first page and is not visited again; nothing after the refused page is read
    expect(rows.visited).toEqual([id(1), id(2), id(3)]);
    expect(walk.reads).toEqual([null, key(2)]);
  });

  it("a page that cannot be read stops the walk with its own error; what was visited stays visited", async () => {
    const failure = new Error("connection lost");
    let reads = 0;
    const readPage = async (): Promise<CandidateKey[]> => {
      reads += 1;
      if (reads === 2) throw failure;
      return keys(1, 2);
    };
    const rows = recorder();
    await expect(
      walkCandidates({ pageSize: 2, readPage, visit: rows.visit, pastDeadline: never }),
    ).rejects.toBe(failure);
    expect(rows.visited).toEqual([id(1), id(2)]);
  });

  it("visits one row at a time, in the order of the list", async () => {
    const list = listOf(keys(1, 5), 2);
    let inFlight = 0;
    let most = 0;
    const order: string[] = [];
    const visit = async (rowId: string) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      order.push(rowId);
      inFlight -= 1;
    };
    await walkCandidates({ pageSize: 2, readPage: list.readPage, visit, pastDeadline: never });
    expect(most).toBe(1);
    expect(order).toEqual(keys(1, 5).map((k) => k.id));
  });
});

// WPU-Z12 review: the walk has an upper bound. Before, a pass read at most 500 rows; walking every candidate with no
// deadline could take longer than the scheduler's run (55 s) and starve the jobs after it (metering, static IPs,
// unpaid, invoices). The deadline is asked between rows, never during one.
describe("the deadline of the walk (pastDeadline)", () => {
  it("is asked before each row; once it is past the walk stops before the next row and reads no page after", async () => {
    const list = listOf(keys(1, 7), 3);
    const rows = recorder();
    const deadline = deadlineAfter(rows, 4);
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: deadline.pastDeadline,
      }),
    ).toEqual({ visited: 4, complete: false });
    expect(rows.visited).toEqual(keys(1, 4).map((k) => k.id));
    // once before each row; the fifth answer is the first "past"
    expect(deadline.asked).toEqual([0, 1, 2, 3, 4]);
    // the page of rows 4 to 6 was read for row 4; rows 5 to 7 are left to the next walk
    expect(list.reads).toEqual([null, key(3)]);
  });

  it("a row that was started is finished: the deadline is never asked during a visit", async () => {
    const list = listOf(keys(1, 5), 5);
    let late = false;
    const started: string[] = [];
    const finished: string[] = [];
    const visit = async (rowId: string) => {
      started.push(rowId);
      if (rowId === id(2)) late = true; // the time runs out while row 2 is processed
      await Promise.resolve();
      finished.push(rowId);
    };
    expect(
      await walkCandidates({
        pageSize: 5,
        readPage: list.readPage,
        visit,
        pastDeadline: () => late,
      }),
    ).toEqual({ visited: 2, complete: false });
    expect(started).toEqual([id(1), id(2)]);
    expect(finished).toEqual([id(1), id(2)]);
  });

  it("a deadline that passes when no row is left is no cut: after a short last page, or before an empty one", async () => {
    // the list ends on a short page
    let list = listOf(keys(1, 2), 3);
    let rows = recorder();
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: deadlineAfter(rows, 2).pastDeadline,
      }),
    ).toEqual({ visited: 2, complete: true });

    // the list ends on a full page: the next page is read, it is empty, so no row was left
    list = listOf(keys(1, 3), 3);
    rows = recorder();
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: deadlineAfter(rows, 3).pastDeadline,
      }),
    ).toEqual({ visited: 3, complete: true });
    expect(list.reads).toEqual([null, key(3)]);

    // one row more: the walk is cut before it
    list = listOf(keys(1, 4), 3);
    rows = recorder();
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: deadlineAfter(rows, 3).pastDeadline,
      }),
    ).toEqual({ visited: 3, complete: false });
    expect(rows.visited).not.toContain(id(4));
  });

  it("a row visited before that comes back after the deadline is not a row left, and the deadline is not asked for it", async () => {
    const [a, b, c] = keys(1, 3);
    const movedB: CandidateKey = { id: b!.id, periodEnd: LATER };
    const walk = scripted([[a!, b!, c!], [movedB]]);
    const rows = recorder();
    const deadline = deadlineAfter(rows, 3);
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: walk.readPage,
        visit: rows.visit,
        pastDeadline: deadline.pastDeadline,
      }),
    ).toEqual({ visited: 3, complete: true });
    expect(deadline.asked).toEqual([0, 1, 2]);
  });

  it("a deadline that is past from the start visits nothing; an empty list is still complete", async () => {
    const list = listOf(keys(1, 3), 3);
    const rows = recorder();
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: () => true,
      }),
    ).toEqual({ visited: 0, complete: false });
    expect(rows.visited).toEqual([]);
    expect(list.reads).toEqual([null]);

    const empty = listOf([], 3);
    expect(
      await walkCandidates({
        pageSize: 3,
        readPage: empty.readPage,
        visit: rows.visit,
        pastDeadline: () => true,
      }),
    ).toEqual({ visited: 0, complete: true });
  });

  it("the review's case: more held rows than the time allows stop the walk at its deadline; the next walk starts at the head again", async () => {
    const held = keys(1, 501, END);
    const renewable = key(1000, LATER);
    const list = listOf([...held, renewable], 500);
    const first = recorder();
    expect(
      await walkCandidates({
        pageSize: 500,
        readPage: list.readPage,
        visit: first.visit,
        pastDeadline: deadlineAfter(first, 300).pastDeadline,
      }),
    ).toEqual({ visited: 300, complete: false });
    expect(first.visited).not.toContain(renewable.id);
    expect(list.reads).toEqual([null]);

    // No cursor outlives a walk: the next one reads from the head again (R7: a row visited again is a replay).
    const second = recorder();
    expect(
      await walkCandidates({
        pageSize: 500,
        readPage: list.readPage,
        visit: second.visit,
        pastDeadline: never,
      }),
    ).toEqual({ visited: 502, complete: true });
    expect(list.reads).toEqual([null, null, key(500, END)]);
  });

  it("a deadline that cannot answer stops the walk with its own error (R16)", async () => {
    const list = listOf(keys(1, 3), 3);
    const rows = recorder();
    const broken = new Error("no clock");
    await expect(
      walkCandidates({
        pageSize: 3,
        readPage: list.readPage,
        visit: rows.visit,
        pastDeadline: () => {
          throw broken;
        },
      }),
    ).rejects.toBe(broken);
    expect(rows.visited).toEqual([]);
  });
});
