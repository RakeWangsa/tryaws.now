import { describe, expect, it, vi } from "vitest";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("/domains", () => {
  it("shows the answer with the price per year and a way to register, then the owned domains", () => {
    const html = render("domains.ready");
    expect(html).toContain("free.com is available");
    expect(html).toContain("1,800.00");
    expect(html).toContain('href="/en/domains/new?name=free.com"');
    expect(html).toContain('href="/en/domains/shop.com"');
    expect(html).toContain('name="q"');
    expect(html).toContain("Amazon Route 53");
  });
  it("says that a TLD with extra parameters goes to review", () => {
    const html = render("domains.review");
    expect(html).toContain("needs extra information");
    expect(html).toContain("Needs review");
  });
  it("offers no register button for a taken name and says the search is down when it is", () => {
    expect(render("domains.taken")).not.toContain("/domains/new");
    expect(render("domains.search_unavailable")).toContain("does not work right now");
  });
  it("the flag-off state says soon and offers nothing that could buy (R12)", () => {
    const html = render("domains.flag_off");
    expect(html).toContain("coming soon");
    expect(html).not.toContain("/domains/new");
    expect(html).not.toContain("<form");
  });
  it("is in Bengali in the bn locale and the tables fit a phone (360 px)", () => {
    expect(render("domains.ready", "bn")).toMatch(/[ঀ-৿]/);
    const html = render("domains.ready");
    expect(html).toContain("table-responsive-lg");
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });
});

describe("/domains/new", () => {
  it("posts the contact fields, the name and the typed confirmation and nothing about AWS (R11)", () => {
    const html = render("domain_new.ready");
    for (const name of [
      "name",
      "confirmName",
      "contactType",
      "firstName",
      "lastName",
      "email",
      "phoneNumber",
      "addressLine1",
      "city",
      "state",
      "countryCode",
      "zipCode",
    ]) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).toMatch(/name="name"[^>]*value="free.com"|value="free.com"[^>]*name="name"/);
    expect(html).toContain("Type exactly: free.com");
    expect(html).toContain("not refundable");
    expect(html).not.toMatch(/name="(awsName|productId|hostedZoneId)"/);
  });
  it("tells a review TLD that our team checks first", () => {
    expect(render("domain_new.review")).toContain("our team checks before it is registered");
  });
  it("covers invalid, flag off and KYC", () => {
    expect(render("domain_new.invalid")).toContain('href="/en/domains"');
    expect(render("domain_new.flag_off")).not.toContain("<form");
    expect(render("domain_new.kyc_required")).toContain("Finish your account setup before you buy");
  });
});

describe("/domains/[name]", () => {
  it("shows the state, expiry, the verification state, name servers and the renewal switch", () => {
    const html = render("domain_detail.ready");
    expect(html).toContain("Waiting for e-mail check");
    expect(html).toContain("follow it");
    expect(html).toContain("ns-1.example-dns.test");
    expect(html).toContain("Auto-renew is off");
    expect(html).toContain('name="enabled"');
    expect(html).toContain('value="on"');
    expect(render("domain_detail.verified")).toContain("Auto-renew is on");
  });
  it("offers the verification e-mail again only while the check is open, and the name servers only for a registered domain (WPU-B2)", () => {
    const open = render("domain_detail.ready");
    expect(open).toContain("Send the e-mail again");
    expect(open).toContain('name="nameServers"');
    expect(open).toContain('name="confirmName"');
    // The check is done: no resend button, the name server form stays.
    const done = render("domain_detail.verified");
    expect(done).not.toContain("Send the e-mail again");
    expect(done).toContain('name="nameServers"');
    // A domain that is not registered yet has neither.
    expect(render("domain_detail.not_found")).not.toContain('name="nameServers"');
    expect(render("domain_detail.ready", "bn")).toContain("নেম সার্ভার বদল");
    expect(open).not.toContain("style=");
  });
  it("has no delete anywhere: a domain expires (R13)", () => {
    const html = render("domain_detail.ready");
    expect(html).toContain("We never delete a domain");
    expect(html).not.toMatch(/delete (domain|this)|Delete domain|destroy/i);
  });
  it("answers like a missing one when the domain is not found (R8)", () => {
    expect(render("domain_detail.not_found")).toContain("Domain not found");
  });
});
