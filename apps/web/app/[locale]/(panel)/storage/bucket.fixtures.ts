import type {
  BucketConfiguratorScreen,
  BucketDetail,
  BucketPlanOption,
  BucketRow,
} from "../../../../server/bucket-view.ts";

// Rows for the render tests of the object storage screens (never imported by a page).

export const BUCKET_ID = "0190aaaa-0000-7000-8000-0000000000b1";
/** awsResourceName("bucket", BUCKET_ID): the generated name that the page shows (U6). */
export const BUCKET_NAME = "tc-bucket-80000000000000b1";
export const PLAN_SMALL = "0190aaaa-0000-7000-8000-0000000000e1";
export const PLAN_MEDIUM = "0190aaaa-0000-7000-8000-0000000000e2";
export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";

export const noopAction = async () => ({});

export function plan(over: Partial<BucketPlanOption> = {}): BucketPlanOption {
  return {
    id: PLAN_SMALL,
    region: "ap-southeast-1",
    priceMinor: 30000n,
    storageGb: 250,
    transferGb: 2048,
    ...over,
  };
}

export function configurator(
  over: Partial<Extract<BucketConfiguratorScreen, { state: "ready" }>> = {},
): BucketConfiguratorScreen {
  return {
    state: "ready",
    plans: [plan(), plan({ id: PLAN_MEDIUM, storageGb: 500, priceMinor: 90000n })],
    ...over,
  };
}

export function row(over: Partial<BucketRow> = {}): BucketRow {
  return {
    id: BUCKET_ID,
    name: "site-assets",
    bucketName: BUCKET_NAME,
    region: "ap-southeast-1",
    state: "active",
    ...over,
  };
}

export function detail(over: Partial<BucketDetail> = {}): BucketDetail {
  return {
    ...row(),
    address: `https://${BUCKET_NAME}.s3.ap-southeast-1.amazonaws.com`,
    accessMode: null,
    createdAt: new Date("2026-11-10T08:00:00Z"),
    destroyOpen: false,
    requests: [
      {
        id: "0190aaaa-0000-7000-8000-0000000000a9",
        kind: "access",
        state: "succeeded",
        createdAt: new Date("2026-11-11T08:00:00Z"),
      },
    ],
    ...over,
  };
}
