import { inspect } from "node:util";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { expect, it } from "vitest";
import { AwsError } from "../errors";
import { createCredentialCache, createStsClient } from "../credentials";
import type { Caller } from "../roles";
import { ASSUMED, LEAK, RAW_ACCESS_DENIED, assumeRoleOk, fakeAws, stsError } from "./fake-aws";
import { blockedConnections } from "./network-guard";

const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const OTHER = { awsAccountId: "123456789012", externalId: "tc-ext-11aa22" };
const T0 = Date.parse("2026-11-11T12:00:00.000Z");
const ok = (expiration = "2026-11-11T13:00:00Z") => assumeRoleOk({ ...ASSUMED, expiration });

function setup(caller: Caller = "provisioner") {
  const aws = fakeAws();
  let now = T0;
  const cache = createCredentialCache({
    sts: createStsClient(aws.handler),
    caller,
    clock: { now: () => new Date(now) },
    randomHex16: () => "0123456789abcdef",
  });
  return {
    aws,
    cache,
    at: (iso: string) => {
      now = Date.parse(iso);
    },
  };
}
const form = (body: string) => Object.fromEntries(new URLSearchParams(body));

it("assumes the role with the ARN, the ExternalId, a generated session name and one hour", async () => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", ok());
  const creds = await cache.get(POOL, "TcProvisioner");
  expect(creds.accessKeyId).toBe("tc-test-assumed-key-1");
  expect(aws.seen[0]!.host).toBe("sts.ap-southeast-1.amazonaws.com");
  expect(form(aws.seen[0]!.body)).toEqual({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: "arn:aws:iam::210987654321:role/TcProvisioner",
    RoleSessionName: "tc-provisioner-0123456789abcdef",
    ExternalId: "tc-ext-7f3a9c",
    DurationSeconds: "3600",
  });
  expect(aws.seen[0]!.authorization).toContain("Credential=test-base-access-key/");
});

it("caches per pool account, ExternalId and role", async () => {
  const { aws, cache } = setup("reconciler");
  aws.on("sts", "AssumeRole", ok());
  await cache.get(POOL, "TcReader");
  await cache.get(POOL, "TcReader");
  await cache.get(POOL, "TcBillingReader");
  await cache.get(OTHER, "TcReader");
  await cache.get({ ...POOL, externalId: "tc-ext-rotated" }, "TcReader");
  expect(aws.seen.map((r) => form(r.body).RoleArn)).toEqual([
    "arn:aws:iam::210987654321:role/TcReader",
    "arn:aws:iam::210987654321:role/TcBillingReader",
    "arn:aws:iam::123456789012:role/TcReader",
    "arn:aws:iam::210987654321:role/TcReader",
  ]);
  // open point 1: the ExternalId goes with every role, not only TcProvisioner;
  // a different ExternalId for the same account and role is a new AssumeRole
  expect(aws.seen.map((r) => form(r.body).ExternalId)).toEqual([
    "tc-ext-7f3a9c",
    "tc-ext-7f3a9c",
    "tc-ext-11aa22",
    "tc-ext-rotated",
  ]);
  expect(aws.seen.map((r) => form(r.body).DurationSeconds)).toEqual([
    "3600",
    "3600",
    "3600",
    "3600",
  ]);
});

it("refreshes 5 minutes before expiry, not earlier", async () => {
  const { aws, cache, at } = setup();
  aws.on("sts", "AssumeRole", ok(), ok("2026-11-11T14:00:00Z"));
  await cache.get(POOL, "TcProvisioner");
  at("2026-11-11T12:54:59.000Z");
  await cache.get(POOL, "TcProvisioner");
  expect(aws.seen).toHaveLength(1);
  at("2026-11-11T12:55:00.000Z");
  const fresh = await cache.get(POOL, "TcProvisioner");
  expect(aws.seen).toHaveLength(2);
  expect(fresh.expiration.toISOString()).toBe("2026-11-11T14:00:00.000Z");
});

it("many concurrent callers share one AssumeRole", async () => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", ok());
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => cache.get(POOL, "TcProvisioner")));
  expect(aws.seen).toHaveLength(1);
  expect(new Set(all).size).toBe(1);
});

it("a refused AssumeRole fails closed, is not cached, and carries no ARN", async () => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", stsError(403, "AccessDenied", RAW_ACCESS_DENIED), ok());
  const error = await cache.get(POOL, "TcProvisioner").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({
    code: "forbidden",
    retryable: true,
    operation: "AssumeRole",
    awsErrorName: "AccessDenied",
  });
  expect(JSON.stringify(error) + String((error as Error).stack)).not.toMatch(LEAK);
  await expect(cache.get(POOL, "TcProvisioner")).resolves.toMatchObject({
    accessKeyId: "tc-test-assumed-key-1",
  });
  expect(aws.seen).toHaveLength(2);
});

