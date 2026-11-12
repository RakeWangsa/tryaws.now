import { describe, expect, it, vi } from "vitest";
import { dbParametersOf } from "../../../../server/console-view.ts";
import { html } from "../_family/render-html.tsx";
import { CertificateChange } from "./CertificateChange.tsx";
import { DatabaseParameters } from "./DatabaseParameters.tsx";
import { CertificatePanel } from "./PlanAndCertForms.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// WPU-G11: the forms to remove or replace a certificate and the Parameters tab of a database. States
// proved here: the forms with the ids, the typed domain, the loading-free server markup, the empty,
// last-known, reboot-pending and inactive states, bn and en, no style attribute, no AWS wording.
const ID = "0190aaaa-0000-7000-8000-0000000000e1";
const R1 = "0190aaaa-0000-7000-8000-0000000000f1";
const R2 = "0190aaaa-0000-7000-8000-0000000000f2";
const R3 = "0190aaaa-0000-7000-8000-0000000000f3";
const R4 = "0190aaaa-0000-7000-8000-0000000000f4";
const noop = async () => ({});
const issued = {
  domain: "shop.example.com",
  status: "ISSUED",
  attached: true,
  records: [],
};

describe("remove and replace the certificate", () => {
  it("has two forms with their own request ids, the typed domain and no style attribute (R7, U10)", () => {
    const out = html(
      <CertificateChange
        removeAction={noop}
        replaceAction={noop}
        idField="cdnId"
        resourceId={ID}
        removeRequestId={R1}
        replaceRequestId={R2}
        domain="shop.example.com"
        allowed
      />,
      "en",
    );
    expect(out).toContain(`name="cdnId" value="${ID}"`);
    expect(out).toContain(`name="requestId" value="${R1}"`);
    expect(out).toContain(`name="requestId" value="${R2}"`);
    expect(out.match(/name="confirmName"/g)).toHaveLength(2);
    expect(out).toContain('name="domain"');
    expect(out).toContain("type the current domain: shop.example.com");
    expect(out).toContain("Replace certificate");
    expect(out).toContain("Remove certificate");
    expect(out).not.toContain("turned off before the certificate goes");
    expect(out).not.toMatch(/ style="/);
    expect(out).not.toMatch(/arn:aws|\b\d{12}\b/);
  });

  it("a load balancer says that the HTTPS redirect is turned off first; a state that is not active disables the forms", () => {
    const lb = html(
      <CertificateChange
        removeAction={noop}
        replaceAction={noop}
        idField="loadBalancerId"
        resourceId={ID}
        removeRequestId={R1}
        replaceRequestId={R2}
        domain="shop.example.com"
        allowed={false}
        loadBalancer
      />,
      "en",
    );
    expect(lb).toContain("turned off before the certificate goes");
    expect(lb).toContain("disabled");
    const bn = html(
      <CertificateChange
        removeAction={noop}
        replaceAction={noop}
        idField="containerId"
        resourceId={ID}
        removeRequestId={R1}
        replaceRequestId={R2}
        domain="shop.example.com"
        allowed
      />,
      "bn",
    );
    expect(bn).toMatch(/[ঀ-৿]/);
    expect(bn).toContain("shop.example.com");
  });

  it("the certificate panel offers them only when a certificate is saved", () => {
    const props = {
      requestAction: noop,
      refreshAction: noop,
      removeAction: noop,
      replaceAction: noop,
      idField: "cdnId" as const,
      resourceId: ID,
      requestId: R1,
      refreshRequestId: R2,
      removeRequestId: R3,
      replaceRequestId: R4,
      allowed: true,
    };
    const none = html(<CertificatePanel {...props} certificate={null} />, "en");
    expect(none).not.toContain("Remove certificate");
    const some = html(<CertificatePanel {...props} certificate={issued} />, "en");
    expect(some).toContain("Remove certificate");
    expect(some).toContain("Replace certificate");
    expect(some).toContain("Check status and attach");
  });
});

describe("database parameters tab", () => {
  const props = {
    saveAction: noop,
    readAction: noop,
    rebootAction: noop,
    databaseId: ID,
    saveRequestId: R1,
    readRequestId: R2,
    rebootRequestId: R3,
    numerals: "latn" as const,
    allowed: true,
  };
  const facts = {
    engine: "mysql" as const,
    rebootPending: true,
    readAt: "2026-11-12T10:00:00.000Z",
    items: [
      {
        name: "max_connections",
        value: "150",
        apply: "immediate" as const,
        changeable: true,
        input: { kind: "int" as const },
      },
      {
        name: "slow_query_log",
        value: "0",
        apply: "immediate" as const,
        changeable: true,
        input: { kind: "bool" as const },
      },
      {
        name: "character_set_server",
        value: "utf8mb4",
        apply: "pending-reboot" as const,
        changeable: true,
        input: { kind: "enum" as const, values: ["utf8mb4", "utf8", "latin1"] },
      },
      {
        name: "wait_timeout",
        value: "28800",
        apply: "immediate" as const,
        changeable: false,
        input: { kind: "int" as const },
      },
    ],
  };

  it("shows the last known list with its date, the reboot flag and a field for each changeable parameter", () => {
    const out = html(<DatabaseParameters {...props} facts={facts} />, "en");
    expect(out).toContain("Last known list.");
    expect(out).toContain("<time");
    expect(out).toContain("Changes are waiting for a reboot.");
    for (const name of ["max_connections", "slow_query_log", "character_set_server"]) {
      expect(out).toContain(`name="${name}"`);
    }
    // A parameter that cannot change is shown, with no field.
    expect(out).toContain("wait_timeout");
    expect(out).not.toContain('name="wait_timeout"');
    expect(out).toContain("A change works after a reboot");
    expect(out).toContain('value="150"');
    expect(out).toContain(`name="databaseId" value="${ID}"`);
    for (const id of [R1, R2, R3]) expect(out).toContain(`name="requestId" value="${id}"`);
    expect(out).toContain('name="acknowledge"');
    expect(out).toContain("Reboot");
    expect(out).not.toMatch(/ style="/);
  });

  it("says so when the list was never read, offers the read button and no save form", () => {
    const out = html(<DatabaseParameters {...props} facts={null} />, "en");
    expect(out).toContain("The list has not been read yet");
    expect(out).toContain("Read the list again");
    expect(out).not.toContain("Save parameters");
    expect(out).not.toContain("waiting for a reboot");
  });

  it("an empty list, a database that is not running and bn each have their own text", () => {
    const empty = html(
      <DatabaseParameters {...props} facts={{ ...facts, rebootPending: false, items: [] }} />,
      "en",
    );
    expect(empty).toContain("No parameters to show");
    expect(empty).not.toContain("waiting for a reboot");
    const off = html(<DatabaseParameters {...props} facts={facts} allowed={false} />, "en");
    expect(off).toContain("only while the database is running");
    expect(off).toContain("disabled");
    const bn = html(<DatabaseParameters {...props} facts={facts} />, "bn");
    expect(bn).toMatch(/[ঀ-৿]/);
    expect(bn).toContain("max_connections");
  });
});

describe("dbParametersOf (the saved list, read field by field)", () => {
  it("keeps whitelisted names with a short value and drops everything else (R11, R16)", () => {
    const out = dbParametersOf({
      parameters: {
        engine: "MySQL",
        rebootPending: true,
        readAt: "2026-11-12T10:00:00.000Z",
        items: [
          { name: "max_connections", value: "150", apply: "immediate", changeable: true },
          { name: "skip_grant_tables", value: "ON", apply: "immediate", changeable: true },
          { name: "wait_timeout", value: "x".repeat(100), apply: "weird", changeable: "yes" },
          "text",
          null,
        ],
      },
    });
    expect(out).toMatchObject({ engine: "mysql", rebootPending: true });
    expect(out?.items.map((i) => i.name)).toEqual(["max_connections", "wait_timeout"]);
    expect(out?.items[1]).toMatchObject({ value: null, apply: "unknown", changeable: false });
    expect(out?.items[0]?.input).toEqual({ kind: "int" });
  });
  it("is null without an engine or a list, and the read date must be a date", () => {
    expect(dbParametersOf({})).toBeNull();
    expect(dbParametersOf({ parameters: { engine: "oracle", items: [] } })).toBeNull();
    expect(dbParametersOf({ parameters: { engine: "mysql" } })).toBeNull();
    expect(
      dbParametersOf({ parameters: { engine: "mysql", items: [], readAt: "soon" } }),
    ).toMatchObject({
      readAt: null,
    });
  });
});
