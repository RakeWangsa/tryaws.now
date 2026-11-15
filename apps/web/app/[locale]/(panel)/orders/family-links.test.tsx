import { describe, expect, it, vi } from "vitest";
import { html } from "../_family/render-html.tsx";
import { OrderStatusContent } from "./[id]/OrderStatusContent.tsx";
import { ReviewContent } from "./review/ReviewContent.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// The order screens link to the screens of the family that was bought (WP6-T2, WP6-T3).

const RESOURCE = "0190aaaa-0000-7000-8000-0000000000d1";
const order = (family: string | undefined) => ({
  id: "0190aaaa-0000-7000-8000-0000000000c0",
  totalMinor: 250000n,
  createdAt: new Date("2026-11-12T08:00:00Z"),
  progress: "ready" as const,
  resourceId: RESOURCE,
  serverName: "x",
  ...(family === undefined ? {} : { family }),
});
const noop = async () => ({});

describe("/orders/[id] opens the new resource on its own page", () => {
  it.each([
    ["database", `/en/databases/${RESOURCE}`, "Open the database"],
    ["load_balancer", `/en/load-balancers/${RESOURCE}`, "Open the load balancer"],
    ["cdn", `/en/cdn/${RESOURCE}`, "Open the CDN"],
  ])("%s", (family, href, label) => {
    const out = html(<OrderStatusContent locale="en" order={order(family)} />, "en");
    expect(out).toContain(`href="${href}"`);
    expect(out).toContain(label);
  });

  it("a disk has no page of its own: the customer is sent to the servers, where the Storage tab attaches it", () => {
    const out = html(<OrderStatusContent locale="en" order={order("disk")} />, "en");
    expect(out).toContain('href="/en/servers"');
    expect(out).toContain("My servers");
    expect(out).toContain("Storage tab");
    expect(out).not.toContain(`href="/en/servers/${RESOURCE}"`);
  });

  it("a server keeps the link to the server page", () => {
    const out = html(<OrderStatusContent locale="en" order={order("linux_instance")} />, "en");
    expect(out).toContain(`href="/en/servers/${RESOURCE}"`);
  });
});

describe("/orders/[id] names the thing that was bought, not always a server", () => {
  const withProgress = (family: string | undefined, progress: "creating" | "ready" | "failed") => ({
    ...order(family),
    progress,
    resourceId: progress === "ready" ? RESOURCE : null,
  });
  const NOUNS: [string | undefined, string, string][] = [
    ["linux_instance", "server", "Server"],
    ["windows_instance", "server", "Server"],
    [undefined, "server", "Server"],
    ["something_new", "server", "Server"],
    ["disk", "disk", "Disk"],
    ["bucket", "bucket", "Bucket"],
    ["database", "database", "Database"],
    ["load_balancer", "load balancer", "Load balancer"],
    ["container_service", "container service", "Container service"],
    ["cdn", "CDN", "CDN"],
    ["dns_zone", "DNS zone", "DNS zone"],
    ["domain", "domain", "Domain"],
    ["static_ip", "static IP", "Static IP"],
    ["backup", "backup", "Backup"],
  ];

  it.each(NOUNS)("%s: the steps and the notes use its own noun (en)", (family, noun, title) => {
    const creating = html(
      <OrderStatusContent locale="en" order={withProgress(family, "creating")} />,
      "en",
    );
    expect(creating).toContain(`Creating the ${noun}`);
    expect(creating).toContain(`${title} ready`);
    expect(creating).toContain(`Your ${noun} is being created`);
    const failed = html(
      <OrderStatusContent locale="en" order={withProgress(family, "failed")} />,
      "en",
    );
    expect(failed).toContain(`The ${noun} could not be created`);
    if (family !== "linux_instance" && family !== "windows_instance" && noun !== "server") {
      expect(creating).not.toMatch(/\bserver\b/i);
      expect(failed).not.toMatch(/\bserver\b/i);
    }
  });

  it("a disk says disk in bn and never server", () => {
    const out = html(
      <OrderStatusContent locale="bn" order={withProgress("disk", "creating")} />,
      "bn",
    );
    expect(out).toContain("ডিস্ক তৈরি হচ্ছে");
    expect(out).not.toContain("সার্ভার");
  });

  it("a ready disk keeps its own note and button", () => {
    const out = html(
      <OrderStatusContent locale="en" order={withProgress("disk", "ready")} />,
      "en",
    );
    expect(out).toContain("Disk ready");
    expect(out).toContain("Your disk is ready.");
  });
});

describe("/orders/review goes back to the form the draft came from", () => {
  const ready = (family: string | undefined) =>
    ({
      state: "ready" as const,
      token: "t",
      name: "main",
      region: "ap-southeast-1",
      productId: "0190aaaa-0000-7000-8000-0000000000b1",
      expiresAt: new Date("2026-11-12T09:00:00Z"),
      baseMinor: 250000n,
      steps: [],
      totalMinor: 250000n,
      balanceMinor: 500000n,
      balanceAfterMinor: 250000n,
      shortfallTaka: null,
      ...(family === undefined ? {} : { family }),
    }) as never;

  it.each([
    ["database", "/en/databases/new"],
    ["load_balancer", "/en/load-balancers/new"],
    ["cdn", "/en/cdn/new"],
    ["linux_instance", "/en/servers/new"],
    ["disk", "/en/servers"],
    [undefined, "/en/servers/new"],
  ])("%s", (family, href) => {
    const out = html(
      <ReviewContent locale="en" review={ready(family)} idempotencyKey="k" action={noop} />,
      "en",
    );
    expect(out).toContain(`href="${href}"`);
  });
});

// WPU-B3: a failed order whose reversal is posted says so with the amount; before that it only promises.
describe("/orders/[id] failed: the refund line", () => {
  const failed = (refunded: boolean) => ({
    ...order("linux_instance"),
    progress: "failed" as const,
    resourceId: null,
    refunded,
  });
  it("shows the returned amount once the reversal is posted (en and bn)", () => {
    const en = html(<OrderStatusContent locale="en" order={failed(true)} />, "en");
    expect(en).toContain("Returned to your wallet:");
    const bn = html(<OrderStatusContent locale="bn" order={failed(true)} />, "bn");
    expect(bn).toContain("আপনার ওয়ালেটে ফেরত দেওয়া হয়েছে:");
  });
  it("shows only the promise while the order is not reversed", () => {
    const en = html(<OrderStatusContent locale="en" order={failed(false)} />, "en");
    expect(en).not.toContain("Returned to your wallet:");
    expect(en).toContain("returned to your wallet automatically");
  });
});
