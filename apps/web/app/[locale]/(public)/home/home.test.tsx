import { beforeAll, describe, expect, it } from "vitest";
import type { Locale } from "@tc/ui/runtime";
import { publicBn } from "../../../../messages/public-bn.ts";
import { publicEn } from "../../../../messages/public-en.ts";
import type { PublicCatalog, PublicOffer } from "../../../../server/public/catalog.ts";
import { HomeContent } from "../HomeContent.tsx";
import { html } from "../public-states.tsx";
import { NONCE, ORIGIN, UNAVAILABLE, openCatalog } from "../public.fixtures.ts";
import { HOME_CARD_LIMIT, HOME_SERVICES, homeChooser, homeServices } from "./home-data.ts";

// WPU-X18: the simple home page. It is a heading, the list of services and a read-only preview of the
// create-instance choice. The tests pin the order of the services, that no service is promised whose
// flag is off (R12, R16), that the choice is made by links with a query and no script, that the prices
// are the engine's output in taka only (WPU-X16), and that the button goes to login or to the panel.

const ALL_FLAGS = [
  "linux_instance",
  "windows_instance",
  "database",
  "disk",
  "static_ip",
  "backup",
  "cdn",
  "dns_zone",
  "domain",
  "bucket",
  "load_balancer",
  "container_service",
];

const render = (
  catalog: PublicCatalog,
  locale: Locale,
  extra: { region?: string; platform?: string; signedIn?: boolean } = {},
): string =>
  html(
    <HomeContent locale={locale} catalog={catalog} origin={ORIGIN} nonce={NONCE} {...extra} />,
    locale,
  );
