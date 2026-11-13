import type { CustomerSession } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-Z6 (R8): the loaders of /support/requests and /support/requests/[id]. They open the repositories of
// the SESSION's customer only; the repository answers a request of another customer like a missing one
// (not_found, proven against PostgreSQL in packages/db/test/support-repo.test.ts), and the loader turns
// that into null, the not-found state of the page. Nothing is written.
const state = vi.hoisted(() => ({
  calls: [] as string[],
  opened: [] as string[],
  own: new Map<string, string[]>(),
  fail: false,
}));

const MINE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const MY_REQUEST = "0191a000-0000-7000-8000-0000000000e1";
const THEIR_REQUEST = "0191a000-0000-7000-8000-0000000000e2";
const AT = new Date("2026-11-13T06:00:00Z");

vi.mock("@tc/db", async (original) => {
  const real = await original<typeof import("@tc/db")>();
  return {
    ...real,
    withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    customerRepos: (_tx: unknown, customerId: string) => {
      state.opened.push(customerId);
      return {
        support: {
          list: async (limit: number) => {
            state.calls.push(`list(${limit})`);
            if (state.fail) throw new Error("db down");
            return (state.own.get(customerId) ?? []).map((id) => ({
              id,
              category: "billing",
              subject: "Charged twice",
              status: "open",
              createdAt: AT,
              lastActivityAt: AT,
            }));
          },
          thread: async (id: string) => {
            state.calls.push(`thread(${id})`);
            if (state.fail) throw new Error("db down");
            if (!(state.own.get(customerId) ?? []).includes(id))
              return { ok: false, error: "not_found" };
            return {
              ok: true,
              replayed: false,
              value: {
                id,
                category: "billing",
                subject: "Charged twice",
                status: "answered",
                createdAt: AT,
                lastActivityAt: AT,
                message: "I was charged twice.",
                messages: [],
                hasEarlier: false,
              },
            };
          },
        },
      };
    },
  };
});

const { loadSupportRequests, loadSupportThread } = await import("./support-view.ts");
const session = { customerId: MINE } as CustomerSession;

beforeEach(() => {
  state.calls.length = 0;
  state.opened.length = 0;
  state.fail = false;
  state.own = new Map([
    [MINE, [MY_REQUEST]],
    [OTHER, [THEIR_REQUEST]],
  ]);
});

describe("loadSupportRequests", () => {
  it("lists the session customer's requests, newest activity first, from the repository", async () => {
    const out = await loadSupportRequests(session);
    expect(out.requests.map((r) => r.id)).toEqual([MY_REQUEST]);
    expect(state.opened).toEqual([MINE]);
    expect(state.calls).toEqual(["list(100)"]);
  });

  it("throws a database error to the error state, never an empty list (R16)", async () => {
    state.fail = true;
    await expect(loadSupportRequests(session)).rejects.toThrow();
  });
});

describe("loadSupportThread", () => {
  it("answers the session customer's own thread", async () => {
    const out = await loadSupportThread(session, MY_REQUEST);
    expect(out?.id).toBe(MY_REQUEST);
    expect(out?.message).toBe("I was charged twice.");
    expect(state.opened).toEqual([MINE]);
  });

  it("answers null for another customer's request like for a missing one, and writes nothing (R8)", async () => {
    expect(await loadSupportThread(session, THEIR_REQUEST)).toBeNull();
    expect(await loadSupportThread(session, "0191a000-0000-7000-8000-0000000000ff")).toBeNull();
    expect(new Set(state.opened)).toEqual(new Set([MINE]));
    expect(state.calls).toEqual([
      `thread(${THEIR_REQUEST})`,
      "thread(0191a000-0000-7000-8000-0000000000ff)",
    ]);
  });

  it("an id that is not a UUID is not looked up at all", async () => {
    expect(await loadSupportThread(session, "not-a-uuid")).toBeNull();
    expect(await loadSupportThread(session, "../x")).toBeNull();
    expect(state.opened).toEqual([]);
  });

  it("throws a database error to the error state (R16)", async () => {
    state.fail = true;
    await expect(loadSupportThread(session, MY_REQUEST)).rejects.toThrow();
  });
});
