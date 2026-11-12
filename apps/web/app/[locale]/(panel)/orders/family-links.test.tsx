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
