import { expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { AwsError } from "../errors";
import { createLightsailReadSource } from "../reader-source";
import {
  ASSUMED,
  assumeRoleOk,
  expectNoLeak,
  fakeAws,
  lightsailError,
  lightsailOk,
} from "./fake-aws";

// WPU-Y8: load balancer target health and database metrics (contract F, reader additions).
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const ACCOUNT = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const LB = {
  account: ACCOUNT,
  region: "ap-southeast-1",
  loadBalancerName: "tc-lb-9766a84e943a8987",
} as const;
const DB = {
  account: ACCOUNT,
  region: "ap-southeast-1",
  databaseName: "tc-database-9766a84e943a8987",
} as const;
const S1 = "tc-instance-1111111111111111";
const S2 = "tc-instance-2222222222222222";
const KNOWN = new Map([
  [S1, "id-one"],
  [S2, "id-two"],
]);

function setup() {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  const access = createAwsAccessInternal({ caller: "reader", clock, requestHandler: aws.handler });
  return { aws, source: createLightsailReadSource(access, clock) };
}
const lbReply = (summary: unknown[], name: string = LB.loadBalancerName) =>
  lightsailOk({ loadBalancer: { name, instanceHealthSummary: summary } });
const bodies = (aws: ReturnType<typeof fakeAws>, action: string) =>
  aws.seen
    .filter((r) => r.action === action)
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);

it("maps health states and reasons to platform words and resolves names only against the known list", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetLoadBalancer",
    lbReply([
      { instanceName: S2, instanceHealth: "unhealthy", instanceHealthReason: "Instance.Timeout" },
      { instanceName: S1, instanceHealth: "healthy", instanceHealthReason: "Lb.InternalError" },
      { instanceName: "tc-instance-ffffffffffffffff", instanceHealth: "healthy" },
    ]),
  );
  const got = await source.loadBalancerTargetHealth(LB, KNOWN);
  expect(got).toEqual({
    targets: [
      { targetResourceId: "id-one", health: "healthy", reason: null },
      { targetResourceId: "id-two", health: "unhealthy", reason: "timeout" },
    ],
    unresolved: 1,
  });
  expect(bodies(aws, "GetLoadBalancer")[0]).toEqual({ loadBalancerName: LB.loadBalancerName });
  expect(aws.seen.find((r) => r.service === "sts")!.body).toContain("role%2FTcReader");
  expectNoLeak(got);
});

it("maps every contract reason and sends unknown values to unavailable/unknown", async () => {
  const pairs: [string, string][] = [
    ["Lb.RegistrationInProgress", "registering"],
    ["Lb.InitialHealthChecking", "initial_checks"],
    ["Instance.ResponseCodeMismatch", "response_code_mismatch"],
    ["Instance.Timeout", "timeout"],
    ["Instance.FailedHealthChecks", "failed_checks"],
    ["Lb.InternalError", "internal_error"],
    ["Instance.NotRegistered", "not_registered"],
    ["Instance.NotInUse", "not_in_use"],
    ["Instance.IpUnusable", "ip_unusable"],
    ["Instance.InvalidState", "stopped"],
    ["Instance.DeregistrationInProgress", "deregistering"],
    ["Something.New", "unknown"],
  ];
  for (const [awsReason, word] of pairs) {
    const { aws, source } = setup();
    aws.on(
      "lightsail",
      "GetLoadBalancer",
      lbReply([{ instanceName: S1, instanceHealth: "unhealthy", instanceHealthReason: awsReason }]),
    );
    expect((await source.loadBalancerTargetHealth(LB, KNOWN)).targets[0]!.reason).toBe(word);
  }
  const { aws, source } = setup();
  aws.on("lightsail", "GetLoadBalancer", lbReply([{ instanceName: S1, instanceHealth: "weird" }]));
  expect((await source.loadBalancerTargetHealth(LB, KNOWN)).targets[0]).toEqual({
    targetResourceId: "id-one",
    health: "unavailable",
    reason: null,
  });
});

