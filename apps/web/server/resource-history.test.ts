import { describe, expect, it, vi } from "vitest";

// WPU-N1: the History tab. Cross-tenant proof (R8) and the shape that leaves the loader (U6).

const state = vi.hoisted(() => ({
  resources: [] as { id: string; customerId: string }[],
  operations: [] as {
    id: string;
    resourceId: string;
    kind: string;
    state: string;
    step: string | null;
    needsApproval: boolean;
    createdAt: Date;
  }[],
  fail: false,
}));
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => {
    if (state.fail) throw new Error("db down arn:aws:x");
    return fn({});
  },
  customerRepos: (_tx: unknown, customerId: string) => ({
    resources: {
      get: async (id: string) =>
        state.resources.find((r) => r.id === id && r.customerId === customerId) ?? null,
    },
    operations: {
      // like the real repository: only the rows of a resource of this customer
      listForResource: async (resourceId: string) =>
        state.resources.some((r) => r.id === resourceId && r.customerId === customerId)
          ? state.operations.filter((o) => o.resourceId === resourceId)
          : [],
    },
  }),
}));

const { loadResourceHistory, HISTORY_LIMIT } = await import("./resource-history.ts");

const A = "0190aaaa-0000-7000-8000-0000000000c1";
const B = "0190aaaa-0000-7000-8000-0000000000c2";
const RES = "0190aaaa-0000-7000-8000-0000000000d1";
const session = (customerId: string) => ({ customerId }) as never;
const op = (n: number, kind: string, st: string) => ({
  id: `0190aaaa-0000-7000-8000-00000000f${String(n).padStart(3, "0")}`,
  resourceId: RES,
  kind,
  state: st,
  step: "secret-internal-step",
  needsApproval: false,
  createdAt: new Date(Date.UTC(2026, 10, 1, 0, n)),
});

describe("loadResourceHistory", () => {
  it("lists the operations of the customer's own resource, with kind, state and time only", async () => {
    state.fail = false;
    state.resources = [{ id: RES, customerId: A }];
    state.operations = [op(2, "reboot", "succeeded"), op(1, "create", "failed")];
    const out = await loadResourceHistory(session(A), RES);
    expect(out).toEqual({
      state: "ready",
      items: [
        { id: expect.any(String), kind: "reboot", state: "succeeded", at: expect.any(Date) },
        { id: expect.any(String), kind: "create", state: "failed", at: expect.any(Date) },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("secret-internal-step");
  });

  it("cross-tenant: another customer's resource answers null, like a missing one (R8)", async () => {
    state.resources = [{ id: RES, customerId: A }];
    state.operations = [op(1, "create", "succeeded")];
    expect(await loadResourceHistory(session(B), RES)).toBeNull();
    expect(
      await loadResourceHistory(session(A), "0190aaaa-0000-7000-8000-0000000000ff"),
    ).toBeNull();
  });

  it("names an unknown kind 'other' and an unknown state 'needs_attention'", async () => {
    state.resources = [{ id: RES, customerId: A }];
    state.operations = [op(1, "set_cdn_origin", "mystery")];
    const out = await loadResourceHistory(session(A), RES);
    expect(out).toMatchObject({ items: [{ kind: "other", state: "needs_attention" }] });
  });

  it("shows at most the newest HISTORY_LIMIT, and an empty list is 'ready' with no items", async () => {
    state.resources = [{ id: RES, customerId: A }];
    state.operations = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) =>
      op(i, "reboot", "succeeded"),
    );
    const out = await loadResourceHistory(session(A), RES);
    expect(out && out.state === "ready" && out.items.length).toBe(HISTORY_LIMIT);
    state.operations = [];
    expect(await loadResourceHistory(session(A), RES)).toEqual({ state: "ready", items: [] });
  });

  it("fails closed: a database error is the error state, with no text of it (R16, U6)", async () => {
    state.fail = true;
    const out = await loadResourceHistory(session(A), RES);
    expect(out).toEqual({ state: "error" });
    state.fail = false;
  });
});
