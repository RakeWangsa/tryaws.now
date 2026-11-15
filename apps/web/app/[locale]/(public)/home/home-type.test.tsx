import { beforeAll, describe, expect, it } from "vitest";
import type { Locale } from "@tc/ui/runtime";
import { publicBn } from "../../../../messages/public-bn.ts";
import { publicEn } from "../../../../messages/public-en.ts";
import type { PublicCatalog, PublicOffer } from "../../../../server/public/catalog.ts";
import type { PublicImages } from "../../../../server/public/images.ts";
import { HomeContent } from "../HomeContent.tsx";
import { html } from "../public-states.tsx";
import { NONCE, ORIGIN, openCatalog } from "../public.fixtures.ts";
import { HOME_CARD_LIMIT, homeChooser } from "./home-data.ts";

// WPU-X24: the plan-type row (general purpose, memory optimized, compute optimized) between the image and the
// plan cards. The type of a plan is the sync's `planType`; a plan without one is shown only while no plan of the
// whole catalog has a type (the page keeps working before the sync is rerun), never after (R16).

const NO_IMAGES: PublicImages = { state: "unavailable" };

const render = (catalog: PublicCatalog, locale: Locale, extra: { type?: string } = {}): string =>
  html(
    <HomeContent locale={locale} catalog={catalog} origin={ORIGIN} nonce={NONCE} {...extra} />,
    locale,
  );

type Typed = Record<string, PublicOffer["planType"]>;
const typedCatalog = (base: PublicCatalog, types: Typed): PublicCatalog => {
  if (base.state !== "ok") return base;
  return {
    ...base,
    families: base.families.map((f) => ({
      ...f,
      offers: f.offers.map((o) => {
        const planType = types[o.specs.ramGb ?? ""] ?? null;
        return { ...o, planType, specs: { ...o.specs, ...(planType ? { planType } : {}) } };
      }),
    })),
  };
};

let open: PublicCatalog;
let typed: PublicCatalog;
beforeAll(async () => {
  open = await openCatalog();
  // The fixture has Singapore plans of 1, 4 and 8 GB (and Mumbai 1 GB).
  typed = typedCatalog(open, {
    "1": "general_purpose",
    "4": "compute_optimized",
    "8": "memory_optimized",
  });
});

