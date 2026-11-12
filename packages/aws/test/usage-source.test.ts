import { expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { AwsError } from "../errors";
import { createLightsailUsageSource } from "../usage-source";
import {
  ASSUMED,
  assumeRoleOk,
  expectNoLeak,
  fakeAws,
  lightsailError,
  lightsailOk,
} from "./fake-aws";

// WPU-X4. The usage reader of the reconciler: snapshot GB per parent resource and NetworkOut GB per hour.
// Every call goes through the fake transport; no AWS call is made (the network guard enforces it).

const NOW = Date.parse("2026-11-13T09:30:00.000Z");
const clock = { now: () => new Date(NOW) };
const ACCOUNT = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const SERVER = "tc-instance-aaaaaaaaaaaaaaaa";
const DISK = "tc-disk-bbbbbbbbbbbbbbbb";
const DB = "tc-database-cccccccccccccccc";
const EMPTY = {
  instanceSnapshots: [],
  diskSnapshots: [],
  relationalDatabaseSnapshots: [],
  instances: [],
  metricData: [],
};
const ACTIONS = [
  "GetInstanceSnapshots",
  "GetDiskSnapshots",
  "GetRelationalDatabaseSnapshots",
  "GetInstances",
  "GetInstanceMetricData",
];

function setup() {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  // Empty answers for everything; a test overrides the one it cares about (first reply = first Region).
  for (const a of ACTIONS) aws.on("lightsail", a, lightsailOk(EMPTY));
  const access = createAwsAccessInternal({
    caller: "reconciler",
    clock,
    requestHandler: aws.handler,
  });
  return { aws, source: createLightsailUsageSource(access, clock) };
}

const snap = (extra: Record<string, unknown>) => ({ state: "available", sizeInGb: 20, ...extra });

it("sums the available snapshots per parent for today (Dhaka) and ignores the rest", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetInstanceSnapshots",
    lightsailOk({
      instanceSnapshots: [
        snap({ fromInstanceName: SERVER, sizeInGb: 20 }),
        snap({ fromInstanceName: SERVER, sizeInGb: 40 }),
        snap({ fromInstanceName: SERVER, sizeInGb: 99, state: "pending" }),
        snap({ fromInstanceName: "customer-made-name", sizeInGb: 7 }),
      ],
    }),
    lightsailOk(EMPTY),
  );
  aws.on(
    "lightsail",
    "GetDiskSnapshots",
    lightsailOk({ diskSnapshots: [snap({ fromDiskName: DISK, sizeInGb: 8 })] }),
    lightsailOk(EMPTY),
  );
  aws.on(
    "lightsail",
    "GetRelationalDatabaseSnapshots",
    lightsailOk({
      relationalDatabaseSnapshots: [snap({ fromRelationalDatabaseName: DB, sizeInGb: 40 })],
    }),
    lightsailOk(EMPTY),
  );
  const samples = await source.read(ACCOUNT);
  const snaps = samples.filter((s) => s.metric === "snapshot_gb");
  expect(snaps).toContainEqual({
    awsName: SERVER,
    metric: "snapshot_gb",
    period: "2026-11-13",
    quantityGb: "60",
  });
  expect(snaps.find((s) => s.awsName === "customer-made-name")).toBeUndefined();
  expect(snaps.map((s) => s.awsName)).toContain(DISK);
  expect(snaps.map((s) => s.awsName)).toContain(DB);
  expect(aws.seen.find((r) => r.service === "sts")!.body).toContain("role%2FTcReader");
});

