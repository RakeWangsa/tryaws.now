import type { Locale } from "@tc/ui/runtime";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AutoRenewView } from "../../../../server/auto-renew-view.ts";
import { CdnDetailContent } from "../cdn/[id]/CdnDetailContent.tsx";
import { CDN_ID, detail as cdnDetail } from "../cdn/cdn.fixtures.ts";
import { ContainerDetailContent } from "../containers/[id]/ContainerDetailContent.tsx";
import { SERVICE_ID, detail as containerDetail } from "../containers/container.fixtures.ts";
import { DatabaseDetailContent } from "../databases/[id]/DatabaseDetailContent.tsx";
import { DATABASE_ID, detail as databaseDetail } from "../databases/databases.fixtures.ts";
import { ZoneContent } from "../dns/[id]/ZoneContent.tsx";
import { zone } from "../dns/mockup-states.tsx";
import { LoadBalancerDetailContent } from "../load-balancers/[id]/LoadBalancerDetailContent.tsx";
import { LB_ID, detail as lbDetail } from "../load-balancers/load-balancers.fixtures.ts";
import { ServerDetailContent } from "../servers/[id]/ServerDetailContent.tsx";
import { SERVER_ID as WINDOWS_ID, detail as serverDetail } from "../servers/servers.fixtures.ts";
import { StorageDetailContent } from "../storage/[id]/StorageDetailContent.tsx";
import { BUCKET_ID, detail as bucketDetail } from "../storage/bucket.fixtures.ts";
import {
  DISK_ID,
  FREE_DISK_ID,
  extras,
  metricsReady,
  noopActions,
} from "../_extras/extras.fixtures.ts";
import { AutoRenewSwitch } from "./AutoRenewSwitch.tsx";
import { html, numeralsOf } from "./render-html.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// WPU-Z14: the auto-renew switch on the detail page of every family that has no switch of its own (render
// tests). The page builds the switch from loadAutoRenew; without it (no own row, no subscription, flag
// off) the page has no switch.

const noop = async () => ({});
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const view = (resourceId: string, over: Partial<AutoRenewView> = {}): AutoRenewView => ({
  resourceId,
  autoRenew: true,
  canTurnOn: true,
  ...over,
});
const sw = (id: string, over: Partial<AutoRenewView> = {}): ReactElement => (
  <AutoRenewSwitch action={noop} view={view(id, over)} />
);
const ZONE_ID = zone().id;

type Page = (locale: Locale, renewal: ReactElement | null) => ReactElement;
const slot = (renewal: ReactElement | null) => (renewal === null ? {} : { renewal });

