import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Locale } from "@tc/ui/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webMessages } from "../../../../../i18n/messages.ts";
import type { DiskRestoreOption } from "../../../../../server/disk-restore-view.ts";

// WPU-X2. The form keeps the answer of its Server Action with useActionState; static markup cannot
// submit, so the answer is injected and the test reads what the form shows.
const hold = vi.hoisted(() => ({ state: {} as unknown }));
vi.mock("react", async (importActual) => {
  const actual = await importActual<typeof import("react")>();
  return { ...actual, useActionState: () => [hold.state, () => {}, false] };
});

const { DiskRestoreContent } = await import("./DiskRestoreContent.tsx");

const noop = async () => ({});
const option = (over: Partial<DiskRestoreOption> = {}): DiskRestoreOption => ({
  snapshotId: "0190aaaa-0000-7000-8000-0000000000b1",
  name: "<b>nightly</b>",
  sourceName: "data",
  sourceDestroyed: false,
  region: "ap-south-1",
  minGb: 100,
  maxGb: 16000,
  productId: "0190bbbb-0000-7000-8000-000000000001",
  perGbMinor: 1250n,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

function render(node: ReactNode, locale: Locale): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      {node}
    </NextIntlClientProvider>,
  );
}
const ready = (locale: Locale, options = [option()]) =>
  render(<DiskRestoreContent screen={{ state: "ready", options }} action={noop} />, locale);

beforeEach(() => {
  hold.state = {};
});

describe("DiskRestoreContent", () => {
  it("flag off: shows the flag-off state and no form (R12)", () => {
    for (const locale of ["bn", "en"] as const) {
      const html = render(
        <DiskRestoreContent screen={{ state: "flag_off" }} action={noop} />,
        locale,
      );
      expect(html).not.toContain("<form");
      expect(html).not.toContain("restoreFromBackupId");
    }
    expect(
      render(<DiskRestoreContent screen={{ state: "flag_off" }} action={noop} />, "en"),
    ).toContain("coming soon");
  });

  it("empty: says so, no form", () => {
    const html = render(
      <DiskRestoreContent screen={{ state: "ready", options: [] }} action={noop} />,
      "en",
    );
    expect(html).toContain("No snapshot to make a disk from");
    expect(html).not.toContain("<form");
  });

  it("ready: labelled controls, hidden ids, the per-GB price from paisa (R4), the minimum size", () => {
    const html = ready("en");
    expect(html).toContain('name="restoreFromBackupId"');
    expect(html).toContain('name="displayName"');
    expect(html).toContain('name="sizeGb"');
    expect(html).toContain('value="100"'); // the size starts at the original disk's size
    expect(html).toContain('type="hidden" name="region" value="ap-south-1"');
    expect(html).toContain(
      'type="hidden" name="productId" value="0190bbbb-0000-7000-8000-000000000001"',
    );
    expect(html).toMatch(/<label[^>]*for="[^"]+-snapshot"[^>]*>Snapshot<\/label>/);
    expect(html).toContain("Name of the new disk");
    expect(html).toContain("12.50"); // 1250 paisa
    expect(html).toContain("Amazon Lightsail block storage disk");
  });

  it("the form sends no customerId, no AWS name and no server id (R1, R8, R11)", () => {
    const html = ready("en");
    expect(html).not.toContain('name="customerId"');
    expect(html).not.toContain('name="serverId"');
    expect(html).not.toMatch(/tc-disk|arn:aws/);
  });

  it("customer text is escaped, never markup", () => {
    const html = ready("en");
    expect(html).not.toContain("<b>nightly</b>");
    expect(html).toContain("&lt;b&gt;nightly&lt;/b&gt;");
  });

  it("is shown in Bengali with Bengali text", () => {
    expect(ready("bn")).toMatch(/[ঀ-৿]/);
    expect(ready("bn")).toContain("স্ন্যাপশট");
  });

  it("shows field errors and the fixed error text, never a raw key or AWS text", () => {
    hold.state = {
      error: "validation",
      fields: { sizeGb: "too_small", restoreFromBackupId: "invalid", displayName: "invalid" },
    };
    const html = ready("en");
    expect(html).toContain("cannot be smaller than the original disk");
    expect(html).toContain("A disk cannot be made from this snapshot right now.");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    hold.state = { error: "something_unknown" };
    expect(ready("en")).toContain("We could not finish this now");
  });
});
