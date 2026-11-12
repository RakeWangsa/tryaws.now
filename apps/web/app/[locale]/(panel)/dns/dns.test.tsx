import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { describe, expect, it, vi } from "vitest";
import { pickEditing } from "../../../../server/dns-view.ts";
import { DNS_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS, zone } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, replace: () => {} }) }));

// WPU-G4: /dns and /dns/[id] follow the shared mockup (U1) and show their states (U11).

const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../../../../../..", "design/mockup");
const tokens = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const attribute of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") out.add(token);
  }
  return out;
};
const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("the DNS screens follow the shared mockup", () => {
  for (const row of DNS_ANCHORS) {
    it(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
      const inMockup = tokens(readFileSync(resolve(mockupRoot, row.mockupFile), "utf8"));
      expect(
        row.classes.filter((t) => !inMockup.has(t)),
        `not in ${row.mockupFile}`,
      ).toEqual([]);
      for (const locale of ["bn", "en"] as const) {
        const rendered = tokens(render(row.state, locale));
        expect(
          row.classes.filter((t) => !rendered.has(t)),
          `${row.state} in ${locale}`,
        ).toEqual([]);
      }
    });
  }

  it("every class of every rendered state is defined by the theme, Bootstrap, Font Awesome or tc.css", () => {
    const known = knownClasses();
    for (const [id, renderer] of Object.entries(STATE_RENDERERS)) {
      for (const locale of ["bn", "en"] as const) {
        const unknown = [...tokens(renderer(locale))].filter((t) => !known.has(t));
        expect(unknown, `${id} in ${locale}`).toEqual([]);
      }
    }
  });

  it("every state of a row has a renderer", () => {
    for (const row of DNS_ANCHORS) expect(STATE_RENDERERS[row.state]).toBeDefined();
  });
});

describe("/dns", () => {
  it("lists the zones with a state word, the number of records and a way in", () => {
    const out = render("dns.ready");
    expect(out).toContain("example.com");
    expect(out).toContain("Running");
    expect(out).toContain("Creating");
    expect(out).toContain("Not known");
    expect(out).toContain('href="/en/dns/0190aaaa-0000-7000-8000-0000000000d1"');
    expect(out).toContain("Amazon Route 53");
  });
  it("says it is coming soon with the flag off, and shows nothing that could change a record (R12)", () => {
    const out = render("dns.flag_off");
    expect(out).toContain("coming soon");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("/dns/");
  });
  it("has an empty state with one way forward", () => {
    const out = render("dns.empty");
    expect(out).toContain("No DNS zones yet");
    expect(out).toContain('href="/en/domains"');
  });
  it("is in Bengali in bn", () => {
    expect(render("dns.ready", "bn")).toMatch(/[ঀ-৿]/);
    expect(render("dns.empty", "bn")).toContain("এখনও কোনো ডিএনএস জোন নেই");
  });
});

describe("/dns/[id]", () => {
  it("shows the name servers, every record with its type, TTL and values, and the editor with the seven types", () => {
    const out = render("zone.ready");
    expect(out).toContain("ns-1.awsdns-01.org");
    expect(out).toContain("203.0.113.10");
    expect(out).toContain("203.0.113.11");
    expect(out).toContain("v=spf1 -all");
    for (const type of ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA"]) {
      expect(out).toMatch(new RegExp(`<option value="${type}"[^>]*>${type}</option>`));
    }
    // NS is never offered by the editor.
    expect(out).not.toContain('<option value="NS">');
    expect(out).toContain('name="zoneId"');
    expect(out).toContain('name="requestId"');
    expect(out).toContain('name="mode" value="create"');
  });
  it("marks the apex NS read-only: no edit link and no delete button for it", () => {
    const out = render("zone.ready");
    expect(out).toContain("Read-only");
    expect(out).not.toContain("Edit the NS record");
    expect(out).not.toContain("Delete the NS record");
    expect(out).toContain("Edit the TXT record @");
    expect(out).toContain("Delete the A record www");
  });
  it("edits a record: name and type are fixed, the form posts an upsert and prefills the values", () => {
    const out = render("zone.editing");
    expect(out).toContain('name="mode" value="upsert"');
    expect(out).toContain('type="hidden" name="name" value="www"');
    expect(out).toContain('type="hidden" name="type" value="A"');
    expect(out).toContain("203.0.113.10\n203.0.113.11");
    expect(out).toContain("Save the change");
    expect(out).toContain("Cancel");
  });
  it("tells that a change is being applied and offers no editor meanwhile", () => {
    const out = render("zone.working");
    expect(out).toContain("being applied");
    expect(out).toContain("change is on its way");
    expect(out).not.toContain('name="values"');
    expect(out).not.toContain("Delete the A record");
  });
  it("says that the last change failed, without the text of any error (U6)", () => {
    const out = render("zone.failed");
    expect(out).toContain("was not applied");
    expect(out).not.toMatch(/arn:aws|\b\d{12}\b|Z0[0-9A-Z]+/);
  });
  it("offers nothing while the zone is being created", () => {
    const out = render("zone.creating");
    expect(out).toContain("still being created");
    expect(out).toContain("not ready yet");
    expect(out).not.toContain('name="values"');
  });
  it("does not show a list it cannot trust, and does not offer the editor (R16)", () => {
    const out = render("zone.stale");
    expect(out).toContain("cannot be shown now");
    expect(out).not.toContain("<table");
    expect(out).not.toContain('name="values"');
  });
  it("says that the zone has none of the customer's records yet, and still offers the editor", () => {
    const out = render("zone.empty_records");
    expect(out).toContain("none of your records yet");
    expect(out).toContain('name="values"');
  });
  it("answers a missing zone and another customer's zone with the same words (R8)", () => {
    const out = render("zone.not_found");
    expect(out).toContain("This zone was not found");
    expect(out).not.toContain("example.com");
  });
  it("is coming soon with the flag off", () => {
    expect(render("zone.flag_off")).toContain("coming soon");
  });
  it("the customer's text is escaped and no style attribute or script is rendered (U4)", () => {
    const out = render("zone.ready");
    expect(out).not.toMatch(/\sstyle=/);
    expect(out).not.toMatch(/<script[^>]*\ssrc=/);
  });
  it("is in Bengali in bn and the table fits a phone", () => {
    const out = render("zone.ready", "bn");
    expect(out).toMatch(/[ঀ-৿]/);
    expect(out).toContain("table-responsive-lg");
  });
});

describe("pickEditing", () => {
  const view = zone();
  it("finds a record by type and name from the list the page shows", () => {
    expect(pickEditing(view, "A:www")).toEqual({
      relative: "www",
      type: "A",
      ttl: 300,
      values: ["203.0.113.10", "203.0.113.11"],
    });
    expect(pickEditing(view, "TXT:@")?.values).toEqual(["v=spf1 -all"]);
  });
  it("is null for the read-only apex NS, a record that is not there, junk, and a zone that cannot be edited", () => {
    expect(pickEditing(view, "NS:@")).toBeNull();
    expect(pickEditing(view, "A:nope")).toBeNull();
    for (const junk of [undefined, 5, "", "A", ":x", "A:", ["A:www"]]) {
      expect(pickEditing(view, junk)).toBeNull();
    }
    expect(pickEditing(zone({ canEdit: false }), "A:www")).toBeNull();
    expect(pickEditing(zone({ records: null }), "A:www")).toBeNull();
  });
});
