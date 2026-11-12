import { describe, expect, it, vi } from "vitest";
import {
  BucketVersioningForm,
  CdnResetForm,
  ConsoleNotice,
  DatabaseOptionsForm,
  LoadBalancerCertificate,
  LoadBalancerSettingsForm,
} from "./ConsoleForms.tsx";
import { html } from "../_family/render-html.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const ID = "0190aaaa-0000-7000-8000-0000000000e1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const REQ2 = "0190aaaa-0000-7000-8000-0000000000f2";
const noop = async () => ({});

describe("load balancer settings and certificate forms (WPU-G7)", () => {
  const empty = { healthCheckPath: null, httpsRedirect: null, certificate: null };

  it("posts the path and the redirect choice with the resource id and the request id (R7)", () => {
    const out = html(
      <LoadBalancerSettingsForm
        action={noop}
        loadBalancerId={ID}
        requestId={REQ}
        console={{ ...empty, healthCheckPath: "/health.html", httpsRedirect: true }}
      />,
      "en",
    );
    for (const name of ["healthCheckPath", "httpsRedirect"])
      expect(out).toContain(`name="${name}"`);
    expect(out).toContain(`name="loadBalancerId" value="${ID}"`);
    expect(out).toContain(`name="requestId" value="${REQ}"`);
    expect(out).toContain("/health.html");
    expect(out).toContain("Redirect HTTP to HTTPS");
    expect(out).not.toMatch(/ style="/);
  });

  it("without a certificate it offers the request form; with one it shows the records to add and a check button", () => {
    const none = html(
      <LoadBalancerCertificate
        requestAction={noop}
        refreshAction={noop}
        loadBalancerId={ID}
        requestId={REQ}
        certificate={null}
      />,
      "en",
    );
    expect(none).toContain("No certificate has been requested");
    expect(none).toContain('name="domain"');
    const pending = html(
      <LoadBalancerCertificate
        requestAction={noop}
        refreshAction={noop}
        loadBalancerId={ID}
        requestId={REQ}
        certificate={{
          domain: "shop.example.com",
          status: "PENDING_VALIDATION",
          attached: false,
          records: [
            { name: "_x.shop.example.com.", type: "CNAME", value: "_y.acm-validations.aws." },
          ],
        }}
      />,
      "en",
    );
    expect(pending).toContain("shop.example.com");
    expect(pending).toContain("Waiting for validation");
    expect(pending).toContain("_x.shop.example.com.");
    expect(pending).toContain("Check status and attach");
    expect(pending).not.toContain('name="domain"');
    expect(pending).toContain("table-responsive");
    const noRecords = html(
      <LoadBalancerCertificate
        requestAction={noop}
        refreshAction={noop}
        loadBalancerId={ID}
        requestId={REQ}
        certificate={{ domain: "a.example.com", status: "UNKNOWN", attached: false, records: [] }}
      />,
      "bn",
    );
    expect(noRecords).toMatch(/[ঀ-৿]/);
    expect(noRecords).toContain("a.example.com");
  });
});

describe("database options form", () => {
  it("shows the window, the public mode, the warning and the acknowledgement; the state is a word, not a color (U11)", () => {
    const out = html(
      <DatabaseOptionsForm
        action={noop}
        databaseId={ID}
        requestId={REQ}
        console={{
          backupWindow: "16:00-16:30",
          maintenanceWindow: "tue:17:00-tue:17:30",
          publiclyAccessible: true,
        }}
      />,
      "en",
    );
    for (const name of ["backupWindow", "maintenanceWindow", "publicMode", "acknowledge"]) {
      expect(out).toContain(`name="${name}"`);
    }
    expect(out).toContain("16:00-16:30");
    expect(out).toContain("Now: on");
    expect(out).toContain("can be reached from the internet");
    const bn = html(
      <DatabaseOptionsForm
        action={noop}
        databaseId={ID}
        requestId={REQ}
        console={{ backupWindow: null, maintenanceWindow: null, publiclyAccessible: false }}
      />,
      "bn",
    );
    expect(bn).toMatch(/[ঀ-৿]/);
  });
});

describe("bucket versioning and CDN flush forms", () => {
  it("the versioning forms use two request ids and disable the button that does nothing", () => {
    const out = html(
      <BucketVersioningForm
        action={noop}
        bucketId={ID}
        requestId={REQ}
        suspendRequestId={REQ2}
        versioning="Enabled"
      />,
      "en",
    );
    expect(out).toContain(`value="${REQ}"`);
    expect(out).toContain(`value="${REQ2}"`);
    expect(out).toContain('value="Enabled"');
    expect(out).toContain('value="Suspended"');
    expect(out).toContain("Now: on");
    expect(out).toMatch(
      /disabled=""[^>]*>[^<]*Turn versioning on|Turn versioning on[^<]*<\/button>/,
    );
  });

  it("the flush form posts the CDN id and is inert when it is not allowed", () => {
    const on = html(<CdnResetForm action={noop} cdnId={ID} requestId={REQ} allowed />, "en");
    expect(on).toContain(`name="cdnId" value="${ID}"`);
    expect(on).toContain("Flush cache");
    const off = html(
      <CdnResetForm action={noop} cdnId={ID} requestId={REQ} allowed={false} />,
      "en",
    );
    expect(off).toContain("disabled");
  });
});

describe("the result line", () => {
  it("shows a fixed text for an error and for a done key, never a raw text (U6)", () => {
    expect(html(<ConsoleNotice state={{ error: "not_allowed" }} />, "en")).toContain(
      "cannot be done in the current state",
    );
    expect(html(<ConsoleNotice state={{ error: "weird raw text" }} />, "en")).toContain(
      "could not finish this now",
    );
    expect(html(<ConsoleNotice state={{ done: "cacheResetQueued" }} />, "bn")).toMatch(/[ঀ-৿]/);
    expect(html(<ConsoleNotice state={{}} />, "en")).toBe("");
  });
});
