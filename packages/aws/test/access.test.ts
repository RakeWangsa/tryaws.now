import { inspect } from "node:util";
import { GetRegionsCommand } from "@aws-sdk/client-lightsail";
import { expect, it } from "vitest";
import { createAwsAccess, createAwsAccessInternal } from "../access";
import { createStsClient } from "../credentials";
import { CALLER_ROLES, LIGHTSAIL_ROLES } from "../roles";
import { AwsError } from "../errors";
import { blockedConnections } from "./network-guard";
import {
  ASSUMED,
  expectNoLeak,
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
  return { aws, access: createAwsAccessInternal({ caller, clock, requestHandler: aws.handler }) };
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
  const access = createAwsAccessInternal({ caller: "reader", clock, requestHandler: aws.handler });
  const error = await access
    .lightsail(POOL, "ap-southeast-1", "TcReader")
    .send(new GetRegionsCommand({}))
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ name: "AwsError", code: "forbidden", operation: "AssumeRole" });
  expectNoLeak(error);
  expect(aws.seen.filter((r) => r.service === "lightsail")).toHaveLength(0);
});

it("the client does not print the secret, and the access object holds only caller, lightsail and route53", async () => {
  const { aws, access } = setup("provisioner");
  aws.on("lightsail", "GetRegions", lightsailOk({ regions: [] }));
  const client = access.lightsail(POOL, "ap-southeast-1", "TcProvisioner");
  await client.send(new GetRegionsCommand({}));
  const printed =
    inspect(client, { depth: 12, showHidden: true }) +
    inspect(access, { depth: 12, showHidden: true });
  for (const secret of ["tc-test-assumed-secret-1", "tc-test-assumed-token-1", "tc-ext-7f3a9c"]) {
    expect(printed).not.toContain(secret);
  }
  expect(Object.keys(access).sort()).toEqual(["caller", "lightsail", "route53", "route53Domains"]);
});

it("with the real transport, nothing leaves the machine, and the time limits are set", async () => {
  blockedConnections.length = 0;
  const access = createAwsAccess({ caller: "reader", clock });
  const client = access.lightsail(POOL, "ap-southeast-1", "TcReader");
  const error = await client.send(new GetRegionsCommand({})).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(blockedConnections).toEqual(["sts.ap-southeast-1.amazonaws.com:443"]);
  const handler = client.config.requestHandler as unknown as {
    handle(request: object): Promise<unknown>;
    httpHandlerConfigs(): object;
  };
  await handler
    .handle({
      protocol: "https:",
      hostname: "lightsail.ap-southeast-1.amazonaws.com",
      port: 443,
      method: "POST",
      path: "/",
      headers: {},
      query: {},
    })
    .catch(() => undefined); // blocked by the network guard
  expect(handler.httpHandlerConfigs()).toMatchObject({
    connectionTimeout: 3000,
    requestTimeout: 15000,
    throwOnRequestTimeout: true,
    socketTimeout: 15000,
  });
  expect(blockedConnections).toEqual([
    "sts.ap-southeast-1.amazonaws.com:443",
    "lightsail.ap-southeast-1.amazonaws.com:443",
  ]);
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

it.each([
  ["HTTP 500", lightsailError(500, "ServiceException", "internal")],
  ["a socket timeout (ETIMEDOUT)", { networkCode: "ETIMEDOUT" }],
  ["the SDK request timeout", { errorName: "TimeoutError" }],
] as const)(
  "a reader call that fails with %s is sent 3 times (reads are safe to repeat)",
  async (_label, reply) => {
    const { aws, access } = setup("reader");
    aws.on("lightsail", "GetRegions", reply);
    const client = access.lightsail(POOL, "ap-southeast-1", "TcReader");
    await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
      name: "AwsError",
      code: "upstream_unavailable",
    });
    expect(aws.seen.filter((r) => r.service === "lightsail")).toHaveLength(3);
  },
  15_000,
);

it("the access object cannot be changed, and its caller stays the one it was made for", () => {
  const { access } = setup("reader");
  expect(Object.isFrozen(access)).toBe(true);
  expect(() => {
    (access as { caller: string }).caller = "provisioner";
  }).toThrow(TypeError);
  expect(access.caller).toBe("reader");
  expect(() => access.lightsail(POOL, "ap-southeast-1", "TcProvisioner" as never)).toThrow(
    /role_not_allowed/,
  );
});
it("the public options offer only caller and clock: a handler passed to createAwsAccess is dropped (W34)", async () => {
  const aws = fakeAws();
  blockedConnections.length = 0;
  const access = createAwsAccess({
    caller: "reader",
    clock,
    requestHandler: aws.handler,
  } as never);
  await access
    .lightsail(POOL, "ap-southeast-1", "TcReader")
    .send(new GetRegionsCommand({}))
    .catch(() => undefined); // the real transport: blocked by the network guard
  expect(aws.seen).toHaveLength(0);
  expect(blockedConnections).toEqual(["sts.ap-southeast-1.amazonaws.com:443"]);
});

it("an ExpiredTokenException drops the session: the next call assumes the role again (W31)", async () => {
  const { aws, access } = setup("provisioner");
  aws.on(
    "lightsail",
    "GetRegions",
    lightsailError(400, "ExpiredTokenException", "The security token included is expired"),
    lightsailOk({ regions: [] }),
  );
  const client = access.lightsail(POOL, "ap-southeast-1", "TcProvisioner");
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    code: "unauthenticated",
    operation: "GetRegions",
  });
  expect(aws.seen.filter((r) => r.service === "sts")).toHaveLength(1);
  await client.send(new GetRegionsCommand({}));
  expect(aws.seen.filter((r) => r.service === "sts")).toHaveLength(2);
});

