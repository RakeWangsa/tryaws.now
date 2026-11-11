import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dev-only surface of the Playwright proof (WP3-T4 Task 8): /dev/sign-in and the fake EPS
// checkout. It exists only when the configuration says fakes, and is a 404 otherwise.

const state = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  settled: [] as [string, unknown][],
  byData: new Map<string, string>(),
  runtimeBuilt: 0,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("./server/runtime.ts", () => ({
  getRuntime: async () => {
    state.runtimeBuilt += 1;
    return {};
  },
}));

const FAKE_ENV = {
  TC_STAGE: "local",
  TC_EPS: "fake",
  NODE_ENV: "development",
  APP_ORIGIN: "http://localhost:3000",
};

const { devSurfaceEnabled, devEps } = await import("./server/dev-surface.ts");
const signIn = await import("./app/[locale]/dev/sign-in/route.ts");
const checkout = await import("./app/[locale]/dev/eps/checkout/page.tsx");
const actions = await import("./app/[locale]/dev/eps/checkout/actions.ts");

beforeEach(() => {
  state.env = { ...FAKE_ENV };
  state.settled = [];
  state.byData = new Map([["7", "0123456789abcdef0123456789abcdef"]]);
  state.runtimeBuilt = 0;
  for (const [key, value] of Object.entries(state.env)) vi.stubEnv(key, value as string);
  (globalThis as Record<string, unknown>)["__tcDevEps"] = {
    fake: { settle: (id: string, outcome: unknown) => state.settled.push([id, outcome]) },
    byData: state.byData,
  };
});

const ctx = (locale = "bn") => ({ params: Promise.resolve({ locale }) });
const get = (url: string) => new Request(`http://localhost:3000${url}`);

describe("devSurfaceEnabled", () => {
  it("is true only for the local or test stage with the fake EPS in development or test", () => {
    expect(devSurfaceEnabled(FAKE_ENV)).toBe(true);
    expect(devSurfaceEnabled({ ...FAKE_ENV, TC_STAGE: "test", NODE_ENV: "test" })).toBe(true);
    expect(devSurfaceEnabled({ ...FAKE_ENV, TC_EPS: undefined })).toBe(false);
  });

  it("is false, not an exception, on staging and production, and with NODE_ENV=production", () => {
    for (const over of [
      { TC_STAGE: "production" },
      { TC_STAGE: "staging", APP_ORIGIN: "https://cloud.example.com" },
      { NODE_ENV: "production" },
      { APP_ORIGIN: undefined },
    ]) {
      expect(devSurfaceEnabled({ ...FAKE_ENV, ...over }), JSON.stringify(over)).toBe(false);
    }
  });
});

describe("GET /dev/sign-in", () => {
  it("sets the session cookies through the auth package and goes to the wallet (303, no-store)", async () => {
    const response = await signIn.GET(get("/dev/sign-in?sub=dev-smoke-abc"), ctx());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/wallet");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain("__Host-tc_at=dev.dev-smoke-abc");
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("Path=/");
  });

  it("goes to /en/wallet in English", async () => {
    const response = await signIn.GET(get("/en/dev/sign-in?sub=dev-smoke-abc"), ctx("en"));
    expect(response.headers.get("location")).toBe("/en/wallet");
  });

  it("is a 404 when the surface is off, with no cookie (production stage with the fake switch)", async () => {
    vi.stubEnv("TC_STAGE", "production");
    await expect(signIn.GET(get("/dev/sign-in?sub=dev-smoke-abc"), ctx())).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    vi.stubEnv("TC_STAGE", "local");
    vi.stubEnv("TC_EPS", "");
    await expect(signIn.GET(get("/dev/sign-in?sub=dev-smoke-abc"), ctx())).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("refuses a missing, long or odd subject and an unknown language", async () => {
    for (const query of [
      "",
      "?sub=",
      "?sub=a b",
      "?sub=../x",
      `?sub=${"a".repeat(65)}`,
      "?sub=a;b",
    ]) {
      await expect(signIn.GET(get(`/dev/sign-in${query}`), ctx()), query).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
    }
    await expect(signIn.GET(get("/dev/sign-in?sub=abc"), ctx("fr"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("builds no Set-Cookie by hand (the auth package does)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, "app/[locale]/dev/sign-in/route.ts"), "utf8");
    expect(source).toContain("sessionSetCookies");
    expect(source).not.toMatch(/["'`]Set-Cookie["'`]\s*,\s*[`"'][^`"']*=/i);
  });
});

describe("the fake EPS checkout page", () => {
  const render = async (data: string | undefined, locale = "bn") =>
    renderToStaticMarkup(
      await checkout.default({
        params: Promise.resolve({ locale }),
        searchParams: Promise.resolve(data === undefined ? {} : { data }),
      }),
    );

  it("shows Pay, Fail and Cancel for a known payment and posts the data of the URL", async () => {
    const html = await render("7");
    expect(html).toContain("Fake EPS");
    for (const outcome of ["pay", "fail", "cancel"]) {
      expect(html).toMatch(
        new RegExp(`<button type="submit" value="${outcome}"[^>]*name="outcome"`),
      );
    }
    expect(html).toContain('name="data" value="7"');
    expect(html).not.toContain(' style="');
    expect(html).not.toContain("0123456789abcdef");
    expect(state.runtimeBuilt).toBe(1);
  });

  it("is a 404 for an unknown, malformed or missing payment and when the surface is off", async () => {
    await expect(render("8")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render("7;drop")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(render(undefined)).rejects.toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("TC_STAGE", "production");
    await expect(render("7")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the settle action of the fake checkout", () => {
  const form = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(fields)) data.set(k, v);
    return data;
  };

  it("settles the fake and returns through the route of the outcome with the id", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const table: [string, string, string][] = [
      ["pay", "Success", "success"],
      ["fail", "Failed", "fail"],
      ["cancel", "Cancelled", "cancel"],
    ];
    for (const [outcome, status, route] of table) {
      state.settled = [];
      await expect(actions.settleFakeEps(form({ data: "7", outcome }))).rejects.toThrow(
        `REDIRECT:/pay/eps/${route}?MerchantTransactionId=${id}`,
      );
      expect(state.settled).toEqual([[id, { status }]]);
    }
  });

  it("refuses an unknown outcome, an unknown payment and an off surface, and settles nothing", async () => {
    await expect(actions.settleFakeEps(form({ data: "7", outcome: "refund" }))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(actions.settleFakeEps(form({ data: "9", outcome: "pay" }))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    vi.stubEnv("TC_STAGE", "production");
    await expect(actions.settleFakeEps(form({ data: "7", outcome: "pay" }))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(state.settled).toEqual([]);
  });

  it("devEps reads the object the bridge keeps on globalThis, and null when there is none", () => {
    expect(devEps()).not.toBeNull();
    delete (globalThis as Record<string, unknown>)["__tcDevEps"];
    expect(devEps()).toBeNull();
  });
});
