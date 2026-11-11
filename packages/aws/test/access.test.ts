import { inspect } from "node:util";
import { GetRegionsCommand } from "@aws-sdk/client-lightsail";
import { expect, it } from "vitest";
import { createAwsAccess } from "../access";
import { AwsError } from "../errors";
import { blockedConnections } from "./network-guard";
import {
  ASSUMED,
  LEAK,
  RAW_ACCESS_DENIED,
  assumeRoleOk,
  fakeAws,
  lightsailError,
  lightsailOk,
  stsError,
} from "./fake-aws";

const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
// The SDK reads the real clock when it decides whether credentials have expired.
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };
function setup<C extends "provisioner" | "reader" | "catalog-sync">(caller: C) {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  return { aws, access: createAwsAccess({ caller, clock, requestHandler: aws.handler }) };
}

it("signs Lightsail calls with the assumed role, in the asked Region", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("lightsail", "GetRegions", lightsailOk({ regions: [] }));
  await access.lightsail(POOL, "ap-south-1", "TcProvisioner").send(new GetRegionsCommand({}));
  const call = aws.seen.find((r) => r.service === "lightsail")!;
  expect(call.host).toBe("lightsail.ap-south-1.amazonaws.com");
  expect(call.authorization).toContain("Credential=tc-test-assumed-key-1/");
});

it("a caller cannot get a role that does not trust it", () => {
  const { access } = setup("reader");
  // @ts-expect-error reader may not use TcProvisioner
  expect(() => access.lightsail(POOL, "ap-southeast-1", "TcProvisioner")).toThrow(AwsError);
  const sync = setup("catalog-sync").access;
  expect(() => sync.lightsail(POOL, "ap-southeast-1", "TcAccessDetails" as never)).toThrow(
    /role_not_allowed/,
  );
  expect(() => sync.lightsail(POOL, "ap-southeast-1", "TcDnsReader" as never)).toThrow(
    /role_not_allowed/,
  );
});

it("refuses a Region outside the SCP and a bad account before any request", () => {
  const { aws, access } = setup("reader");
  expect(() => access.lightsail(POOL, "eu-west-1" as never, "TcReader")).toThrow(
    /region_not_allowed/,
  );
  expect(() => access.lightsail({ ...POOL, externalId: "" }, "ap-southeast-1", "TcReader")).toThrow(
    /account_ref_invalid/,
  );
  expect(aws.seen).toHaveLength(0);
});

it("returns one client per account, role and Region", () => {
  const { access } = setup("reader");
  const a = access.lightsail(POOL, "ap-southeast-1", "TcReader");
  expect(access.lightsail(POOL, "ap-southeast-1", "TcReader")).toBe(a);
  expect(access.lightsail(POOL, "ap-south-1", "TcReader")).not.toBe(a);
});

it.each([
  ["provisioner", "TcProvisioner"],
  ["reader", "TcReader"],
] as const)(
  "a throttled call of the %s is sent 3 times (spec section 4)",
  async (caller, role) => {
    const { aws, access } = setup(caller);
    aws.on("lightsail", "GetRegions", lightsailError(400, "ThrottlingException", "Rate exceeded"));
    const client = access.lightsail(POOL, "ap-southeast-1", role as never);
    await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
      name: "AwsError",
      code: "rate_limited",
      operation: "GetRegions",
    });
    expect(aws.seen.filter((r) => r.service === "lightsail")).toHaveLength(3);
  },
  15_000, // two throttling waits: up to 1 s and 2 s
);

it.each([
  ["HTTP 500", lightsailError(500, "ServiceException", "internal")],
  ["a socket timeout (ETIMEDOUT)", { networkCode: "ETIMEDOUT" }],
  ["the SDK request timeout", { errorName: "TimeoutError" }],
] as const)("a provisioner call that fails with %s is sent once", async (_label, reply) => {
  const { aws, access } = setup("provisioner");
  aws.on("lightsail", "GetRegions", reply);
  const client = access.lightsail(POOL, "ap-southeast-1", "TcProvisioner");
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    name: "AwsError",
    code: "upstream_unavailable",
  });
  expect(aws.seen.filter((r) => r.service === "lightsail")).toHaveLength(1);
});

it("a refused AssumeRole stops the call before Lightsail is reached (R16)", async () => {
  const aws = fakeAws();
  aws.on("sts", "AssumeRole", stsError(403, "AccessDenied", RAW_ACCESS_DENIED));
  const access = createAwsAccess({ caller: "reader", clock, requestHandler: aws.handler });
  const error = await access
    .lightsail(POOL, "ap-southeast-1", "TcReader")
    .send(new GetRegionsCommand({}))
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ name: "AwsError", code: "forbidden", operation: "AssumeRole" });
  expect(String((error as Error).message)).not.toMatch(LEAK);
  expect(aws.seen.filter((r) => r.service === "lightsail")).toHaveLength(0);
});

it("the client does not print the secret, and the access object holds only caller and lightsail", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("lightsail", "GetRegions", lightsailOk({ regions: [] }));
  const client = access.lightsail(POOL, "ap-southeast-1", "TcProvisioner");
  await client.send(new GetRegionsCommand({}));
  expect(inspect(client, { depth: 12 })).not.toContain("tc-test-assumed-secret-1");
  expect(Object.keys(access).sort()).toEqual(["caller", "lightsail"]);
});

it("with the real transport, nothing leaves the machine, and the time limits are set", async () => {
  blockedConnections.length = 0;
  const access = createAwsAccess({ caller: "reader", clock });
  const client = access.lightsail(POOL, "ap-southeast-1", "TcReader");
  const error = await client.send(new GetRegionsCommand({})).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(blockedConnections).toEqual(["sts.ap-southeast-1.amazonaws.com:443"]);
  // The handler resolves its settings on its first request, which never happens here (STS is
  // refused first), so the settings are read from the handler's own provider.
  const handler = client.config.requestHandler as unknown as { configProvider: Promise<object> };
  await expect(handler.configProvider).resolves.toMatchObject({
    connectionTimeout: 3000,
    requestTimeout: 15000,
    throwOnRequestTimeout: true,
  });
});

it("refuses a caller that is not one of the platform's functions", () => {
  for (const caller of ["admin", "web", "__proto__", "constructor", "", undefined]) {
    const thrown = (() => {
      try {
        createAwsAccess({ caller: caller as never, clock });
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(AwsError);
    expect(thrown).toMatchObject({ code: "forbidden", reason: "role_not_allowed" });
  }
});

it("uses the account reference it checked, read once, and gives no client a logger", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("lightsail", "GetRegions", lightsailOk({ regions: [] }));
  let reads = 0;
  const shifting = {
    get awsAccountId() {
      reads += 1;
      return reads === 1 ? "210987654321" : "999999999999";
    },
    externalId: "tc-ext-7f3a9c",
  };
  const client = access.lightsail(shifting, "ap-southeast-1", "TcProvisioner");
  await client.send(new GetRegionsCommand({}));
  expect(reads).toBe(1);
  const assume = aws.seen.find((r) => r.service === "sts")!;
  expect(new URLSearchParams(assume.body).get("RoleArn")).toBe(
    "arn:aws:iam::210987654321:role/TcProvisioner",
  );
  // the SDK's default logger writes nothing; a real logger would get the raw AWS error text
  expect(client.config.logger?.constructor?.name).toBe("NoOpLogger");
});
