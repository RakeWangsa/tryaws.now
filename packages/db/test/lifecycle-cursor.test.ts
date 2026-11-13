import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { isCandidateKey, lifecycleRepo, type CandidateKey } from "../repositories/system/lifecycle";

// WPU-Z12. The candidate list of the lifecycle pass without a database: which cursor a page accepts, the statement it
// sends and the keys it returns. The same list on PostgreSQL: lifecycle-candidates.db.test.ts.

const NOW = new Date("2026-11-13T06:00:00.000Z");
const HORIZON = "2026-11-20T06:00:00.000Z"; // NOW + 7 reminder days
const ID = "0190aaaa-0000-7000-8000-000000000001";
const KEY: CandidateKey = { id: ID, periodEnd: "2026-11-10T06:00:00.123456Z" };

// A transaction that records each statement as text (white space folded) and parameters, and answers with `rows`.
function recording(rows: Record<string, unknown>[] = []) {
  const dialect = new PgDialect();
  const sent: { text: string; params: unknown[] }[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      sent.push({ text: sql.replace(/\s+/g, " ").trim(), params });
      return { rows };
    },
  } as unknown as Tx;
  return { tx, sent };
}

// A transaction that must not be used: every access is recorded and throws.
function untouchable() {
  const used: string[] = [];
  const tx = new Proxy(
    {},
    {
      get: (_target, property) => {
        used.push(String(property));
        throw new Error("the stub transaction was used");
      },
    },
  ) as unknown as Tx;
  return { tx, used };
}

describe("isCandidateKey: the exact form of a key of the list, the only form that is a cursor", () => {
  it("accepts a lower-case uuid and the period end in UTC to the microsecond", () => {
    expect(isCandidateKey(KEY)).toBe(true);
    expect(isCandidateKey({ id: ID, periodEnd: "2026-11-10T06:00:00.000000Z" })).toBe(true);
  });

  it("refuses every other form (R16): it could be read in another order than PostgreSQL's", () => {
    const refused: unknown[] = [
      { id: ID, periodEnd: "2026-11-10T06:00:00.123Z" }, // a JavaScript Date's milliseconds
      { id: ID, periodEnd: "2026-11-10T06:00:00Z" },
      { id: ID, periodEnd: "2026-11-10 06:00:00.123456+00" }, // the server's own text form
      { id: ID, periodEnd: "2026-11-10T12:00:00.123456+06:00" },
      { id: ID, periodEnd: "12026-11-10T06:00:00.123456Z" }, // a fifth year digit breaks text order
      { id: ID, periodEnd: "" }, // an infinite period end has no text
      { id: ID.toUpperCase(), periodEnd: KEY.periodEnd },
      { id: "0190aaaa00007000800000000000001", periodEnd: KEY.periodEnd },
      { id: ID, periodEnd: new Date(KEY.periodEnd) },
      { id: ID },
      { periodEnd: KEY.periodEnd },
      null,
      ID,
      42,
    ];
    for (const value of refused) expect(isCandidateKey(value), JSON.stringify(value)).toBe(false);
  });
});

describe("listCandidates: one page of the candidate list", () => {
  it("the first page has no cursor; the list is ordered by (period_end, id) and the period end is read as exact UTC text", async () => {
    const r = recording([{ id: ID, period_end: KEY.periodEnd }]);
    expect(await lifecycleRepo(r.tx).listCandidates(NOW, 7, 500)).toEqual([KEY]);
    expect(r.sent).toHaveLength(1);
    const { text, params } = r.sent[0]!;
    expect(params).toEqual([HORIZON, 500]);
    expect(text).toContain(
      `select s.id, to_char(s.period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as period_end from subscriptions s`,
    );
    expect(text).toContain(
      "where ((s.status = 'active' and s.period_end <= $1::timestamptz) or s.status in ('grace', 'retained')) order by s.period_end, s.id limit $2",
    );
  });

  it("a later page holds the rows strictly after its cursor, compared with the values the cursor was read with", async () => {
    const r = recording([]);
    expect(await lifecycleRepo(r.tx).listCandidates(NOW, 7, 500, KEY)).toEqual([]);
    const { text, params } = r.sent[0]!;
    expect(params).toEqual([HORIZON, KEY.periodEnd, KEY.id, 500]);
    // The status filter is one group: the cursor applies to the active rows and to the others alike.
    expect(text).toContain(
      "where ((s.status = 'active' and s.period_end <= $1::timestamptz) or s.status in ('grace', 'retained')) and (s.period_end, s.id) > ($2::timestamptz, $3::uuid) order by s.period_end, s.id limit $4",
    );
  });

  it("an infinite period end, which has no text, comes back as an empty key: never a cursor", async () => {
    const r = recording([{ id: ID, period_end: null }]);
    const page = await lifecycleRepo(r.tx).listCandidates(NOW, 7, 500);
    expect(page).toEqual([{ id: ID, periodEnd: "" }]);
    expect(isCandidateKey(page[0])).toBe(false);
  });

  it("refuses a cursor that is not a key of the list before any statement (R16)", async () => {
    const s = untouchable();
    const bad: unknown[] = [
      { id: ID, periodEnd: "2026-11-10T06:00:00.123Z" },
      { id: "x", periodEnd: KEY.periodEnd },
      { id: ID.toUpperCase(), periodEnd: KEY.periodEnd },
      { id: ID },
      ID,
    ];
    for (const after of bad) {
      await expect(
        lifecycleRepo(s.tx).listCandidates(NOW, 7, 500, after as CandidateKey),
      ).rejects.toThrow(new TypeError("lifecycle: the cursor is not a key of the candidate list"));
    }
    expect(s.used).toEqual([]);
  });

  it("the page size stays from 1 to 5000, checked before any statement", async () => {
    const s = untouchable();
    for (const limit of [0, 5001, 2.5]) {
      await expect(lifecycleRepo(s.tx).listCandidates(NOW, 7, limit)).rejects.toThrow(
        new RangeError("lifecycle: limit must be from 1 to 5000"),
      );
    }
    expect(s.used).toEqual([]);
  });
});
