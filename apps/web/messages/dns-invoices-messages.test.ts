import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { DNS_RECORD_TYPES } from "@tc/core";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { dnsBn } from "./dns-bn.ts";
import { dnsEn } from "./dns-en.ts";
import { invoicesBn } from "./invoices-bn.ts";
import { invoicesEn } from "./invoices-en.ts";

// WPU-G4: the messages of /dns, /dns/[id], /invoices and /invoices/[id].

const value = (tree: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);

describe.each([
  ["dns", dnsBn, dnsEn, "Dns"],
  ["invoices", invoicesBn, invoicesEn, "Invoices"],
] as const)("%s messages", (_name, bn, en, namespace) => {
  it("bn and en have the same keys, none empty, no forbidden wording", () => {
    expect(messageKeys(bn)).toEqual(messageKeys(en));
    for (const tree of [bn, en]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const v = value(tree, key);
        expect(typeof v === "string" && v.trim().length > 0, key).toBe(true);
      }
    }
  });
  it("is composed in both locales, with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(webMessages[locale][namespace], locale).toBeDefined();
    }
    expect(JSON.stringify(webMessages.bn[namespace])).toMatch(/[ঀ-৿]/);
  });
  it("shows no account id, ARN or wrong product name (U6, 16.13)", () => {
    for (const tree of [bn, en]) {
      expect(JSON.stringify(tree)).not.toMatch(/arn:aws|\b\d{12}\b|AWS Route 53|Lightsail DNS/);
    }
  });
});

describe("the DNS messages", () => {
  it("name Amazon Route 53 and have a hint for each type the editor offers", () => {
    expect(JSON.stringify(dnsEn)).toContain("Amazon Route 53");
    expect(JSON.stringify(dnsBn)).toContain("Amazon Route 53");
    for (const type of DNS_RECORD_TYPES.filter((t) => t !== "NS")) {
      expect(dnsEn.Dns.detail.form.typeHint, type).toHaveProperty(type);
    }
  });
  it("have a text for every field code that packages/core/dns can answer", () => {
    const codes = [
      "invalid_name",
      "outside_zone",
      "too_long",
      "apex_cname",
      "apex_read_only",
      "srv_name",
      "unsupported_type",
      "out_of_range",
      "required",
      "too_many",
      "single_value",
      "duplicate",
      "points_at_itself",
      "invalid_value",
      "invalid_ipv4",
      "invalid_ipv6",
      "invalid_hostname",
      "invalid_mx",
      "invalid_priority",
      "invalid_srv",
      "invalid_number",
      "invalid_char",
      "already_quoted",
      "empty",
      "invalid_caa",
      "invalid_flags",
      "invalid_tag",
      "exists",
      "cname_conflict",
      "zone_full",
    ];
    for (const code of codes) {
      expect(dnsEn.Dns.field, code).toHaveProperty(code);
      expect(dnsBn.Dns.field, code).toHaveProperty(code);
    }
    expect((webMessages.en["Dns"] as Messages)["field"]).toBeDefined();
  });
});