it("follows pageToken and fails closed when pages never end", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetInstanceSnapshots",
    lightsailOk({ instanceSnapshots: [snap({ fromInstanceName: SERVER })], nextPageToken: "t1" }),
    lightsailOk({ instanceSnapshots: [snap({ fromInstanceName: SERVER })] }),
    lightsailOk(EMPTY),
  );
  const out = await source.read(ACCOUNT);
  expect(out.find((s) => s.awsName === SERVER)?.quantityGb).toBe("40");
  const asked = aws.seen
    .filter((r) => r.action === "GetInstanceSnapshots")
    .map((r) => JSON.parse(r.body) as unknown);
  expect(asked[1]).toEqual({ pageToken: "t1" });

  const endless = setup();
  endless.aws.on(
    "lightsail",
    "GetInstanceSnapshots",
    lightsailOk({ instanceSnapshots: [], nextPageToken: "again" }),
  );
  await expect(endless.source.read(ACCOUNT)).rejects.toMatchObject({
    code: "internal",
    reason: "usage_pages_exceeded",
  });
});

it("reads NetworkOut per hour for the last 24 whole hours and converts bytes to GB", async () => {
  const { aws, source } = setup();
  const GIB = 2 ** 30;
  aws.on(
    "lightsail",
    "GetInstances",
    lightsailOk({ instances: [{ name: SERVER }, { name: "other" }] }),
    lightsailOk(EMPTY),
  );
  aws.on(
    "lightsail",
    "GetInstanceMetricData",
    lightsailOk({
      metricName: "NetworkOut",
      metricData: [
        { timestamp: Date.parse("2026-11-13T07:00:00Z") / 1000, sum: 1.5 * GIB, unit: "Bytes" },
        { timestamp: Date.parse("2026-11-13T08:00:00Z") / 1000, sum: 0, unit: "Bytes" },
        // Outside the window (the running hour): dropped.
        { timestamp: Date.parse("2026-11-13T09:00:00Z") / 1000, sum: GIB, unit: "Bytes" },
      ],
    }),
  );
  const out = await source.read(ACCOUNT);
  // 07:00Z is 13:00 in Dhaka. A zero hour writes nothing.
  expect(out.filter((s) => s.metric === "transfer_gb")).toEqual([
    { awsName: SERVER, metric: "transfer_gb", period: "2026-11-13T13", quantityGb: "1.5" },
  ]);
  const asked = aws.seen
    .filter((r) => r.action === "GetInstanceMetricData")
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  expect(asked).toHaveLength(1); // the foreign name has no call
  expect(asked[0]).toMatchObject({
    instanceName: SERVER,
    metricName: "NetworkOut",
    period: 3600,
    unit: "Bytes",
    statistics: ["Sum"],
  });
  expect(asked[0]!["endTime"]).toBe(Date.parse("2026-11-13T09:00:00Z") / 1000);
  expect(asked[0]!["startTime"]).toBe(Date.parse("2026-11-12T09:00:00Z") / 1000);
});

it("fails the whole read on any AWS error, with no id in the error (R16, R14)", async () => {
  for (const action of ACTIONS) {
    const { aws, source } = setup();
    aws.on("lightsail", "GetInstances", lightsailOk({ instances: [{ name: SERVER }] }));
    aws.on(
      "lightsail",
      action,
      lightsailError(400, "AccessDeniedException", "arn:aws:iam::210987654321 not authorized"),
    );
    const error: unknown = await source.read(ACCOUNT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AwsError);
    expectNoLeak(error);
  }
});

it("fails closed on a malformed answer and on a bad size", async () => {
  const a = setup();
  a.aws.on("lightsail", "GetDiskSnapshots", lightsailOk({ nothing: true }));
  await expect(a.source.read(ACCOUNT)).rejects.toMatchObject({ reason: "usage_response_invalid" });

  const b = setup();
  b.aws.on(
    "lightsail",
    "GetInstanceSnapshots",
    lightsailOk({ instanceSnapshots: [snap({ fromInstanceName: SERVER, sizeInGb: -1 })] }),
  );
  await expect(b.source.read(ACCOUNT)).rejects.toMatchObject({ reason: "usage_response_invalid" });
});

it("refuses an invalid account reference before any call", async () => {
  const { aws, source } = setup();
  await expect(source.read({ awsAccountId: "x", externalId: "y" })).rejects.toBeInstanceOf(
    AwsError,
  );
  expect(aws.seen).toHaveLength(0);
});
