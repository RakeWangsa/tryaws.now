import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePending } from "./auth/pending.ts";

const state = vi.hoisted(() => ({
  session: null as null | { customerId: string; locale: "bn" | "en" },
  cookie: undefined as string | undefined,
  identity: {} as unknown,
  key: "k".repeat(40) as string | null,
}));

vi.mock("@tc/auth", () => ({
  currentCustomer: async () =>
    state.session === null
      ? { ok: false, error: "unauthenticated" }
      : { ok: true, value: state.session },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "__Host-tc_pending" && state.cookie !== undefined
        ? { name, value: state.cookie }
        : undefined,
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("./runtime.ts", () => ({
  getRuntime: async () => ({ identity: state.identity, authLimitKey: state.key }),
}));

const { isFlag, loadAuthPage, queryText, readPending } = await import("./auth-page.ts");

beforeEach(() => {
  state.session = null;
  state.cookie = undefined;
  state.identity = {};
  state.key = "k".repeat(40);
});

describe("loadAuthPage", () => {
  it("is available when the identity provider and the limiter key are there", async () => {
    const page = await loadAuthPage("bn", undefined, { guest: true });
    expect(page.available).toBe(true);
    expect(page.session).toBeNull();
  });

  it("is not available without an identity provider or a key (R16)", async () => {
    state.identity = null;
    expect((await loadAuthPage("bn", undefined, { guest: true })).available).toBe(false);
    state.identity = {};
    state.key = null;
    expect((await loadAuthPage("bn", undefined, { guest: true })).available).toBe(false);
  });

  it("sends a signed-in customer on a guest page to the panel, with next checked", async () => {
    state.session = { customerId: "c1", locale: "bn" };
    await expect(loadAuthPage("bn", "/wallet?x=1", { guest: true })).rejects.toThrow(
      "REDIRECT:/en/wallet?x=1",
    );
    await expect(loadAuthPage("en", "//evil.com", { guest: true })).rejects.toThrow(
      "REDIRECT:/en/wallet",
    );
    await expect(loadAuthPage("bn", 42, { guest: true })).rejects.toThrow("REDIRECT:/en/wallet");
  });

  it("leaves a signed-in customer on /verify (guest: false) and returns the session", async () => {
    state.session = { customerId: "c1", locale: "bn" };
    const page = await loadAuthPage("bn", undefined, { guest: false });
    expect(page.session?.customerId).toBe("c1");
  });
});

describe("readPending", () => {
  it("reads a valid cookie", async () => {
    state.cookie = encodePending({
      p: "signup",
      e: "a@example.test",
      t: Math.floor(Date.now() / 1000),
    });
    expect(await readPending()).toMatchObject({ p: "signup", e: "a@example.test" });
  });

  it("a tampered, forged or old cookie is null", async () => {
    for (const bad of [
      "not-base64-!!",
      Buffer.from('{"v":1,"p":"signup","e":"A@B.C","t":1}').toString("base64url"),
      encodePending({ p: "signup", e: "a@example.test", t: 1 }),
      "x".repeat(600),
    ]) {
      state.cookie = bad;
      expect(await readPending(), bad.slice(0, 20)).toBeNull();
    }
    state.cookie = undefined;
    expect(await readPending()).toBeNull();
  });
});

describe("query helpers", () => {
  it("queryText takes the first string", () => {
    expect(queryText("a")).toBe("a");
    expect(queryText(["a", "b"])).toBe("a");
    expect(queryText(undefined)).toBeUndefined();
    expect(queryText([])).toBeUndefined();
  });

  it("isFlag is true only for exactly 1", () => {
    expect(isFlag("1")).toBe(true);
    for (const bad of ["2", "", "true", "01", "<script>", undefined, ["1x"]]) {
      expect(isFlag(bad as string), String(bad)).toBe(false);
    }
  });
});
