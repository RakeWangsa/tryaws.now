import { expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { AwsError } from "../errors";
import { createLightsailReadSource, type ReadTargetRef } from "../reader-source";
import {
  ASSUMED,
  assumeRoleOk,
  expectNoLeak,
  fakeAws,
  lightsailError,
  lightsailOk,
} from "./fake-aws";

const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
const TARGET: ReadTargetRef = {
  account: { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" },
  region: "ap-southeast-1",
  instanceName: "tc-instance-9766a84e943a8987",
};

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

const body = (aws: ReturnType<typeof fakeAws>, action: string) =>
  JSON.parse(aws.seen.filter((r) => r.action === action).at(-1)!.body) as Record<string, unknown>;

it("reads the state of the instance named by the platform, through TcReader", async () => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetInstanceState", lightsailOk({ state: { code: 16, name: "running" } }));
  expect(await source.instanceState(TARGET)).toEqual({ state: "running" });
  expect(body(aws, "GetInstanceState")).toEqual({ instanceName: TARGET.instanceName });
  expect(aws.seen.find((r) => r.service === "sts")!.body).toContain("role%2FTcReader");
});

it("answers a missing instance with the state 'missing', not with an error", async () => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetInstanceState", lightsailError(400, "NotFoundException", "gone"));
  expect(await source.instanceState(TARGET)).toEqual({ state: "missing" });
});

it("asks for the four metrics with their own unit and statistic and maps the points", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetInstanceMetricData",
    lightsailOk({
      metricName: "CPUUtilization",
      metricData: [
        { timestamp: 1_800_000_060, average: 12.5, unit: "Percent" },
        { timestamp: 1_800_000_000, average: 3, unit: "Percent" },
      ],
    }),
  );
  const series = await source.instanceMetrics(TARGET, "1h");
  expect(series.map((s) => s.metric)).toEqual([
    "cpu",
    "networkIn",
    "networkOut",
    "statusCheckFailed",
  ]);
  // Points come back sorted by time, whatever order AWS used.
  expect(series[0]!.points.map((p) => p.value)).toEqual([3, 12.5]);
  const asked = aws.seen
    .filter((r) => r.action === "GetInstanceMetricData")
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  expect(asked.map((a) => [a["metricName"], a["unit"], a["statistics"]])).toEqual([
    ["CPUUtilization", "Percent", ["Average"]],
    ["NetworkIn", "Bytes", ["Sum"]],
    ["NetworkOut", "Bytes", ["Sum"]],
    ["StatusCheckFailed", "Count", ["Maximum"]],
  ]);
  for (const a of asked) {
    expect(a["period"]).toBe(300);
    expect(a["instanceName"]).toBe(TARGET.instanceName);
    expect((a["endTime"] as number) - (a["startTime"] as number)).toBe(3600);
  }
});

it("sums NetworkIn and NetworkOut over 30 days as the transfer used", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetInstanceMetricData",
    lightsailOk({
      metricData: [
        { timestamp: 1, sum: 1_000, unit: "Bytes" },
        { timestamp: 2, sum: 500, unit: "Bytes" },
      ],
    }),
  );
  expect(await source.transferUsed(TARGET)).toEqual({ bytes: 3_000, days: 30 });
  const asked = aws.seen
    .filter((r) => r.action === "GetInstanceMetricData")
    .map((r) => JSON.parse(r.body) as Record<string, unknown>);
  expect(asked.map((a) => a["metricName"]).sort()).toEqual(["NetworkIn", "NetworkOut"]);
  expect(asked[0]!["period"]).toBe(86_400);
});

it("lets only an AwsError out, with no AWS text, account id or ARN in it", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetInstanceMetricData",
    lightsailError(
      403,
      "AccessDeniedException",
      "User: arn:aws:sts::210987654321:assumed-role/TcReader/s is not authorized",
    ),
  );
  const error = await source.instanceMetrics(TARGET, "1d").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect((error as AwsError).code).toBe("forbidden");
  expectNoLeak(error);
});

it("refuses an instance name that is not a platform name (R11)", async () => {
  const { source } = setup();
  await expect(
    source.instanceState({ ...TARGET, instanceName: "my server" }),
  ).rejects.toBeInstanceOf(AwsError);
});