it("fails closed: bad names, another load balancer, duplicates, over 20 targets, AWS errors", async () => {
  const { source } = setup();
  await expect(
    source.loadBalancerTargetHealth({ ...LB, loadBalancerName: "my lb" }, KNOWN),
  ).rejects.toBeInstanceOf(AwsError);
  await expect(
    source.databaseMetrics({ ...DB, databaseName: "tc-instance-9766a84e943a8987" }, "1h"),
  ).rejects.toBeInstanceOf(AwsError);
  await expect(source.databaseMetrics(DB, "2y" as never)).rejects.toBeInstanceOf(AwsError);

  const other = setup();
  other.aws.on("lightsail", "GetLoadBalancer", lbReply([], "tc-lb-0000000000000000"));
  await expect(other.source.loadBalancerTargetHealth(LB, KNOWN)).rejects.toBeInstanceOf(AwsError);

  const dup = setup();
  dup.aws.on(
    "lightsail",
    "GetLoadBalancer",
    lbReply([
      { instanceName: S1, instanceHealth: "healthy" },
      { instanceName: S1, instanceHealth: "healthy" },
    ]),
  );
  await expect(dup.source.loadBalancerTargetHealth(LB, KNOWN)).rejects.toBeInstanceOf(AwsError);

  const many = setup();
  many.aws.on(
    "lightsail",
    "GetLoadBalancer",
    lbReply(
      Array.from({ length: 21 }, (_, i) => ({
        instanceName: `tc-instance-${String(i).padStart(16, "0")}`,
        instanceHealth: "healthy",
      })),
    ),
  );
  await expect(many.source.loadBalancerTargetHealth(LB, KNOWN)).rejects.toBeInstanceOf(AwsError);

  const denied = setup();
  denied.aws.on(
    "lightsail",
    "GetLoadBalancer",
    lightsailError(403, "AccessDeniedException", "arn:aws:sts::210987654321:x not authorized"),
  );
  const e = await denied.source.loadBalancerTargetHealth(LB, KNOWN).catch((x: unknown) => x);
  expect((e as AwsError).code).toBe("forbidden");
  expectNoLeak(e);

  const missing = setup();
  missing.aws.on("lightsail", "GetLoadBalancer", lightsailError(400, "NotFoundException", "gone"));
  const m = await missing.source.loadBalancerTargetHealth(LB, KNOWN).catch((x: unknown) => x);
  expect((m as AwsError).code).toBe("not_found");
});

it("reads the four database series with the contract statistics, units and periods", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetRelationalDatabaseMetricData",
    lightsailOk({
      metricData: [
        { timestamp: 1_800_000_060, average: 2, maximum: 5, minimum: 7 },
        { timestamp: 1_800_000_000, average: 1, maximum: 4, minimum: 6 },
        { timestamp: 1_800_000_120 },
      ],
    }),
  );
  const got = await source.databaseMetrics(DB, "1d");
  expect(got.map((s) => [s.metric, s.unit, s.statistic, s.periodSeconds])).toEqual([
    ["cpu", "percent", "average", 900],
    ["connections", "count", "maximum", 900],
    ["freeStorage", "bytes", "minimum", 900],
    ["diskQueue", "count", "maximum", 900],
  ]);
  expect(got[0]!.points.map((p) => p.value)).toEqual([1, 2]);
  expect(got[2]!.points.map((p) => p.value)).toEqual([6, 7]);
  const asked = bodies(aws, "GetRelationalDatabaseMetricData");
  expect(asked.map((a) => [a["metricName"], a["unit"], a["statistics"]])).toEqual([
    ["CPUUtilization", "Percent", ["Average"]],
    ["DatabaseConnections", "Count", ["Maximum"]],
    ["FreeStorageSpace", "Bytes", ["Minimum"]],
    ["DiskQueueDepth", "Count", ["Maximum"]],
  ]);
  for (const a of asked) {
    expect(a["relationalDatabaseName"]).toBe(DB.databaseName);
    expect(a["period"]).toBe(900);
    expect((a["endTime"] as number) - (a["startTime"] as number)).toBe(86_400);
  }
  expectNoLeak(got);
});

it("uses the periods 300 and 3600 for 1h and 1w", async () => {
  for (const [range, period] of [
    ["1h", 300],
    ["1w", 3600],
  ] as const) {
    const { aws, source } = setup();
    aws.on("lightsail", "GetRelationalDatabaseMetricData", lightsailOk({ metricData: [] }));
    const got = await source.databaseMetrics(DB, range);
    expect(got.every((s) => s.periodSeconds === period && s.points.length === 0)).toBe(true);
  }
});

it("refuses a negative value, an AWS error or a wrong metric name: no partial series", async () => {
  const neg = setup();
  neg.aws.on(
    "lightsail",
    "GetRelationalDatabaseMetricData",
    lightsailOk({
      metricData: [{ timestamp: 1_800_000_000, average: -1, maximum: -1, minimum: -1 }],
    }),
  );
  await expect(neg.source.databaseMetrics(DB, "1h")).rejects.toBeInstanceOf(AwsError);

  const wrong = setup();
  wrong.aws.on(
    "lightsail",
    "GetRelationalDatabaseMetricData",
    lightsailOk({ metricName: "NetworkIn", metricData: [] }),
  );
  await expect(wrong.source.databaseMetrics(DB, "1h")).rejects.toBeInstanceOf(AwsError);

  const fail = setup();
  fail.aws.on(
    "lightsail",
    "GetRelationalDatabaseMetricData",
    lightsailOk({ metricData: [] }),
    lightsailOk({ metricData: [] }),
    lightsailError(400, "NotFoundException", "gone"),
  );
  const e = await fail.source.databaseMetrics(DB, "1h").catch((x: unknown) => x);
  expect((e as AwsError).code).toBe("not_found");
});
