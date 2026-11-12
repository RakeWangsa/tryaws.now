import { describe, expect, it, vi } from "vitest";

vi.mock("@tc/auth", () => ({ currentCustomer: vi.fn() }));
vi.mock("../runtime.ts", () => ({ getRuntime: vi.fn() }));

const { signedInWith } = await import("./signed-in.ts");

describe("signedInWith (public pages, WPU-N1)", () => {
  it("is true only when the runtime starts and the session is valid", async () => {
    expect(
      await signedInWith(
        async () => ({}),
        async () => ({ ok: true }),
      ),
    ).toBe(true);
  });
  it("is false without a session", async () => {
    expect(
      await signedInWith(
        async () => ({}),
        async () => ({ ok: false }),
      ),
    ).toBe(false);
  });
  it("fails closed: a runtime or a session read that throws is 'not signed in' (R16)", async () => {
    expect(
      await signedInWith(
        async () => {
          throw new Error("boom");
        },
        async () => ({ ok: true }),
      ),
    ).toBe(false);
    expect(
      await signedInWith(
        async () => ({}),
        async () => {
          throw new Error("db down");
        },
      ),
    ).toBe(false);
  });
});
