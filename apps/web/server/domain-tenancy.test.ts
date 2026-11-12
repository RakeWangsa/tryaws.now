import type { CustomerSession } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WP7-T4 (R8): the loader behind /domains/[name]. It builds its repositories from the SESSION's customer
// and asks them for the name of the URL; the repository answers a domain of another customer like a
// missing one (packages/db cross-tenant case domains.getByName), so the page shows its not-found state.
// Here the repositories are a recording stand-in that answers "no such row": the loader must never open a
// repository for any customer but the session's, answer exactly like a missing row and write nothing.
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
            return method === "get" || method === "getByName" ? null : [];
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
  };
});

const { loadDomainDetail } = await import("./domain-view.ts");

const MINE = "22222222-2222-4222-8222-222222222222";
const session = { customerId: MINE } as CustomerSession;
const WRITES = /\.(request|record|insert|create|set|update|consume|setAutoRenew)\(/;

beforeEach(() => {
  state.calls.length = 0;
  state.opened.length = 0;
});

describe("domains/[name] answers another customer's domain like a missing row", () => {
  it("loadDomainDetail opens only the session's repositories, finds nothing and writes nothing", async () => {
    expect(await loadDomainDetail(session, "theirs.com")).toBeNull();
    expect(new Set(state.opened)).toEqual(new Set([MINE]));
    expect(state.calls.some((c) => c.includes("theirs.com"))).toBe(true);
    expect(state.calls.filter((c) => WRITES.test(c))).toEqual([]);
  });
});
