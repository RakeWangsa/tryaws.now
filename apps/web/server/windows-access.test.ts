import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import { revealWindowsPasswordCore, type WindowsAccessDeps } from "./windows-access.ts";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const RES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "tc-test-windows-password-value-123";
const NOW = new Date("2026-11-12T10:00:00.000Z");

function session(over: Partial<CustomerSession> = {}): CustomerSession {
  return {
    customerId: CUSTOMER,
    signedInAt: new Date(NOW.getTime() - 60_000),
    ...over,
  } as CustomerSession;
}

// The tenant-scoped read: only the owner's own Windows server is found, like repos.resources.get.
const OWNED = new Map([[`${CUSTOMER}:${RES}`, "active"]]);
const OTHER_CUSTOMER = "22222222-2222-4222-8222-222222222222";

function setup(over: Partial<WindowsAccessDeps> = {}) {
  const order: string[] = [];
  const revealed: { customerId: string; resourceId: string }[] = [];
  const deps: WindowsAccessDeps = {
    authenticate: async () => {
      order.push("authenticate");
      return session();
    },
    now: () => NOW,
    ownedWindows: async (customerId, resourceId) => {
      order.push("owned");
      return OWNED.get(`${customerId}:${resourceId}`) ?? null;
    },
    rateLimit: async () => {
      order.push("limit");
      return true;
    },
    reveal: async (input) => {
      order.push("reveal");
      revealed.push(input);
      return { ok: true, value: { username: "Administrator", password: SECRET } };
    },
    ...over,
  };
  return { deps, order, revealed };
}

describe("revealWindowsPasswordCore", () => {
  it("runs in the order of R9 and returns the secret flagged no-store", async () => {
    const { deps, order } = setup();
    const r = await revealWindowsPasswordCore(deps, { resourceId: RES });
    expect(r).toEqual({
      ok: true,
      username: "Administrator",
      password: SECRET,
      cacheControl: "no-store",
    });
    expect(order).toEqual(["authenticate", "owned", "limit", "reveal"]);
  });

  it("takes the customer from the session, never from the input (R8)", async () => {
    const { deps, revealed } = setup();
    await revealWindowsPasswordCore(deps, { resourceId: RES, customerId: "evil" });
    expect(revealed).toEqual([{ customerId: CUSTOMER, resourceId: RES }]);
  });

  it("refuses without a session, and without a fresh sign-in (10 minutes), before anything else", async () => {
    const none = setup({ authenticate: async () => null });
    expect(await revealWindowsPasswordCore(none.deps, { resourceId: RES })).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    const stale = setup({
      authenticate: async () => session({ signedInAt: new Date(NOW.getTime() - 3_600_000) }),
    });
    expect(await revealWindowsPasswordCore(stale.deps, { resourceId: RES })).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(none.order).toEqual([]);
    expect(stale.order).toEqual([]);
  });

  it("refuses an id that is not a UUID without limiting or revealing", async () => {
    const { deps, order } = setup();
    for (const raw of [{}, null, { resourceId: 5 }, { resourceId: "../x" }, { resourceId: "" }]) {
      expect(await revealWindowsPasswordCore(deps, raw)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(order).toEqual([
      "authenticate",
      "authenticate",
      "authenticate",
      "authenticate",
      "authenticate",
    ]);
  });

  it("is refused by the rate limit before the function is invoked", async () => {
    const { deps, order } = setup({ rateLimit: async () => false });
    expect(await revealWindowsPasswordCore(deps, { resourceId: RES })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(order).not.toContain("reveal");
  });

  // R8, non-vacuous: the tenant read is the real lookup above (only CUSTOMER's pair is found), the
  // function is a spy that must never be reached, and the session of customer B asks for A's server.
  it("customer B asking for customer A's server gets the answer of a missing id, and the tenant read ran (R8)", async () => {
    const reached: string[] = [];
    const asB = setup({
      authenticate: async () => session({ customerId: OTHER_CUSTOMER }),
      reveal: async () => {
        reached.push("reveal");
        return { ok: true, value: { username: "Administrator", password: SECRET } };
      },
    });
    const crossTenant = await revealWindowsPasswordCore(asB.deps, { resourceId: RES });
    const missing = await revealWindowsPasswordCore(asB.deps, {
      resourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(crossTenant).toEqual({ ok: false, error: "not_found" });
    expect(missing).toEqual(crossTenant);
    // The ownership read ran for both, before the limiter and before the function.
    expect(asB.order).toEqual(["owned", "owned"]);
    expect(reached).toEqual([]);
    expect(JSON.stringify(crossTenant)).not.toContain(SECRET);
    // The owner, same code path, is served: the lookup is what tells the two apart.
    const asA = setup();
    expect(await revealWindowsPasswordCore(asA.deps, { resourceId: RES })).toMatchObject({
      ok: true,
    });
  });

  it("a server that is not active is not_ready, before the limiter", async () => {
    const { deps, order } = setup({ ownedWindows: async () => "stopped" });
    expect(await revealWindowsPasswordCore(deps, { resourceId: RES })).toEqual({
      ok: false,
      error: "not_ready",
    });
    expect(order).not.toContain("limit");
  });

  it("maps the answers of the function to public keys (not_found from the function stays not_found)", async () => {
    const { deps } = setup({ reveal: async () => ({ ok: false, error: "not_found" }) });
    expect(await revealWindowsPasswordCore(deps, { resourceId: RES })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("reads only the named field with zod: extra fields and a padded id are handled by the schema", async () => {
    const { deps, revealed } = setup();
    await revealWindowsPasswordCore(deps, { resourceId: ` ${RES} `, customerId: "evil", x: 1 });
    expect(revealed).toEqual([{ customerId: CUSTOMER, resourceId: RES }]);
    expect(await revealWindowsPasswordCore(deps, { resourceId: [RES] })).toMatchObject({
      error: "validation",
    });
  });

  it("fails closed when the ownership read throws", async () => {
    const { deps, order } = setup({
      ownedWindows: async () => {
        throw new Error("db down");
      },
    });
    expect(await revealWindowsPasswordCore(deps, { resourceId: RES })).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(order).not.toContain("reveal");
  });

  it("maps every function answer to a public key and never passes raw text", async () => {
    for (const [from, to] of [
      ["conflict", "not_ready"],
      ["upstream_unavailable", "unavailable"],
      ["internal", "unavailable"],
      ["validation", "not_found"],
      ["rate_limited", "rate_limited"],
      ["whatever raw text", "unavailable"],
    ] as const) {
      const { deps } = setup({ reveal: async () => ({ ok: false, error: from }) });
      expect(await revealWindowsPasswordCore(deps, { resourceId: RES })).toEqual({
        ok: false,
        error: to,
      });
    }
  });

  it("fails closed when the port throws, without the secret or the error text", async () => {
    const { deps } = setup({
      reveal: async () => {
        throw new Error(`down ${SECRET}`);
      },
    });
    const r = await revealWindowsPasswordCore(deps, { resourceId: RES });
    expect(r).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("fails closed when no transport to the function is configured", async () => {
    const { deps } = setup({ reveal: null });
    expect(await revealWindowsPasswordCore(deps, { resourceId: RES })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