const PAGES: ReadonlyArray<readonly [string, string, Page]> = [
  [
    "windows_instance",
    WINDOWS_ID,
    (locale, renewal) => (
      <ServerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        server={serverDetail({ family: "windows_instance" })}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "database",
    DATABASE_ID,
    (locale, renewal) => (
      <DatabaseDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        database={databaseDetail()}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "bucket",
    BUCKET_ID,
    (locale, renewal) => (
      <StorageDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        bucket={bucketDetail()}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "load_balancer",
    LB_ID,
    (locale, renewal) => (
      <LoadBalancerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        balancer={lbDetail()}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "container_service",
    SERVICE_ID,
    (locale, renewal) => (
      <ContainerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        service={containerDetail()}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "cdn",
    CDN_ID,
    (locale, renewal) => (
      <CdnDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        cdn={cdnDetail()}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "dns_zone",
    ZONE_ID,
    (locale, renewal) => (
      <ZoneContent
        locale={locale}
        screen={{ state: "ready", zone: zone() }}
        editing={null}
        saveAction={noop}
        deleteAction={noop}
        destroyAction={noop}
        {...slot(renewal)}
      />
    ),
  ],
];

describe("the auto-renew switch on the detail page of each family (WPU-Z14)", () => {
  it.each(PAGES.map(([family, id, page]) => [family, id, page] as const))(
    "%s: shows the state and posts the opposite value for its own id, in bn and en",
    (_family, id, page) => {
      const en = html(page("en", sw(id)), "en");
      expect(en).toContain("Automatic renewal");
      expect(en).toContain(`name="resourceId" value="${id}"`);
      expect(en).toContain('name="autoRenew" value="off"');
      expect(en).toContain("Turn auto-renew off");
      expect(en).toContain("nothing is charged without your consent");
      const off = html(page("en", sw(id, { autoRenew: false })), "en");
      expect(off).toContain('name="autoRenew" value="on"');
      expect(off).toContain("Turn auto-renew on");
      const bn = html(page("bn", sw(id)), "bn");
      expect(bn).toContain("স্বয়ংক্রিয় নবায়ন");
      expect(bn).toContain("স্বয়ংক্রিয় নবায়ন বন্ধ করুন");
      expect(bn).not.toContain("Turn auto-renew");
    },
  );

  it.each(PAGES.map(([family, id, page]) => [family, id, page] as const))(
    "%s: without a switch from the page (no own row, no subscription, flag off) there is none",
    (_family, _id, page) => {
      const en = html(page("en", null), "en");
      expect(en).not.toContain('name="autoRenew"');
      expect(en).not.toContain("Turn auto-renew");
    },
  );

  it("a subscription that cannot renew (retained) cannot be turned on: the button is inert and says why", () => {
    const en = html(
      <AutoRenewSwitch
        action={noop}
        view={view(DATABASE_ID, { autoRenew: false, canTurnOn: false })}
      />,
      "en",
    );
    expect(en).toContain("cannot be turned on in the current state");
    expect(en).toMatch(/<button[^>]*disabled/);
    // Turning it OFF is never blocked.
    const on = html(
      <AutoRenewSwitch action={noop} view={view(DATABASE_ID, { canTurnOn: false })} />,
      "en",
    );
    expect(on).not.toMatch(/<button[^>]*disabled/);
    expect(on).toContain("Turn auto-renew off");
  });
});

// WPU-Z14 fix round 1: with the flag of the family off the detail loaders answer null (or flag_off for a
// zone), so the page shows its empty state; the page still passes the "off only" switch while auto-renew
// is on, so the renewals that keep charging can be stopped.
const FLAG_OFF_PAGES: ReadonlyArray<readonly [string, string, Page]> = [
  [
    "windows_instance",
    WINDOWS_ID,
    (locale, renewal) => (
      <ServerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        server={null}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "database",
    DATABASE_ID,
    (locale, renewal) => (
      <DatabaseDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        database={null}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "bucket",
    BUCKET_ID,
    (locale, renewal) => (
      <StorageDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        bucket={null}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "load_balancer",
    LB_ID,
    (locale, renewal) => (
      <LoadBalancerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        balancer={null}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "container_service",
    SERVICE_ID,
    (locale, renewal) => (
      <ContainerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        service={null}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "cdn",
    CDN_ID,
    (locale, renewal) => (
      <CdnDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        cdn={null}
        requestId={REQ}
        {...slot(renewal)}
      />
    ),
  ],
  [
    "dns_zone",
    ZONE_ID,
    (locale, renewal) => (
      <ZoneContent
        locale={locale}
        screen={{ state: "flag_off" }}
        editing={null}
        saveAction={noop}
        deleteAction={noop}
        destroyAction={noop}
        {...slot(renewal)}
      />
    ),
  ],
];

describe("the off-only auto-renew switch with the flag of the family off (WPU-Z14 fix round 1)", () => {
  it.each(FLAG_OFF_PAGES.map(([family, id, page]) => [family, id, page] as const))(
    "%s: the empty page still offers to turn auto-renew off, never on, in bn and en",
    (_family, id, page) => {
      const offOnly = sw(id, { autoRenew: true, canTurnOn: false });
      const en = html(page("en", offOnly), "en");
      expect(en).toContain(`name="resourceId" value="${id}"`);
      expect(en).toContain('name="autoRenew" value="off"');
      expect(en).toContain("Turn auto-renew off");
      expect(en).not.toContain("Turn auto-renew on");
      expect(en).not.toMatch(/<button[^>]*disabled/);
      const bn = html(page("bn", offOnly), "bn");
      expect(bn).toContain("স্বয়ংক্রিয় নবায়ন বন্ধ করুন");
      // no switch once it is off (the page passes none)
      expect(html(page("en", null), "en")).not.toContain('name="autoRenew"');
    },
  );
});

describe("the auto-renew switch of each disk on the Storage tab of its server (WPU-Z14)", () => {
  const page = (locale: Locale, data = extras()) =>
    html(
      <ServerDetailContent
        locale={locale}
        numerals={numeralsOf(locale)}
        server={serverDetail()}
        extras={{ data, metrics: metricsReady, actions: noopActions }}
        defaultTab="storage"
      />,
      locale,
    );

  it("an attached disk and a free disk each post their own id and the opposite value, in bn and en", () => {
    const en = page("en");
    expect(en).toContain("Auto-renew");
    expect(en).toContain(`name="resourceId" value="${DISK_ID}"`);
    expect(en).toContain(`name="resourceId" value="${FREE_DISK_ID}"`);
    // the attached disk renews (fixture: on), the free one does not (fixture: off)
    expect(en).toContain("Turn auto-renew off");
    expect(en).toContain("Turn auto-renew on");
    const bn = page("bn");
    expect(bn).toContain("স্বয়ংক্রিয় নবায়ন চালু করুন");
    expect(bn).toContain("স্বয়ংক্রিয় নবায়ন বন্ধ করুন");
  });

  it("with the disk flag off a disk that renews keeps an off-only switch (fix round 1)", () => {
    const base = extras();
    const data = {
      ...base,
      disks: base.disks.map((d) => ({
        ...d,
        autoRenew: { resourceId: d.id, autoRenew: true, canTurnOn: false },
      })),
      freeDisks: base.freeDisks.map((d) => ({ ...d, autoRenew: null })),
    };
    const en = page("en", data);
    expect(en).toContain(`name="resourceId" value="${DISK_ID}"`);
    expect(en).toContain("Turn auto-renew off");
    expect(en).not.toContain("Turn auto-renew on");
  });

  it("a disk without a switch (flag off, no subscription) shows none", () => {
    const base = extras();
    const data = {
      ...base,
      disks: base.disks.map((d) => ({ ...d, autoRenew: null })),
      freeDisks: base.freeDisks.map((d) => ({ ...d, autoRenew: null })),
    };
    const en = page("en", data);
    expect(en).not.toContain(`name="resourceId" value="${DISK_ID}"`);
    expect(en).not.toContain(`name="resourceId" value="${FREE_DISK_ID}"`);
  });
});