it("never returns expired credentials when the refresh fails", async () => {
  const { aws, cache, at } = setup();
  aws.on("sts", "AssumeRole", ok(), stsError(403, "AccessDenied", "denied"));
  await cache.get(POOL, "TcProvisioner");
  at("2026-11-11T13:00:01.000Z");
  await expect(cache.get(POOL, "TcProvisioner")).rejects.toMatchObject({ code: "forbidden" });
});

it.each([
  [
    "no session token",
    assumeRoleOk({ ...ASSUMED, sessionToken: "", expiration: "2026-11-11T13:00:00Z" }),
  ],
  ["an expiration inside the margin", ok("2026-11-11T12:04:00Z")],
])("refuses an STS answer with %s", async (_label, reply) => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", reply);
  await expect(cache.get(POOL, "TcProvisioner")).rejects.toMatchObject({
    code: "upstream_unavailable",
    reason: "sts_response_invalid",
  });
});

it("the SDK retries a throttled AssumeRole by itself", async () => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", stsError(400, "Throttling", "Rate exceeded"), ok());
  await expect(cache.get(POOL, "TcProvisioner")).resolves.toBeDefined();
  expect(aws.seen).toHaveLength(2);
});

it("the production STS client (no test handler) has both time limits", async () => {
  blockedConnections.length = 0;
  const sts = createStsClient();
  await sts
    .send(
      new AssumeRoleCommand({
        RoleArn: "arn:aws:iam::210987654321:role/TcReader",
        RoleSessionName: "tc-test",
        ExternalId: "tc-ext-7f3a9c",
      }),
    )
    .catch(() => undefined); // blocked by the network guard
  expect(
    (sts.config.requestHandler as unknown as { httpHandlerConfigs(): object }).httpHandlerConfigs(),
  ).toMatchObject({ connectionTimeout: 3000, requestTimeout: 15000, throwOnRequestTimeout: true });
  expect(blockedConnections).toEqual(["sts.ap-southeast-1.amazonaws.com:443"]);
});

it("refuses a bad account reference before any request", async () => {
  const { aws, cache } = setup();
  await expect(
    cache.get({ awsAccountId: "12", externalId: "tc-ext-7f3a9c" }, "TcProvisioner"),
  ).rejects.toMatchObject({ reason: "account_ref_invalid" });
  expect(aws.seen).toHaveLength(0);
});

it("credentials cannot be serialised or printed by accident (R3, R14)", async () => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", ok());
  const creds = await cache.get(POOL, "TcProvisioner");
  expect(JSON.stringify({ creds })).toBe('{"creds":"[temporary AWS credentials]"}');
  expect(inspect(creds)).toBe("[temporary AWS credentials]");
  expect(`${creds}`).toBe("[temporary AWS credentials]");
  expect(inspect(cache, { depth: 10, showHidden: true })).not.toContain("tc-test-assumed-secret-1");
  expect(JSON.stringify(cache)).not.toContain("tc-test-assumed");
  expect(creds.secretAccessKey).toBe("tc-test-assumed-secret-1");
});

it("never asks STS for a role its caller may not use", async () => {
  const { aws, cache } = setup("reader");
  const error = await cache.get(POOL, "TcProvisioner").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ code: "forbidden", reason: "role_not_allowed" });
  expect(aws.seen).toHaveLength(0);
});

it("uses the account reference it checked, read once", async () => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", ok());
  let reads = 0;
  const shifting = {
    get awsAccountId() {
      reads += 1;
      return reads === 1 ? "210987654321" : "999999999999";
    },
    externalId: "tc-ext-7f3a9c",
  };
  await cache.get(shifting, "TcProvisioner");
  expect(reads).toBe(1);
  expect(form(aws.seen[0]!.body).RoleArn).toBe("arn:aws:iam::210987654321:role/TcProvisioner");
});

it("every failure of get is an AwsError, also a failure of this package's own code", async () => {
  const aws = fakeAws();
  const cache = createCredentialCache({
    sts: createStsClient(aws.handler),
    caller: "provisioner",
    clock: { now: () => new Date(T0) },
    randomHex16: () => "not-16-hex",
  });
  const error = await cache.get(POOL, "TcProvisioner").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ code: "internal", retryable: true, operation: "AssumeRole" });
  expect(aws.seen).toHaveLength(0);
});

