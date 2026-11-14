import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PublicCatalog } from "../../../../server/public/catalog.ts";
import { html } from "../public-states.tsx";
import { NONCE, ORIGIN, UNAVAILABLE, openCatalog } from "../public.fixtures.ts";
import { PricingContent } from "./PricingContent.tsx";

// WPU-X13: the pricing page. The location filter is a link with a query (no script), the table has
// vCPU, memory, disk and transfer, and the VAT note is visible. Not built, on purpose: a monthly or
// hourly switch (the engine gives a 30 day price only) and "what 1,000 BDT buys" (public pages show no
// taka, WPU-Y4, and the conversion is made at checkout with the rate of the day).

vi.mock("../products/[family]/actions.ts", () => ({
  notifyMeAction: async () => ({ status: "idle" }),
}));

let open: PublicCatalog;
beforeAll(async () => {
  open = await openCatalog();
});

const render = (catalog: PublicCatalog, region?: string, locale: "bn" | "en" = "en"): string =>
  html(
    <PricingContent
      locale={locale}
      catalog={catalog}
      origin={ORIGIN}
      nonce={NONCE}
      region={region}
    />,
    locale,
  );
const rows = (page: string): string[] =>
  (/<tbody>[^]*?<\/tbody>/.exec(page)?.[0] ?? "").match(/<tr>/g) ?? [];

describe("pricing page (WPU-X13)", () => {
  it("lists every location with no filter, and offers a link for each filter", () => {
    const page = render(open);
    expect(page).toContain('href="/en/pricing"');
    expect(page).toContain('href="/en/pricing?region=ap-southeast-1"');
    expect(page).toContain('href="/en/pricing?region=ap-south-1"');
    expect(page).toMatch(/<nav[^>]*aria-label="Filter by location"/);
    expect(page).toContain("Singapore");
    expect(page).toContain("Mumbai");
  });

  it("keeps only the offers of one location when the query names it", () => {
    const all = rows(render(open)).length;
    const mumbai = render(open, "ap-south-1");
    const singapore = render(open, "ap-southeast-1");
    // Fixture: the Linux 1 GB plan exists at both locations; the 4 GB and 8 GB plans and the database
    // only in Singapore.
    expect(rows(mumbai).length).toBe(1);
    expect(rows(singapore).length).toBe(all - 1);
    expect(mumbai).not.toMatch(/<td class="seccolor">Singapore<\/td>/);
    expect(singapore).not.toMatch(/<td class="seccolor">Mumbai<\/td>/);
  });

  it("tells the chosen location by an icon and a hidden word, not by color alone (U11)", () => {
    const page = render(open, "ap-south-1");
    expect(page).toMatch(/fa-check[^]*?Mumbai<span class="visually-hidden"> \(selected\)<\/span>/);
    expect((page.match(/\(selected\)/g) ?? []).length).toBe(1);
  });

  it("shows everything for a value that is not a location (nothing is guessed from the query)", () => {
    expect(rows(render(open, "ap-xx-9")).length).toBe(rows(render(open)).length);
    expect(rows(render(open, "<script>")).length).toBe(rows(render(open)).length);
    expect(render(open, "<script>")).not.toContain("<script>alert");
  });

  it("has vCPU, memory, disk and data transfer columns in the comparison table", () => {
    for (const locale of ["bn", "en"] as const) {
      const table =
        /<table class="table compare">[^]*?<\/table>/.exec(render(open, undefined, locale))?.[0] ??
        "";
      expect((table.match(/<th scope="col"/g) ?? []).length).toBe(8);
      expect(table).toContain("vCPU");
      expect(table).toMatch(/2 vCPU/);
    }
  });

  it("says in plain words that VAT and fees are included, in both languages", () => {
    expect(render(open)).toContain("VAT and fees are included in every price.");
    expect(render(open, undefined, "bn")).toContain("VAT ও ফি প্রতিটি মূল্যে অন্তর্ভুক্ত।");
  });

  it("shows no filter and no price when the catalog cannot be read (R16)", () => {
    const page = render(UNAVAILABLE);
    expect(page).not.toContain("?region=");
    expect(page).toContain("Prices cannot be shown now");
  });

  it("has no switch or script: no button, no input, no inline handler", () => {
    const page = render(open, "ap-south-1");
    expect(page).not.toMatch(/<input\b|\sonclick=|<form\b/);
  });
});
