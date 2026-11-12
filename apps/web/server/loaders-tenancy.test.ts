import type { CustomerSession } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WP9-T2 sweep (R8): the loaders behind every page with an id in its path ([id], [paymentId]). Each one
// builds its repositories from the SESSION's customer and asks them for the id of the URL; the
// repositories answer a row of another customer like a missing one (packages/db cross-tenant cases), so
// the page shows its not-found state. Here the repositories are a recording stand-in that answers
// "no such row" for every get: the loaders must (a) never open a repository for any customer but the
// session's, (b) answer exactly like a missing row, (c) write nothing.
const state = vi.hoisted(() => ({ calls: [] as string[], opened: [] as string[] }));

vi.mock("@tc/db", async (original) => {
  const real = await original<typeof import("@tc/db")>();
  const group = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          async (...args: unknown[]) => {
            state.calls.push(`${name}.${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);
            if (name === "profile" && method === "get") return { market: "BD", locale: "bn" };
            return method === "get" || method === "view" ? null : [];
          },
      },
    );
  return {
    ...real,
    withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    customerRepos: (_tx: unknown, customerId: string) => {
      state.opened.push(customerId);
      return new Proxy({}, { get: (_t, name: string) => group(name) });
    },
    readFeatureFlag: async () => true,
    readCatalogProduct: async () => null,
  };
});

const { loadServerDetail, loadOrder } = await import("./servers-view.ts");
const { loadServerExtras } = await import("./extras-view.ts");
const { loadServerManage } = await import("./server-manage-view.ts");
const { loadCdnDetail } = await import("./cdn-view.ts");
const { loadBucketDetail } = await import("./bucket-view.ts");
const { loadContainerDetail } = await import("./container-view.ts");
const { loadPayment } = await import("./topup-view.ts");

const MINE = "22222222-2222-4222-8222-222222222222";
const THEIRS = "0190aaaa-0000-7000-8000-0000000000a1"; // an id of another customer's row
const session = { customerId: MINE } as CustomerSession;
const WRITES =
  /\.(request|record|insert|create|set|update|consume|markRead|requestDestroy|createBackupRow)\(/;

beforeEach(() => {
  state.calls.length = 0;
  state.opened.length = 0;
});

// The row of another customer is, for the repository of this one, a row that does not exist.
const CASES: Array<[string, () => Promise<unknown>, unknown]> = [
  ["servers/[id]  loadServerDetail", () => loadServerDetail(session, THEIRS), null],
  ["orders/[id]  loadOrder", () => loadOrder(session, THEIRS), null],
  [
    "servers/[id]  loadServerExtras",
    () => loadServerExtras(session, THEIRS, "0190aaaa-0000-7000-8000-0000000000f1"),
    { state: "ready", extras: null },
  ],
  [
    "servers/[id]  loadServerManage",
    () => loadServerManage(session, THEIRS, "0190aaaa-0000-7000-8000-0000000000f1"),
    null,
  ],
  ["cdn/[id]  loadCdnDetail", () => loadCdnDetail(session, THEIRS), null],
  ["storage/[id]  loadBucketDetail", () => loadBucketDetail(session, THEIRS), null],
  ["containers/[id]  loadContainerDetail", () => loadContainerDetail(session, THEIRS), null],
  ["wallet/topup/[paymentId]  loadPayment", () => loadPayment(session, THEIRS), null],
];

describe("the loaders of the pages with an id answer another customer's id like a missing row", () => {
  it.each(CASES)("%s", async (_name, run, missing) => {
    expect(await run()).toEqual(missing);
    // Only the session's customer ever opened a repository (R8: the id comes from the session).
    expect(state.opened.length).toBeGreaterThan(0);
    expect(new Set(state.opened)).toEqual(new Set([MINE]));
    // The id of the URL was only a key for a get/list of the tenant repository, never a customer.
    expect(state.calls.some((c) => c.includes(THEIRS))).toBe(true);
    expect(state.calls.filter((c) => WRITES.test(c))).toEqual([]);
  });

  it("a payment id that is not a UUID is not looked up at all", async () => {
    expect(await loadPayment(session, "not-a-uuid")).toBeNull();
    expect(state.opened).toEqual([]);
  });
});
