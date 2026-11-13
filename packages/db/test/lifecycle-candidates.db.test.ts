import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { isCandidateKey, lifecycleRepo, type CandidateKey } from "../repositories/system/lifecycle";
import { runTransaction } from "../tx";
import { newCustomer, newResource } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-Z12 (written without a database in the sandbox: it needs PostgreSQL, NOT RUN here; run with pnpm db:up). The
// candidate list of the lifecycle pass on the real schema, as worker_rw (the scheduler's role), read page after page
// with its keyset cursor: every row once, in (period_end, id) order, ties broken by the id, a microsecond apart
// kept apart, and a page continues from the period end its cursor was read with. Own database (one per file).

const t = useTempDatabase();
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
const NOW = new Date("2026-11-13T06:00:00.000Z");
const HORIZON_DAYS = 7;
let customerId = "";

const page = (limit: number, after: CandidateKey | null = null) =>
  worker((tx) => lifecycleRepo(tx).listCandidates(NOW, HORIZON_DAYS, limit, after));

// Every page from the head, as the engine reads them: until a page is short.
async function walk(limit: number): Promise<{ keys: CandidateKey[]; pages: number }> {
  const keys: CandidateKey[] = [];
  let after: CandidateKey | null = null;
  for (let pages = 1; ; pages += 1) {
    const rows: CandidateKey[] = await page(limit, after);
    keys.push(...rows);
    if (rows.length < limit) return { keys, pages };
    after = rows[rows.length - 1]!;
  }
}

// The list as the owner sees it, in the order the walk must give: the oracle of the cases below.
const expectedIds = async (): Promise<string[]> =>
  (
    await t.pool.query<{ id: string }>(
      `select id from subscriptions
        where (status = 'active' and period_end <= $1::timestamptz) or status in ('grace', 'retained')
        order by period_end, id`,
      [new Date(NOW.getTime() + HORIZON_DAYS * 86_400_000).toISOString()],
    )
  ).rows.map((r) => r.id);

// A subscription of a resource of its own (resource_id is unique). The period end is text, so a case can store
// microseconds that a JavaScript Date cannot hold.
async function subscription(status: string, periodEnd: string): Promise<string> {
  const resourceId = await newResource(t.pool, customerId, { state: "active" });
  return insertRow(t.pool, "subscriptions", {
    resource_id: resourceId,
    customer_id: customerId,
    term_days: 30,
    price_snapshot: "{}",
    period_start: "2000-01-01T00:00:00.000000Z",
    period_end: periodEnd,
    status,
  });
}

beforeAll(async () => {
  customerId = await newCustomer(t.pool);
});