it("a denied role is not refreshed against STS more than once inside the floor of 30 seconds (W31)", async () => {
  let offset = 0;
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({
      ...ASSUMED,
      expiration: new Date(NOW + 3_600_000).toISOString(),
    }),
  );
  aws.on("lightsail", "GetRegions", lightsailError(403, "AccessDeniedException", "denied"));
  const access = createAwsAccessInternal({
    caller: "provisioner",
    clock: { now: () => new Date(NOW + offset) },
    requestHandler: aws.handler,
  });
  const client = access.lightsail(POOL, "ap-southeast-1", "TcProvisioner");
  const sts = () => aws.seen.filter((r) => r.service === "sts").length;
  for (let i = 0; i < 4; i += 1) {
    await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
      code: "forbidden",
    });
  }
  expect(sts()).toBe(2); // the first session, and one refresh; the floor held the rest back
  offset = 31_000;
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(sts()).toBe(3); // the floor is over: one more refresh
});

it("a failed AssumeRole does not start the refresh logic: every call asks STS (W31)", async () => {
  const aws = fakeAws();
  aws.on("sts", "AssumeRole", stsError(403, "AccessDenied", RAW_ACCESS_DENIED));
  const access = createAwsAccessInternal({
    caller: "reader",
    clock,
    requestHandler: aws.handler,
  });
  const client = access.lightsail(POOL, "ap-southeast-1", "TcReader");
  for (let i = 0; i < 2; i += 1) {
    await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
      operation: "AssumeRole",
    });
  }
  expect(aws.seen.filter((r) => r.service === "sts")).toHaveLength(2);
});

it("two accounts with one ExternalId, and one rotated ExternalId, get different clients with their own AssumeRole (6.3)", async () => {
  const { aws, access } = setup("reader");
  aws.on("lightsail", "GetRegions", lightsailOk({ regions: [] }));
  const other = { awsAccountId: "123456789012", externalId: POOL.externalId };
  const rotated = {
    awsAccountId: POOL.awsAccountId,
    externalId: "tc-ext-rotated",
  };
  const clients = [POOL, other, rotated].map((ref) =>
    access.lightsail(ref, "ap-southeast-1", "TcReader"),
  );
  expect(new Set(clients).size).toBe(3);
  for (const client of clients) await client.send(new GetRegionsCommand({}));
  const bodies = aws.seen
    .filter((r) => r.service === "sts")
    .map((r) => Object.fromEntries(new URLSearchParams(r.body)));
  expect(bodies.map((b) => [b.RoleArn, b.ExternalId])).toEqual([
    ["arn:aws:iam::210987654321:role/TcReader", "tc-ext-7f3a9c"],
    ["arn:aws:iam::123456789012:role/TcReader", "tc-ext-7f3a9c"],
    ["arn:aws:iam::210987654321:role/TcReader", "tc-ext-rotated"],
  ]);
});

it("the real clock of the access: an answer that expires in 4 minutes is refused, one hour is accepted (6.1)", async () => {
  const run = async (aheadMs: number) => {
    const aws = fakeAws();
    aws.on(
      "sts",
      "AssumeRole",
      assumeRoleOk({
        ...ASSUMED,
        expiration: new Date(Date.now() + aheadMs).toISOString(),
      }),
    );
    aws.on("lightsail", "GetRegions", lightsailOk({ regions: [] }));
    // no clock option: the default, real clock
    const access = createAwsAccessInternal({
      caller: "reader",
      requestHandler: aws.handler,
    });
    return access
      .lightsail(POOL, "ap-southeast-1", "TcReader")
      .send(new GetRegionsCommand({}))
      .then(
        () => "ok",
        (e: unknown) => e,
      );
  };
  expect(await run(4 * 60_000)).toMatchObject({
    code: "upstream_unavailable",
    reason: "sts_response_invalid",
  });
  expect(await run(3_600_000)).toBe("ok");
});

it("every client the package builds has no logger of its own (the SDK's NoOpLogger) (2.1, 2.2)", () => {
  expect(createStsClient().config.logger?.constructor?.name).toBe("NoOpLogger");
  expect(createStsClient(fakeAws().handler).config.logger?.constructor?.name).toBe("NoOpLogger");
  for (const caller of Object.keys(CALLER_ROLES) as (keyof typeof CALLER_ROLES)[]) {
    const access = createAwsAccessInternal({
      caller,
      clock,
      requestHandler: fakeAws().handler,
    });
    for (const role of CALLER_ROLES[caller]) {
      if (!(LIGHTSAIL_ROLES as readonly string[]).includes(role)) continue;
      const client = access.lightsail(POOL, "ap-southeast-1", role as never);
      expect(client.config.logger?.constructor?.name).toBe("NoOpLogger");
    }
  }
});

it("a refused AssumeRole does not use up the floor of a later real rejection (W31)", async () => {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    stsError(403, "AccessDenied", RAW_ACCESS_DENIED),
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  aws.on(
    "lightsail",
    "GetRegions",
    lightsailError(400, "ExpiredTokenException", "expired"),
    lightsailOk({ regions: [] }),
  );
  const access = createAwsAccessInternal({ caller: "reader", clock, requestHandler: aws.handler });
  const client = access.lightsail(POOL, "ap-southeast-1", "TcReader");
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    operation: "AssumeRole",
  });
  await expect(client.send(new GetRegionsCommand({}))).rejects.toMatchObject({
    code: "unauthenticated",
    operation: "GetRegions",
  });
  await client.send(new GetRegionsCommand({}));
  expect(aws.seen.filter((r) => r.service === "sts")).toHaveLength(3);
});
