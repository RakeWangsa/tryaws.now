import { describe, expect, it, vi } from "vitest";

// WPU-X11 (owner decision 2026-11-14): customers no longer reach the identity check. /kyc checks the
// session like every panel page (R9 step 1), then leads to the dashboard and its account setup checklist.

const calls = vi.hoisted(() => ({ gate: [] as string[] }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("../../../../server/panel-page.ts", () => ({
  startPanelPage: async (path: string) => {
    calls.gate.push(path);
    return {};
  },
}));

const { default: KycPage } = await import("./page.tsx");

describe("/kyc after WPU-X11", () => {
  it("checks the session first, then redirects to the dashboard in the locale; no form is rendered", async () => {
    await expect(KycPage({ params: Promise.resolve({ locale: "bn" }) })).rejects.toThrow(
      "REDIRECT:/en/dashboard",
    );
    await expect(KycPage({ params: Promise.resolve({ locale: "en" }) })).rejects.toThrow(
      "REDIRECT:/en/dashboard",
    );
    expect(calls.gate).toEqual(["/kyc", "/kyc"]);
  });

  it("an unknown locale is not found", async () => {
    await expect(KycPage({ params: Promise.resolve({ locale: "fr" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