it("a refresh that fails inside the margin refuses, although the old credentials are still valid", async () => {
  const { aws, cache, at } = setup();
  aws.on(
    "sts",
    "AssumeRole",
    ok(),
    stsError(403, "AccessDenied", "denied"),
    ok("2026-11-11T14:00:00Z"),
  );
  await cache.get(POOL, "TcProvisioner");
  at("2026-11-11T12:56:00.000Z");
  await expect(cache.get(POOL, "TcProvisioner")).rejects.toMatchObject({
    code: "forbidden",
    operation: "AssumeRole",
  });
  const next = await cache.get(POOL, "TcProvisioner");
  expect(next.expiration.toISOString()).toBe("2026-11-11T14:00:00.000Z");
  expect(aws.seen).toHaveLength(3);
});

it("five concurrent callers share one failed AssumeRole, and the next call tries again", async () => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", stsError(403, "AccessDenied", "denied"), ok());
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map(() => cache.get(POOL, "TcProvisioner")),
  );
  expect(results.map((r) => r.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
    "rejected",
    "rejected",
  ]);
  expect(aws.seen).toHaveLength(1);
  await expect(cache.get(POOL, "TcProvisioner")).resolves.toMatchObject({
    accessKeyId: "tc-test-assumed-key-1",
  });
  expect(aws.seen).toHaveLength(2);
});

it("five concurrent callers inside the margin share one refresh and all get the new credentials", async () => {
  const { aws, cache, at } = setup();
  aws.on("sts", "AssumeRole", ok(), ok("2026-11-11T14:00:00Z"));
  const old = await cache.get(POOL, "TcProvisioner");
  at("2026-11-11T12:57:00.000Z");
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => cache.get(POOL, "TcProvisioner")));
  expect(aws.seen).toHaveLength(2);
  expect(new Set(all).size).toBe(1);
  expect(all[0]).not.toBe(old);
  expect(all[0]!.expiration.toISOString()).toBe("2026-11-11T14:00:00.000Z");
});

it.each([
  [
    "no access key id",
    assumeRoleOk({ ...ASSUMED, accessKeyId: "", expiration: "2026-11-11T13:00:00Z" }),
  ],
  [
    "no secret access key",
    assumeRoleOk({ ...ASSUMED, secretAccessKey: "", expiration: "2026-11-11T13:00:00Z" }),
  ],
  ["an expiration in the past", ok("2026-11-11T11:00:00Z")],
  ["an expiration exactly at the margin", ok("2026-11-11T12:05:00Z")],
])("refuses an STS answer with %s, and caches nothing", async (_label, reply) => {
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", reply, ok());
  await expect(cache.get(POOL, "TcProvisioner")).rejects.toMatchObject({
    code: "upstream_unavailable",
    retryable: true,
    reason: "sts_response_invalid",
    operation: "AssumeRole",
  });
  await expect(cache.get(POOL, "TcProvisioner")).resolves.toMatchObject({
    accessKeyId: "tc-test-assumed-key-1",
  });
  expect(aws.seen).toHaveLength(2);
});

it("an answer whose expiration is not a date fails closed", async () => {
  // the SDK itself refuses the answer while it parses it; the caller gets an AwsError and nothing is cached
  const { aws, cache } = setup();
  aws.on("sts", "AssumeRole", ok("soon"), ok());
  const error = await cache.get(POOL, "TcProvisioner").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ retryable: true, operation: "AssumeRole" });
  expect(JSON.stringify(error) + String((error as Error).stack)).not.toMatch(
    /soon|tc-test-assumed/,
  );
  await expect(cache.get(POOL, "TcProvisioner")).resolves.toBeDefined();
  expect(aws.seen).toHaveLength(2);
});

it("the role is refused before the account reference is looked at, and a getter that throws gives an AwsError", async () => {
  const { aws, cache } = setup("reader");
  await expect(
    cache.get({ awsAccountId: "12", externalId: "" }, "TcProvisioner"),
  ).rejects.toMatchObject({
    reason: "role_not_allowed",
  });
  const broken = {
    get awsAccountId(): string {
      throw new Error("arn:aws:iam::210987654321:role/Secret");
    },
    externalId: "tc-ext-7f3a9c",
  };
  const error = await cache.get(broken, "TcReader").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ code: "internal", retryable: true, operation: "AssumeRole" });
  expect(JSON.stringify(error) + String((error as Error).stack)).not.toMatch(LEAK);
  expect(aws.seen).toHaveLength(0);
});