describe("the plan-type row (WPU-X24)", () => {
  it("offers only the types that have plans here, general purpose first, and shows that type only", () => {
    const c = homeChooser(typed, NO_IMAGES, {});
    expect(c.state === "ok" && c.types).toEqual([
      "general_purpose",
      "memory_optimized",
      "compute_optimized",
    ]);
    expect(c.state === "ok" && c.planType).toBe("general_purpose");
    expect(c.state === "ok" && c.offers.map((o) => o.specs.ramGb)).toEqual(["1"]);
    const mem = homeChooser(typed, NO_IMAGES, { type: "memory_optimized" });
    expect(mem.state === "ok" && mem.offers.map((o) => o.specs.ramGb)).toEqual(["8"]);
    const cpu = homeChooser(typed, NO_IMAGES, { type: "compute_optimized" });
    expect(cpu.state === "ok" && cpu.offers.map((o) => o.specs.ramGb)).toEqual(["4"]);
    // Mumbai has only a general purpose plan: the other two types are not offered there.
    const mumbai = homeChooser(typed, NO_IMAGES, { region: "ap-south-1" });
    expect(mumbai.state === "ok" && mumbai.types).toEqual(["general_purpose"]);
  });

  it("falls back to the first type for an unknown value, and to the first type that has plans", () => {
    for (const bad of ["gpu", "", "General_Purpose", "<script>", "memory_optimized,x"]) {
      const c = homeChooser(typed, NO_IMAGES, { type: bad });
      expect(c.state === "ok" && c.planType, bad).toBe("general_purpose");
    }
    const c = homeChooser(typed, NO_IMAGES, { region: "ap-south-1", type: "memory_optimized" });
    expect(c.state === "ok" && c.planType).toBe("general_purpose");
    const noGeneral = typedCatalog(open, { "1": "memory_optimized", "4": "compute_optimized" });
    const d = homeChooser(noGeneral, NO_IMAGES, {});
    expect(d.state === "ok" && d.types).toEqual(["memory_optimized", "compute_optimized"]);
    expect(d.state === "ok" && d.planType).toBe("memory_optimized");
  });

  it("shows plans of no type under general purpose only while the whole catalog has no typed plan", () => {
    const c = homeChooser(open, NO_IMAGES, {});
    expect(c.state === "ok" && c.types).toEqual(["general_purpose"]);
    expect(c.state === "ok" && c.offers.map((o) => o.specs.ramGb)).toEqual(["1", "4", "8"]);
    expect(c.state === "ok" && c.hiddenUntyped).toBe(0);
    // One typed plan anywhere: the untyped ones are hidden and counted.
    const some = typedCatalog(open, { "8": "memory_optimized" });
    const s = homeChooser(some, NO_IMAGES, {});
    expect(s.state === "ok" && s.types).toEqual(["memory_optimized"]);
    expect(s.state === "ok" && s.offers.map((o) => o.specs.ramGb)).toEqual(["8"]);
    expect(s.state === "ok" && s.hiddenUntyped).toBe(3);
  });

  it("shows at most eight cards of the type and counts all of them", () => {
    const base = typedCatalog(open, { "1": "general_purpose" });
    if (base.state !== "ok") throw new Error("fixture");
    const family = base.families[0]!;
    const first = family.offers.find((o) => o.region === "ap-southeast-1")!;
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...first,
      id: `m-${i}`,
      priceMinor: BigInt(100 + i),
    }));
    const big: PublicCatalog = {
      ...base,
      families: [{ ...family, offers: many }, ...base.families.slice(1)],
    };
    const c = homeChooser(big, NO_IMAGES, {});
    expect(c.state === "ok" && c.offers.length).toBe(HOME_CARD_LIMIT);
    expect(c.state === "ok" && c.total).toBe(11);
  });

  it("renders the row as links with text and a check, in both languages", () => {
    const en = render(typed, "en");
    expect(en).toContain(publicEn.Public.home.typeTitle);
    for (const key of ["general_purpose", "memory_optimized", "compute_optimized"] as const) {
      expect(en).toContain(publicEn.Public.home.types[key]);
      expect(en).toContain(`type=${key}#chooser`);
    }
    expect(en).toContain(publicEn.Public.home.typeDescriptions.general_purpose);
    expect(en).not.toContain(publicEn.Public.home.typeDescriptions.memory_optimized);
    const mem = render(typed, "en", { type: "memory_optimized" });
    expect(mem).toContain(publicEn.Public.home.typeDescriptions.memory_optimized);
    expect(mem).toContain("8 GB · 4 vCPU");
    expect(mem).not.toContain("4 GB · 2 vCPU");
    expect(mem).toContain("fa-check");
    const bn = render(typed, "bn");
    expect(bn).toContain(publicBn.Public.home.typeTitle);
    expect(bn).toContain(publicBn.Public.home.types.compute_optimized);
    expect(Object.keys(publicBn.Public.home.types)).toEqual(
      Object.keys(publicEn.Public.home.types),
    );
    expect(Object.keys(publicBn.Public.home.typeDescriptions)).toEqual(
      Object.keys(publicEn.Public.home.typeDescriptions),
    );
  });

  it("keeps the type in the other links, and the pricing link as it was", () => {
    const mem = render(typed, "en", { type: "memory_optimized" });
    expect(mem).toContain("platform=linux&amp;type=memory_optimized#chooser");
    expect(mem).toContain('href="/en/pricing?region=ap-southeast-1"');
  });
});