const text = (page: string): string =>
  page
    .replace(/<script[^]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");

let open: PublicCatalog;
let everything: PublicCatalog;
let none: PublicCatalog;
let withWindows: PublicCatalog;
beforeAll(async () => {
  open = await openCatalog();
  everything = await openCatalog(ALL_FLAGS);
  none = await openCatalog([]);
  withWindows = await openCatalog(["linux_instance", "windows_instance"]);
});

describe("the services list (WPU-X18)", () => {
  it("lists the seven services in the order of the owner's request, in both languages", () => {
    expect(HOME_SERVICES.map((s) => s.key)).toEqual([
      "instances",
      "containers",
      "databases",
      "networking",
      "storage",
      "domains",
      "snapshots",
    ]);
    expect(Object.values(publicEn.Public.home.services)).toEqual([
      "Instances (Cloud Servers)",
      "Containers",
      "Databases",
      "Networking",
      "Storage",
      "Domains & DNS",
      "Snapshots",
    ]);
    for (const locale of ["bn", "en"] as const) {
      const page = render(open, locale);
      const tree = (locale === "bn" ? publicBn : publicEn).Public.home.services;
      const marks = Object.values(tree).map((name) => page.indexOf(name.replace("&", "&amp;")));
      expect(marks.every((i) => i >= 0)).toBe(true);
      expect([...marks].sort((a, b) => a - b)).toEqual(marks);
    }
  });

  it("calls a service open only when its flag is on, and says coming soon next to the rest (R12)", () => {
    const states = homeServices(open);
    expect(states.filter((s) => s.open).map((s) => s.key)).toEqual(["instances", "databases"]);
    const page = render(open, "en");
    expect((page.match(/badge bg-success/g) ?? []).length).toBe(2);
    expect((page.match(/Coming soon/g) ?? []).length).toBe(5);
    expect(homeServices(everything).every((s) => s.open)).toBe(true);
    expect(homeServices(none).some((s) => s.open)).toBe(false);
    expect((render(none, "en").match(/badge bg-success/g) ?? []).length).toBe(0);
  });

  it("links an open service to its public page and nothing else", () => {
    const page = render(open, "en");
    expect(page).toContain('href="/en/products/cloud-servers"');
    expect(page).toContain('href="/en/products/databases"');
    expect(page).not.toContain('href="/en/products/containers"');
    const states = homeServices(everything);
    expect(states.find((s) => s.key === "snapshots")?.path).toBeNull();
    expect(states.find((s) => s.key === "networking")?.path).toBe("/products/load-balancers");
    expect(states.find((s) => s.key === "domains")?.path).toBe("/products/dns");
  });

  it("a state is told by an icon and a word, not by color alone (U11)", () => {
    const page = render(open, "en");
    expect(page).toMatch(/badge bg-success tc-svc-badge"><i class="fas fa-check"[^>]*><\/i> Open</);
    expect(page).toMatch(
      /badge bg-secondary tc-svc-badge"><i class="fas fa-clock"[^>]*><\/i> Coming soon</,
    );
  });

  it("shows no list and no price when the catalog cannot be read (R16)", () => {
    expect(homeServices(UNAVAILABLE)).toEqual([]);
    const page = render(UNAVAILABLE, "en");
    expect(page).not.toContain("badge bg-success");
    expect(page).toContain("Prices cannot be shown now");
    expect(text(page)).not.toMatch(/[৳$]/);
  });
});

describe("the instance chooser (WPU-X18)", () => {
  it("starts at the first platform and the first location that have plans, cheapest first", () => {
    const c = homeChooser(open, {});
    expect(c.state).toBe("ok");
    if (c.state !== "ok") return;
    expect(c.platform).toBe("linux");
    expect(c.platforms).toEqual(["linux"]);
    expect(c.regions).toEqual(["ap-southeast-1", "ap-south-1"]);
    expect(c.region).toBe("ap-southeast-1");
    expect(c.offers.map((o) => o.specs.ramGb)).toEqual(["1", "4", "8"]);
    expect(c.offers.every((o) => o.region === "ap-southeast-1")).toBe(true);
  });

  it("follows ?region= and falls back to the first location for an unknown value", () => {
    const mumbai = homeChooser(open, { region: "ap-south-1" });
    expect(mumbai.state === "ok" && mumbai.offers.map((o) => o.region)).toEqual(["ap-south-1"]);
    for (const bad of ["us-east-1", "", "ap-south-1,ap-southeast-1", "<script>"]) {
      const c = homeChooser(open, { region: bad });
      expect(c.state === "ok" && c.region).toBe("ap-southeast-1");
    }
  });

  it("offers Windows only when the catalog has Windows plans, and follows ?platform=", () => {
    const win = homeChooser(withWindows, { platform: "windows" });
    expect(win.state === "ok" && win.platforms).toEqual(["linux", "windows"]);
    expect(win.state === "ok" && win.platform).toBe("windows");
    expect(win.state === "ok" && win.offers.every((o) => o.family === "windows_instance")).toBe(
      true,
    );
    const noWin = homeChooser(open, { platform: "windows" });
    expect(noWin.state === "ok" && noWin.platform).toBe("linux");
    expect(render(open, "en")).not.toContain("Microsoft Windows");
    expect(render(withWindows, "en")).toContain("Microsoft Windows");
  });

  it("shows the database family nowhere in the instance chooser", () => {
    const c = homeChooser(everything, {});
    expect(c.state === "ok" && c.offers.some((o) => o.family === "database")).toBe(false);
  });

  it("is closed when no instance family is open and unavailable when the catalog is", () => {
    expect(homeChooser(none, {}).state).toBe("closed");
    expect(homeChooser(UNAVAILABLE, {}).state).toBe("unavailable");
    expect(render(none, "en")).toContain("No plan is open yet");
  });

  it("makes each choice a plain link with a query, no script and no form (U2, U7)", () => {
    const page = render(withWindows, "en", { region: "ap-south-1", platform: "linux" });
    expect(page).toContain('href="/en?region=ap-southeast-1&amp;platform=linux#chooser"');
    expect(page).toContain('href="/en?region=ap-south-1&amp;platform=linux#chooser"');
    expect(page).toContain('href="/en?region=ap-south-1&amp;platform=windows#chooser"');
    expect(page).not.toMatch(/<form\b|<select\b|onclick|<input/i);
    expect(page.replace(/<script type="application\/ld\+json"[^]*?<\/script>/g, "")).not.toContain(
      "<script",
    );
    expect(page).not.toMatch(/style="/);
  });

  it("writes the AWS Region with its name and code and marks the current choice by a word (16.13, U11)", () => {
    const page = render(open, "en");
    expect(page).toContain("AWS Region: Asia Pacific (Singapore)");
    expect(page).toContain("ap-southeast-1");
    expect(page).toMatch(/Singapore<span class="visually-hidden"> \(selected\)<\/span>/);
    const bn = render(open, "bn", { region: "ap-south-1" });
    expect(bn).toContain("AWS Region: Asia Pacific (Mumbai)");
  });

  it("shows the plans as cards with taka prices of the catalog and no dollar (WPU-X16)", () => {
    const page = render(open, "en");
    expect((page.match(/class="tc-mini /g) ?? []).length).toBe(3);
    expect((page.match(/class="tc-mini-price[^"]*"><span>৳[\d,]+<\/span>/g) ?? []).length).toBe(3);
    expect(page).toContain("/ 30 days");
    expect(page).not.toMatch(/icon-cpu|list-info|plans badge/);
    expect(text(page)).not.toMatch(/\$|USD|dollar/i);
    expect(text(render(open, "bn"))).not.toMatch(/\$|USD|ডলার/i);
  });
});

describe("the create button (WPU-X18, R1, U12)", () => {
  const login = "/en/login?next=%2Fservers%2Fnew";

  it("goes to login with a next target of the allow-list when the visitor is not signed in", () => {
    const page = render(open, "en");
    expect((page.match(/Create instance/g) ?? []).length).toBe(3);
    expect(page.split(`href="${login}"`).length - 1).toBe(3);
    expect(page).toContain('href="/en/login"');
    expect(page).toContain('href="/en/signup"');
  });

  it("goes to the create screen of the panel when the visitor is signed in", () => {
    const page = render(open, "en", { signedIn: true });
    expect(page).not.toContain(login);
    expect(page.split('href="/en/servers/new"').length - 1).toBe(3);
    expect(page).toContain('href="/en/dashboard"');
    expect(page).not.toContain('href="/en/signup"');
  });

  it("creates nothing here: no form, no customer data, and it says where creating happens", () => {
    const page = render(open, "en");
    expect(page).not.toMatch(/<form\b|<input/i);
    expect(text(page)).toContain("Nothing is created on this page");
  });
});

describe("heading, claims and wording (WPU-X18)", () => {
  it("has one h1, the statement once, and the two buttons of a visitor", () => {
    for (const locale of ["bn", "en"] as const) {
      const page = render(open, locale);
      const tree = locale === "bn" ? publicBn.Public : publicEn.Public;
      expect((page.match(/<h1[\s>]/g) ?? []).length).toBe(1);
      expect(page).toContain(tree.home.heroTitle);
      expect(text(page).split(tree.entity.statement.slice(0, 40)).length - 1).toBe(1);
    }
  });

  it("is a short page: the marketing sections of WPU-X13 are gone", () => {
    const page = render(everything, "en");
    for (const gone of [
      "tc-hero-panel",
      "tc-step-number",
      "table compare",
      'tc-location-code">ap-south-1</p>',
      "accordion faq",
      "getready",
      "<svg",
      "<img",
    ]) {
      expect(page, gone).not.toContain(gone);
    }
  });

  it("has no invented number, rating, uptime or superlative, and no AWS logo wording", () => {
    for (const locale of ["bn", "en"] as const) {
      const body = text(render(everything, locale));
      for (const m of body.match(/[\d০-৯][\d০-৯.]*\s?%/g) ?? []) {
        expect(m.replace(/\s/g, ""), locale).toMatch(/^(100%|১০০%)$/);
      }
      expect(body, locale).not.toMatch(
        /uptime|SLA|cheapest|best|testimonial|bKash|Nagad|customers|সবচেয়ে সস্তা|আপটাইম/i,
      );
      expect(body, locale).not.toMatch(/AWS Lightsail|Powered by AWS/i);
    }
  });

  it("names Amazon Lightsail and keeps the long AWS statement once", () => {
    const body = text(render(open, "en"));
    expect(body).toContain("Amazon Lightsail");
    const long =
      "Every server, database and storage resource you buy here is an Amazon Lightsail resource running in an AWS Region (Singapore or Mumbai).";
    expect(body.split(long).length - 1).toBe(1);
  });

  it("shows no AWS account id, ARN or internal name", () => {
    const body = text(render(everything, "en"));
    expect(body).not.toMatch(/arn:aws|\b\d{12}\b|\btc-[a-z]+-[a-z0-9]+/);
  });
});

describe("compact cards, the limit and the titles (WPU-X18 round 2)", () => {
  const offer = (n: number, ram: string, vcpus: number, minor: bigint): PublicOffer => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    family: "linux_instance",
    region: "ap-southeast-1",
    priceMinor: minor,
    specs: { vcpus, ramGb: ram, diskGb: 40 + n, transferGb: 1000 + n },
    numerals: "latn",
  });
  // 12 plans; "4" GB exists twice with a different vCPU count and price (a general purpose and a
  // compute-optimized plan of Lightsail have the same memory).
  const many: PublicOffer[] = [
    ...["0.5", "1", "2", "4", "8", "16", "32", "64", "96", "128"].map((ram, i) =>
      offer(i, ram, 2, BigInt(100000 + i * 10000)),
    ),
    offer(20, "4", 4, 205000n),
    offer(21, "8", 8, 305000n),
  ];
  const big: PublicCatalog = {
    state: "ok",
    families: [{ family: "linux_instance", offers: many }],
    open: [],
    domainsOpen: false,
    flagOn: (key) => key === "linux_instance",
  };

  it("shows at most eight cards and one link to the pricing page of the same location", () => {
    const c = homeChooser(big, {});
    expect(c.state === "ok" && c.offers.length).toBe(HOME_CARD_LIMIT);
    expect(c.state === "ok" && c.total).toBe(12);
    const page = render(big, "en");
    expect((page.match(/class="tc-mini /g) ?? []).length).toBe(8);
    expect((page.match(/See all plans and prices/g) ?? []).length).toBe(1);
    expect(page).toContain('href="/en/pricing?region=ap-southeast-1"');
  });

  it("gives every card a different title: the memory size and the vCPU count", () => {
    const page = render(big, "en");
    const titles = [...page.matchAll(/class="tc-mini-title[^"]*">([^<]*)</g)].map((m) => m[1]);
    expect(titles.length).toBe(8);
    expect(new Set(titles).size).toBe(8);
    expect(titles[0]).toBe("0.5 GB · 2 vCPU");
    const lines = [...page.matchAll(/class="tc-mini-line[^"]*">([^<]*)</g)].map((m) => m[1]);
    expect(lines[0]).toBe("40 GB SSD · 1000 GB transfer");
  });

  it("sorts by price and keeps the price in whole taka with the period", () => {
    const c = homeChooser(big, {});
    if (c.state !== "ok") throw new Error("not ok");
    for (let i = 1; i < c.offers.length; i++) {
      expect(c.offers[i]!.priceMinor >= c.offers[i - 1]!.priceMinor).toBe(true);
    }
    expect(text(render(big, "bn"))).toContain("/ ৩০ দিন");
  });

  it("lists the services as one line each (name and state) and has no icon rows in a card", () => {
    const page = render(open, "en");
    expect((page.match(/class="tc-svc-item"/g) ?? []).length).toBe(7);
    expect(page).not.toContain("list-info");
  });

  it("is a short page: one sentence under the heading, the answer block low in the trust line", () => {
    const page = render(open, "en");
    const hero = /<section class="top-header[^]*?<\/section>/.exec(page)?.[0] ?? "";
    expect((hero.match(/<p\b/g) ?? []).length).toBe(1);
    expect(hero).not.toContain("subheading");
    expect(page.indexOf('class="subheading')).toBeGreaterThan(page.indexOf('id="chooser"'));
  });
});

describe("digits and names (WPU-X18 round 3)", () => {
  it("writes the numbers of a card title and spec line in the market digits, units unchanged", () => {
    const bn = render(open, "bn");
    expect(bn).toContain("৪ GB · ২ vCPU");
    expect(bn).toContain("৮০ GB SSD · ৪০০০ GB ট্রান্সফার");
    expect(bn).not.toMatch(/tc-mini-(title|line)[^>]*>[^<]*[0-9]/);
    const en = render(open, "en");
    expect(en).toContain("4 GB · 2 vCPU");
    expect(en).toContain("80 GB SSD · 4000 GB transfer");
    expect(en).not.toMatch(/tc-mini-(title|line)[^>]*>[^<]*[০-৯]/);
  });

  it("gives every service name the same class, so linked and unlinked names weigh the same", () => {
    const page = render(open, "en");
    expect((page.match(/tc-svc-name/g) ?? []).length).toBe(7);
    expect(page).toMatch(/<a [^>]*class="golink mergecolor tc-svc-name"/);
    expect(page).toMatch(/<span class="mergecolor tc-svc-name">Containers<\/span>/);
  });
});
