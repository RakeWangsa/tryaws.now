import { describe, expect, it } from "vitest";
import {
  FAKE_MARKERS,
  WALLET_ROUTES,
  checkDevRoutesRefused,
  checkNoFakeInBundle,
  checkWalletRoutes,
} from "./wallet-checks.mjs";

// A route table as `next build` of Next 16 prints it (see the build of apps/web).
const TABLE = [
  "▲ Next.js 16.4.6 (Turbopack)",
  "",
  "Route (app)",
  "┌ ƒ /_not-found",
  "├ ƒ /[locale]",
  "├ ƒ /[locale]/dev/eps/checkout",
  "├ ƒ /[locale]/dev/sign-in",
  "├ ƒ /[locale]/dev/ui",
  "├ ƒ /[locale]/dev/ui/[shell]",
  "├ ƒ /[locale]/wallet",
  "├ ƒ /[locale]/wallet/topup",
  "├ ƒ /[locale]/wallet/topup/[paymentId]",
  "├ ƒ /api/csp-report",
  "├ ƒ /pay/eps/cancel",
  "├ ƒ /pay/eps/fail",
  "└ ƒ /pay/eps/success",
  "",
  "ƒ Proxy (Middleware)",
  "",
  "ƒ  (Dynamic)  server-rendered on demand",
].join("\n");

describe("checkWalletRoutes", () => {
  it("passes when the three screens and the three return routes are all dynamic", () => {
    expect(WALLET_ROUTES).toHaveLength(6);
    expect(checkWalletRoutes(TABLE)).toEqual([]);
  });

  it("names a missing route", () => {
    const problems = checkWalletRoutes(TABLE.replace("├ ƒ /[locale]/wallet/topup\n", ""));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/wallet/topup");
    expect(problems[0]).toContain("missing");
    // the status page must not satisfy the shorter path
    expect(
      checkWalletRoutes(TABLE.replace("├ ƒ /[locale]/wallet/topup/[paymentId]\n", "")),
    ).toEqual([expect.stringContaining("/wallet/topup/[paymentId]")]);
  });

  it("names a static route", () => {
    const problems = checkWalletRoutes(TABLE.replace("├ ƒ /pay/eps/fail", "├ ○ /pay/eps/fail"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/pay/eps/fail");
    expect(problems[0]).toContain("static");
  });

  it("accepts the routes without the locale segment, and fails on output that is not a table (R16)", () => {
    const flat = ["┌ ƒ /wallet", "├ ƒ /wallet/topup", "├ ƒ /wallet/topup/[paymentId]"].concat(
      TABLE.split("\n").filter((line) => line.includes("/pay/eps/")),
    );
    expect(checkWalletRoutes(flat.join("\n"))).toEqual([]);
    expect(checkWalletRoutes("")).toHaveLength(1);
    expect(checkWalletRoutes("Route (app)\nnothing")).toHaveLength(1);
  });
});

describe("checkDevRoutesRefused (TC_STAGE=production)", () => {
  it("passes when every dev path answered 404", () => {
    expect(
      checkDevRoutesRefused([
        { path: "/dev/sign-in?sub=x", status: 404 },
        { path: "/dev/eps/checkout?data=1", status: 404 },
      ]),
    ).toEqual([]);
  });

  it("names a dev path that answered anything else, and an empty list", () => {
    const problems = checkDevRoutesRefused([
      { path: "/dev/sign-in?sub=x", status: 303 },
      { path: "/dev/eps/checkout?data=1", status: 200 },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("/dev/sign-in");
    expect(checkDevRoutesRefused([])).toHaveLength(1);
  });
});

describe("checkNoFakeInBundle", () => {
  const clean = [
    { path: ".next/server/chunks/a.js", text: "export const x = 1; // checkGatewayRedirect" },
    { path: ".next/static/chunks/b.js", text: "console.log('ok')" },
  ];

  it("passes a bundle that holds none of the markers", () => {
    expect(checkNoFakeInBundle(clean)).toEqual([]);
  });

  it("names the file and the marker of a planted InMemoryEps", () => {
    const problems = checkNoFakeInBundle([
      ...clean,
      { path: ".next/server/chunks/c.js", text: "class InMemoryEps {}" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(".next/server/chunks/c.js");
    expect(problems[0]).toContain("InMemoryEps");
  });

  it("finds the dev verifier and the dev checkout path of the bridge too", () => {
    expect(FAKE_MARKERS.length).toBeGreaterThanOrEqual(3);
    const problems = checkNoFakeInBundle([
      { path: "d.js", text: "const DEV_TOKEN = /^dev\\.([A-Za-z0-9_-]{1,64})$/;" },
      { path: "e.js", text: "redirectUrl: `/dev/eps/checkout?data=${x}`" },
    ]);
    expect(problems).toHaveLength(2);
  });

  it("does not flag the route name of the dev page, which exists in a build and answers 404", () => {
    expect(
      checkNoFakeInBundle([{ path: "m.json", text: '{"/[locale]/dev/eps/checkout/page":"x"}' }]),
    ).toEqual([]);
  });

  it("an empty list of files is a problem: a check that read nothing proves nothing (R16)", () => {
    expect(checkNoFakeInBundle([])).toHaveLength(1);
  });
});
