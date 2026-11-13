import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../../i18n/messages.ts";
import type { DiskListItem } from "../../../../../server/disk-list-view.ts";

// WPU-Y4: /servers/disks renders every disk with its switch and the existing disk actions, in bn and en.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { DiskListContent } = await import("./DiskListContent.tsx");

const noop = async () => ({});
const actions = { detachDisk: noop, destroyDisk: noop, setDiskAutoRenew: noop };
const SERVER = "0190aaaa-0000-7000-8000-0000000000a1";
const item = (over: Partial<DiskListItem> & { id: string }): DiskListItem => ({
  name: "data",
  sizeGb: 64,
  region: "ap-southeast-1",
  state: "active",
  attachedTo: null,
  subscriptionStatus: "active",
  autoRenew: null,
  canDetach: false,
  canDestroy: false,
  attachTargets: [],
  ...over,
});
const disks: DiskListItem[] = [
  item({
    id: "0190aaaa-0000-7000-8000-0000000000d1",
    name: "attached-disk",
    attachedTo: { id: SERVER, name: "web", stopped: true },
    canDetach: true,
    autoRenew: {
      resourceId: "0190aaaa-0000-7000-8000-0000000000d1",
      autoRenew: true,
      canTurnOn: true,
    },
  }),
  item({
    id: "0190aaaa-0000-7000-8000-0000000000d2",
    name: "<b>spare</b>",
    region: "eu-west-2",
    canDestroy: true,
    attachTargets: [{ id: SERVER, name: "web" }],
  }),
  item({
    id: "0190aaaa-0000-7000-8000-0000000000d3",
    name: "old",
    state: "destroyed",
    subscriptionStatus: "retained",
  }),
];

function render(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}
const ready = (locale: Locale, list = disks) =>
  render(
    <DiskListContent
      locale={locale}
      screen={{ state: "ready", disks: list, requestId: "0190aaaa-0000-7000-8000-0000000000e1" }}
      actions={actions}
    />,
    locale,
  );

describe("DiskListContent", () => {
  it("flag off: the flag-off state, no list and no form (R12)", () => {
    const html = render(
      <DiskListContent locale="en" screen={{ state: "flag_off" }} actions={actions} />,
      "en",
    );
    expect(html).toContain("Cloud servers are coming soon");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<table");
  });

  it("empty: says so, in bn and en", () => {
    expect(ready("en", [])).toContain("You have no disk");
    expect(ready("bn", [])).toContain("আপনার কোনো ডিস্ক নেই");
  });

  it("ready: every disk with its location, state, server, subscription, switch and actions", () => {
    const html = ready("en");
    expect(html).toContain("Amazon Lightsail block storage disks");
    expect(html).toContain("attached-disk");
    expect(html).toContain("Asia Pacific (Singapore) · ap-southeast-1");
    expect(html).toContain("Europe (London) · eu-west-2");
    expect(html).toContain(`/en/servers/${SERVER}?tab=storage`);
    expect(html).toContain("Not attached to a server");
    expect(html).toContain("Being deleted");
    expect(html).toContain("Deleted");
    // detach (posts the disk and the request id), the switch of the attached disk, destroy of the free one
    expect(html).toContain('name="diskId" value="0190aaaa-0000-7000-8000-0000000000d1"');
    expect(html).toContain('name="requestId" value="0190aaaa-0000-7000-8000-0000000000e1"');
    expect(html).toContain(">Detach<");
    expect(html).toContain('name="resourceId" value="0190aaaa-0000-7000-8000-0000000000d1"');
    expect(html).toContain("Destroy disk");
    expect(html).toContain("Attach on web");
    // The name the customer typed is text, never markup (R11).
    expect(html).toContain("&lt;b&gt;spare&lt;/b&gt;");
    expect(html).not.toContain("<b>spare</b>");
    // No generated AWS name, account id or ARN (U6).
    expect(html).not.toMatch(/tc-(disk|instance)-|arn:aws|\d{12}/);
    // The Cloud Server pages navigation names this page.
    expect(html).toContain('href="/en/servers/disks"');
  });

  it("an attached disk on a running server says to unmount and stop first, with no detach button", () => {
    const html = ready("en", [
      item({
        id: "0190aaaa-0000-7000-8000-0000000000d4",
        attachedTo: { id: SERVER, name: "web", stopped: false },
      }),
    ]);
    expect(html).toContain("unmount the disk first, then stop the server");
    expect(html).not.toContain(">Detach<");
  });

  it("bn: Bengali labels", () => {
    const html = ready("bn");
    expect(html).toContain("আপনার সব ডিস্ক");
    expect(html).toContain("কোনো সার্ভারে যুক্ত নয়");
    expect(html).toContain("ডিলিট হচ্ছে");
  });
});
