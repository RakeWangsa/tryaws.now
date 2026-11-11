import type { AdminActor } from "@tc/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  result: { ok: false, error: "unauthenticated" } as
    { ok: true; value: unknown } | { ok: false; error: string },
  rolesAsked: [] as unknown[],
}));

vi.mock("./runtime.ts", () => ({ ensureAdminAuth: () => {} }));
vi.mock("@tc/auth", () => ({
  currentAdmin: async (roles: unknown) => {
    state.rolesAsked.push(roles);
    return state.result;
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

const { loadPageAdmin } = await import("./page-admin.ts");

const actor: AdminActor = { adminId: "a", role: "ops", ip: "203.0.113.5" };

beforeEach(() => {
  state.result = { ok: false, error: "unauthenticated" };
  state.rolesAsked = [];
});

describe("loadPageAdmin", () => {
  it("returns the admin when the guard passes, asking with the roles of that section", async () => {
    state.result = { ok: true, value: actor };
    expect(await loadPageAdmin("bn", "capacity")).toEqual({ kind: "ok", admin: actor });
    expect(state.rolesAsked).toEqual([["ops", "superadmin"]]);
  });

  it("sends a visitor without a session to the sign-in of the same locale", async () => {
    await expect(loadPageAdmin("bn", "today")).rejects.toThrow("NEXT_REDIRECT:/login");
    await expect(loadPageAdmin("en", "today")).rejects.toThrow("NEXT_REDIRECT:/en/login");
  });

  it("answers `denied` for a refusal that is not a missing session (role, IP, MFA, disabled)", async () => {
    state.result = { ok: false, error: "forbidden" };
    expect(await loadPageAdmin("bn", "admins")).toEqual({ kind: "denied" });
  });

  it("answers `denied` when the service is unavailable: nothing is shown (R16)", async () => {
    state.result = { ok: false, error: "upstream_unavailable" };
    expect(await loadPageAdmin("bn", "today")).toEqual({ kind: "denied" });
  });
});
