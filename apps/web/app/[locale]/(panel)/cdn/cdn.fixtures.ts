import type {
  CdnConfiguratorScreen,
  CdnDetail,
  CdnPlanOption,
  CdnRow,
  OriginOption,
} from "../../../../server/cdn-view.ts";

// Rows for the render tests of the CDN screens (never imported by a page).

export const CDN_ID = "0190aaaa-0000-7000-8000-0000000000c1";
export const ORIGIN_ID = "0190aaaa-0000-7000-8000-0000000000a1";
export const PLAN_SMALL = "0190aaaa-0000-7000-8000-0000000000b1";
export const PLAN_MEDIUM = "0190aaaa-0000-7000-8000-0000000000b2";
export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";

export const noopAction = async () => ({});

export function plan(over: Partial<CdnPlanOption> = {}): CdnPlanOption {
  return {
    id: PLAN_SMALL,
    region: "us-east-1",
    bundle: "small_1_0",
    priceMinor: 69000n,
    transferGb: 1024,
    ...over,
  };
}

export function origin(over: Partial<OriginOption> = {}): OriginOption {
  return { id: ORIGIN_ID, kind: "server", name: "web-1", ...over };
}

export function configurator(
  over: Partial<Extract<CdnConfiguratorScreen, { state: "ready" }>> = {},
): CdnConfiguratorScreen {
  return {
    state: "ready",
    plans: [plan(), plan({ id: PLAN_MEDIUM, bundle: "medium_1_0", priceMinor: 139000n })],
    origins: [
      origin(),
      origin({ id: "0190aaaa-0000-7000-8000-0000000000a2", kind: "bucket", name: "assets" }),
    ],
    ...over,
  };
}

export function row(over: Partial<CdnRow> = {}): CdnRow {
  return {
    id: CDN_ID,
    name: "site-cdn",
    state: "active",
    originName: "web-1",
    originKind: "server",
    defaultDomain: "d1a2b3c4d5e6f7.cloudfront.net",
    cacheBehavior: "cache",
    ...over,
  };
}

export function detail(over: Partial<CdnDetail> = {}): CdnDetail {
  return {
    ...row(),
    region: "us-east-1",
    createdAt: new Date("2026-11-10T08:00:00Z"),
    cachePolicy: null,
    origins: [
      origin(),
      origin({ id: "0190aaaa-0000-7000-8000-0000000000a2", kind: "bucket", name: "assets" }),
    ],
    originId: ORIGIN_ID,
    certificate: null,
    currentProductId: PLAN_SMALL,
    pendingProductId: null,
    plans: [plan(), plan({ id: PLAN_MEDIUM, bundle: "medium_1_0", priceMinor: 139000n })],
    renewsAt: new Date("2026-12-10T08:00:00Z"),
    ...over,
  };
}