describe("listCandidates read page after page (keyset over period_end, id)", () => {
  it("gives every candidate once, in (period_end, id) order: ties by the id, a microsecond apart kept apart", async () => {
    const tie: string[] = [];
    for (let i = 0; i < 5; i += 1)
      tie.push(await subscription("grace", "2026-11-10T06:00:00.000000Z"));
    const micro = await subscription("active", "2026-11-10T06:00:00.000001Z");
    const microTie = await subscription("active", "2026-11-10T06:00:00.000001Z");
    await subscription("retained", "2026-10-01T00:00:00.000000Z");
    await subscription("active", "2026-11-19T06:00:00.000000Z"); // inside the 7 reminder days

    const expected = await expectedIds();
    for (const limit of [1, 2, 3, expected.length, expected.length + 1]) {
      const { keys, pages } = await walk(limit);
      expect(
        keys.map((k) => k.id),
        `page size ${limit}`,
      ).toEqual(expected);
      // A list of n rows is read in floor(n / size) + 1 pages: the last one is short, or empty.
      expect(pages, `page size ${limit}`).toBe(Math.floor(expected.length / limit) + 1);
      expect(keys.every(isCandidateKey)).toBe(true);
    }
    const { keys } = await walk(2);
    const byId = new Map(keys.map((k) => [k.id, k.periodEnd]));
    expect(byId.get(micro)).toBe("2026-11-10T06:00:00.000001Z");
    expect(byId.get(microTie)).toBe("2026-11-10T06:00:00.000001Z");
    expect(byId.get(tie[0]!)).toBe("2026-11-10T06:00:00.000000Z");
    // the tie comes out sorted by the id (text order of lower-case hex is PostgreSQL's uuid order), and before the
    // rows one microsecond later
    const order = keys.map((k) => k.id);
    expect(order.filter((id) => tie.includes(id))).toEqual([...tie].sort());
    expect(Math.max(...tie.map((id) => order.indexOf(id)))).toBeLessThan(order.indexOf(micro));
  });

  it("keeps the filter of the list: active up to the reminder horizon, grace and retained at any date, never ended", async () => {
    const inside = await subscription("active", "2026-11-20T06:00:00.000000Z"); // exactly NOW + 7 days
    const beyond = await subscription("active", "2026-11-20T06:00:00.000001Z");
    const graceLater = await subscription("grace", "2027-01-01T00:00:00.000000Z");
    const retainedLater = await subscription("retained", "2027-02-01T00:00:00.000000Z");
    const ended = await subscription("ended", "2026-11-01T00:00:00.000000Z");
    const ids = (await walk(2)).keys.map((k) => k.id);
    expect(ids).toEqual(expect.arrayContaining([inside, graceLater, retainedLater]));
    expect(ids).not.toContain(beyond);
    expect(ids).not.toContain(ended);
    expect(ids).toEqual(await expectedIds());
  });

  it("continues from the period end its cursor was read with: a row renewed after its page does not make the next page skip", async () => {
    // A tie at the head of the list (earlier than every other row of this file).
    const head: string[] = [];
    for (let i = 0; i < 4; i += 1)
      head.push(await subscription("grace", "2001-01-01T00:00:00.000000Z"));
    const sorted = [...head].sort();
    const first = await page(2);
    expect(first.map((k) => k.id)).toEqual(sorted.slice(0, 2));
    // The last row of the page is renewed while the page is processed: its period end moves ahead.
    await t.pool.query(
      "update subscriptions set status = 'active', period_end = '2026-11-15T00:00:00Z' where id = $1",
      [sorted[1]],
    );
    // The next page still holds the two other rows of the tie (a cursor that read the row's period end again would
    // start after 2026-11-15 and skip them).
    const second = await page(2, first[1]!);
    expect(second.map((k) => k.id)).toEqual(sorted.slice(2, 4));
    // The renewed row comes back later in the same walk under its new key: the engine visits it once (candidate-walk).
    const rest = (await walk(500)).keys;
    expect(rest.find((k) => k.id === sorted[1])?.periodEnd).toBe("2026-11-15T00:00:00.000000Z");
  });

  it("a cursor after the last row gives an empty page", async () => {
    await subscription("retained", "2030-01-01T00:00:00.000000Z"); // the last row of the list
    const { keys } = await walk(500);
    const last = keys[keys.length - 1]!;
    expect(last.periodEnd).toBe("2030-01-01T00:00:00.000000Z");
    expect(await page(500, last)).toEqual([]);
  });

  // WPU-Y2 (NOT RUN in the sandbox). A domain is charged 30 days before its period end, so its row is a candidate
  // 30 days before the reminder horizon; a row of any other family keeps the horizon.
  it("a family with a lead time is a candidate that many days earlier, the others are not", async () => {
    const leadEnd = "2026-12-20T06:00:00.000000Z"; // NOW + 7 + 30 days
    const domainRes = await newResource(t.pool, customerId, { state: "active", family: "domain" });
    const domainSub = await insertRow(t.pool, "subscriptions", {
      resource_id: domainRes,
      customer_id: customerId,
      term_days: 365,
      price_snapshot: "{}",
      period_start: "2000-01-01T00:00:00.000000Z",
      period_end: leadEnd,
      status: "active",
    });
    const domainBeyond = await insertRow(t.pool, "subscriptions", {
      resource_id: await newResource(t.pool, customerId, { state: "active", family: "domain" }),
      customer_id: customerId,
      term_days: 365,
      price_snapshot: "{}",
      period_start: "2000-01-01T00:00:00.000000Z",
      period_end: "2026-12-20T06:00:00.000001Z",
      status: "active",
    });
    const server = await subscription("active", leadEnd);
    const ids: string[] = [];
    let after: CandidateKey | null = null;
    for (;;) {
      const rows: CandidateKey[] = await worker((tx) =>
        lifecycleRepo(tx).listCandidates(NOW, HORIZON_DAYS, 2, after, { domain: 30 }),
      );
      ids.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      after = rows[rows.length - 1]!;
    }
    expect(ids).toContain(domainSub);
    expect(ids).not.toContain(domainBeyond);
    expect(ids).not.toContain(server);
  });
});
