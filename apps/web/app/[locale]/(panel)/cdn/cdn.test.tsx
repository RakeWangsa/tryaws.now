import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CDN_ID, ORIGIN_ID, PLAN_SMALL, REQUEST_ID } from "./cdn.fixtures.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("/cdn", () => {
  it("lists the distributions with the origin, the default domain the customer needs, and the state", () => {
    const html = render("cdn.ready");
    expect(html).toContain("d1a2b3c4d5e6f7.cloudfront.net");
    expect(html).toContain(`href="/en/cdn/${CDN_ID}"`);
    expect(html).toContain("Cloud Server: web-1");
    expect(html).toContain("Object Storage: assets");
    expect(html).toContain("Amazon Lightsail CDN distribution");
    expect(html).toContain('href="/en/cdn/new"');
  });

  it("is in Bengali in the bn locale", () => {
    expect(render("cdn.ready", "bn")).toMatch(/[ঀ-৿]/);
    expect(render("cdn.empty", "bn")).toMatch(/[ঀ-৿]/);
  });

  it("the flag-off state says soon and offers nothing that could buy (R12)", () => {
    const html = render("cdn.flag_off");
    expect(html).toContain("CDN is coming soon");
    expect(html).not.toContain("/cdn/new");
    expect(html).not.toContain("<a ");
  });

  it("the empty state offers the first CDN; the table fits a phone (360 px)", () => {
    expect(render("cdn.empty")).toContain('href="/en/cdn/new"');
    const html = render("cdn.ready");
    expect(html).toContain("table-responsive-lg");
    // No fixed pixel width anywhere: the layout is the grid of the theme.
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });
});

describe("/cdn/new", () => {
  it("posts the five fields of a distribution and nothing about a domain or a certificate (R11)", () => {
    const html = render("cdn_new.ready");
    for (const name of ["originId", "productId", "cacheBehavior", "displayName", "region"]) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).toMatch(/name="region"[^>]*value="us-east-1"|value="us-east-1"[^>]*name="region"/);
    expect(html).not.toMatch(/name="(domain|certificate|certificateName|alternativeDomainNames)"/);
    expect(html).toContain(`value="${PLAN_SMALL}"`);
    expect(html).toContain(`value="${ORIGIN_ID}"`);
  });

  it("shows the exact price from the server and the origin kinds", () => {
    const html = render("cdn_new.ready");
    expect(html).toContain("690.00");
    expect(html).toContain("Cloud Server: web-1");
  });

  it("each state that cannot buy says why and what to do next", () => {
    expect(render("cdn_new.flag_off")).toContain("CDN is coming soon");
    expect(render("cdn_new.kyc_required")).toContain("Verify your identity first");
    expect(render("cdn_new.empty")).toContain("No plan is for sale right now");
    const noOrigin = render("cdn_new.no_origin");
    expect(noOrigin).toContain("No origin for a CDN yet");
    expect(noOrigin).toContain('href="/en/servers"');
  });
});

describe("/cdn/[id]", () => {
  it("shows the origin, the cache behavior, the default domain and three tabs", () => {
    const html = render("cdn_detail.ready");
    expect(html).toContain("site-cdn");
    expect(html).toContain("d1a2b3c4d5e6f7.cloudfront.net");
    expect(html).toContain("Cloud Server: web-1");
    expect(html).toContain("Cache content");
    for (const tab of ["Overview", "Settings", "Delete"]) expect(html).toContain(tab);
  });

  it("the switch form carries the id, the request id (R7) and the next state", () => {
    const on = render("cdn_detail.ready");
    expect(on).toContain(`name="cdnId" value="${CDN_ID}"`);
    expect(on).toContain(`name="requestId" value="${REQUEST_ID}"`);
    expect(on).toContain('name="enabled" value="off"');
    const off = render("cdn_detail.stopped");
    expect(off).toContain('name="enabled" value="on"');
    expect(off).toContain("Turn on");
  });

  it("a distribution that is still being created has no domain yet and no switch", () => {
    const html = render("cdn_detail.pending_domain");
    expect(html).toContain("The domain will show here once it is created.");
    expect(html).toContain("cannot be turned on or off in this state");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  it("has tabs for the cache behaviour, the origin, the plan and the domain (WPU-G8)", () => {
    const html = render("cdn_detail.ready");
    for (const tab of [
      "Cache behaviour",
      "Origin",
      "Capacity and plan",
      "Domain and certificate",
    ]) {
      expect(html).toContain(tab);
    }
  });

  it("the plan tab changes at the next renewal: a plan is a catalog product, nothing is charged now, a pending change shows its price and a cancel", () => {
    const html = render("cdn_detail.pending_plan");
    expect(html).toContain("nothing is charged now");
    expect(html).toContain("Next renewal: Dec 10, 2026");
    expect(html).toContain("Starts at the next renewal: Medium, renewal price ৳1,390.00.");
    expect(html).toMatch(/name="cancel" value="yes"/);
    expect(html).toMatch(/name="productId"/);
    expect(html).not.toMatch(/name="(bundle|bundleId|price|amount)"/);
  });

  it("the cache tab shows the saved policy with closed lists and one text box for the path rules", () => {
    const html = render("cdn_detail.cache_saved");
    expect(html).toContain("images/*=cache");
    expect(html).toContain('name="allowedMethods"');
    expect(html).toContain("GET,HEAD,OPTIONS,PUT,PATCH,POST,DELETE");
    expect(html).toContain("Now: default Cache, default TTL 3600 seconds.");
  });

  it("the origin tab offers the customer's own resources by id and no free text; with none it says so", () => {
    const html = render("cdn_detail.ready");
    expect(html).toMatch(/name="originId"/);
    expect(html).not.toMatch(/<input[^>]*name="originId"/);
    expect(html).toContain("Bucket: assets");
    expect(render("cdn_detail.no_other_origin")).toContain(
      "There is no other running server, load balancer or bucket to change to.",
    );
  });

  it("the domain tab shows the validation records of a pending certificate and the check button", () => {
    const html = render("cdn_detail.domain_pending");
    expect(html).toContain("cdn.example.com");
    expect(html).toContain("_a.cdn.example.com.");
    expect(html).toContain("Waiting for validation");
    expect(html).toContain("Check status and attach");
    expect(html).not.toContain("Request certificate");
  });

  it("another customer's CDN and a missing one show the same not-found state", () => {
    const html = render("cdn_detail.not_found");
    expect(html).toContain("CDN not found");
    expect(html).toContain('href="/en/cdn"');
  });
});

describe("R1: the web app never reaches AWS", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no CDN screen or CDN server file imports packages/aws or an AWS SDK client", () => {
    const server = resolve(here, "../../../../server");
    const all = [
      ...files(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("cdn.test.tsx")),
      ...readdirSync(server)
        .filter((f) => f.startsWith("cdn-") && f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(server, f)),
    ];
    expect(all.length).toBeGreaterThan(10);
    for (const file of all) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tc\/aws|@aws-sdk\//);
    }
  });
});
