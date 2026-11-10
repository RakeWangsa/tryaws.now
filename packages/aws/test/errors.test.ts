import { inspect } from "node:util";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { CreateInstancesCommand, LightsailClient } from "@aws-sdk/client-lightsail";
import { expect, it } from "vitest";
import { AwsError, mapErrors, toAwsError, toLogFields } from "../errors";
import { LEAK, RAW_ACCESS_DENIED as RAW, fakeAws, lightsailError, stsError } from "./fake-aws";

const sdk = (name: string, status: number | undefined, message = "x") =>
  Object.assign(new Error(message), {
    name,
    $fault: "client",
    $metadata: { httpStatusCode: status, requestId: "req-1" },
  });
const net = (code: string) => Object.assign(new Error("socket"), { code });

it.each([
  [
    "Lightsail throttling",
    sdk("ThrottlingException", 400),
    "rate_limited",
    true,
    false,
    "ThrottlingException",
  ],
  [
    "HTTP 429 of an unknown name",
    sdk("SlowDownPlease", 429),
    "rate_limited",
    true,
    false,
    "SlowDownPlease",
  ],
  [
    "Lightsail service fault",
    sdk("ServiceException", 500),
    "upstream_unavailable",
    true,
    false,
    "ServiceException",
  ],
  [
    "common internal failure",
    sdk("InternalFailure", 500),
    "upstream_unavailable",
    true,
    false,
    "InternalFailure",
  ],
  [
    "service unavailable",
    sdk("ServiceUnavailable", 503),
    "upstream_unavailable",
    true,
    false,
    "ServiceUnavailable",
  ],
  ["HTTP 502 of an unknown name", sdk("Weird", 502), "upstream_unavailable", true, false, "Weird"],
  [
    "account setup in progress",
    sdk("AccountSetupInProgressException", 400),
    "upstream_unavailable",
    true,
    false,
    "AccountSetupInProgressException",
  ],
  [
    "Region setup in progress",
    sdk("RegionSetupInProgressException", 400),
    "upstream_unavailable",
    true,
    false,
    "RegionSetupInProgressException",
  ],
  [
    "invalid input",
    sdk("InvalidInputException", 400, "The blueprint is not valid"),
    "validation",
    false,
    false,
    "InvalidInputException",
  ],
  ["validation error", sdk("ValidationError", 400), "validation", false, false, "ValidationError"],
  ["not found", sdk("NotFoundException", 400), "not_found", true, false, "NotFoundException"],
  [
    "operation failure",
    sdk("OperationFailureException", 400, "The instance is not in a valid state"),
    "conflict",
    true,
    false,
    "OperationFailureException",
  ],
  [
    "name already in use",
    sdk(
      "InvalidInputException",
      400,
      "Some names are already in use: tc-instance-9766a84e943a8987",
    ),
    "conflict",
    true,
    false,
    "InvalidInputException",
  ],
  [
    "Lightsail access denied",
    sdk("AccessDeniedException", 403),
    "forbidden",
    true,
    false,
    "AccessDeniedException",
  ],
  ["STS access denied", sdk("AccessDenied", 403, RAW), "forbidden", true, false, "AccessDenied"],
  ["opt-in required", sdk("OptInRequired", 403), "forbidden", true, false, "OptInRequired"],
  [
    "unauthenticated",
    sdk("UnauthenticatedException", 400),
    "unauthenticated",
    true,
    false,
    "UnauthenticatedException",
  ],
  [
    "expired token",
    sdk("ExpiredTokenException", 403),
    "unauthenticated",
    true,
    false,
    "ExpiredTokenException",
  ],
  [
    "unknown key id",
    sdk("InvalidClientTokenId", 403),
    "unauthenticated",
    true,
    false,
    "InvalidClientTokenId",
  ],
  [
    "quota in an invalid-input message",
    sdk("InvalidInputException", 400, "Sorry, you've reached the maximum number of instances"),
    "capacity_full",
    true,
    true,
    "InvalidInputException",
  ],
  [
    "quota in an operation failure",
    sdk("OperationFailureException", 400, "Quota exceeded for static IPs"),
    "capacity_full",
    true,
    true,
    "OperationFailureException",
  ],
  [
    "service quota exceeded",
    sdk("ServiceQuotaExceededException", 400),
    "capacity_full",
    true,
    true,
    "ServiceQuotaExceededException",
  ],
  [
    "SDK timeout",
    Object.assign(new Error("Socket timed out"), { name: "TimeoutError" }),
    "upstream_unavailable",
    true,
    false,
    "TimeoutError",
  ],
  ["connection reset", net("ECONNRESET"), "upstream_unavailable", true, false, "ECONNRESET"],
  ["DNS failure", net("ENOTFOUND"), "upstream_unavailable", true, false, "ENOTFOUND"],
  ["DNS try again", net("EAI_AGAIN"), "upstream_unavailable", true, false, "EAI_AGAIN"],
  [
    "aborted",
    Object.assign(new Error("Request aborted"), { name: "AbortError" }),
    "upstream_unavailable",
    true,
    false,
    "AbortError",
  ],
  ["a plain Error", new Error("boom"), "internal", true, false, "Error"],
  ["a name that is not an identifier", sdk("Bad Name!", 400), "internal", true, false, "Unknown"],
  ["a string", "boom", "internal", true, false, "Unknown"],
  ["undefined", undefined, "internal", true, false, "Unknown"],
])("%s maps to %s", (_label, input, code, retryable, poolFull, awsErrorName) => {
  const e = toAwsError(input, "CreateInstances");
  expect(e).toBeInstanceOf(AwsError);
  expect({
    code: e.code,
    retryable: e.retryable,
    poolFull: e.poolFull,
    awsErrorName: e.awsErrorName,
  }).toEqual({ code, retryable, poolFull, awsErrorName });
});

it("keeps the request id and status, and writes a fixed message without AWS text", () => {
  const e = toAwsError(sdk("AccessDenied", 403, RAW), "AssumeRole");
  expect(e.message).toBe("AWS AssumeRole failed: forbidden (AccessDenied)");
  expect({ httpStatus: e.httpStatus, requestId: e.requestId, operation: e.operation }).toEqual({
    httpStatus: 403,
    requestId: "req-1",
    operation: "AssumeRole",
  });
  for (const text of [
    e.message,
    String(e.stack),
    JSON.stringify(e),
    inspect(e, { depth: 5 }),
    JSON.stringify(toLogFields(e)),
  ]) {
    expect(text).not.toMatch(LEAK);
  }
  expect("cause" in e).toBe(false);
});

it("the log fields are exactly these eight", () => {
  expect(
    Object.keys(toLogFields(toAwsError(sdk("ThrottlingException", 400), "GetRegions"))).sort(),
  ).toEqual([
    "awsErrorName",
    "errorCode",
    "httpStatus",
    "operation",
    "poolFull",
    "reason",
    "requestId",
    "retryable",
  ]);
});

it("returns an AwsError unchanged", () => {
  const local = new AwsError({ code: "forbidden", retryable: true, reason: "role_not_allowed" });
  expect(toAwsError(local, "GetRegions")).toBe(local);
  expect(local.message).toBe("AWS call failed: forbidden (role_not_allowed)");
});

it("never throws, whatever it is given", () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error(RAW);
      },
    },
  );
  const e = toAwsError(hostile, "GetRegions");
  expect(e).toMatchObject({
    code: "internal",
    retryable: true,
    poolFull: false,
    awsErrorName: "Unknown",
  });
  expect(JSON.stringify(e) + String(e.stack)).not.toMatch(LEAK);
});

it("a real Lightsail client throws AwsError after the SDK has finished, named by the command", async () => {
  const aws = fakeAws();
  aws.on("lightsail", "CreateInstances", lightsailError(500, "ServiceException", "internal"));
  // standard mode (the default), base delay 50 ms: the SDK sends 3 times before the mapping runs
  const client = new LightsailClient({
    region: "ap-south-1",
    requestHandler: aws.handler,
    maxAttempts: 3,
  });
  mapErrors(client);
  const error = await client
    .send(
      new CreateInstancesCommand({
        instanceNames: ["tc-instance-9766a84e943a8987"],
        availabilityZone: "ap-south-1a",
        blueprintId: "b",
        bundleId: "x",
      }),
    )
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({
    code: "upstream_unavailable",
    retryable: true,
    operation: "CreateInstances",
    httpStatus: 500,
    requestId: "fake-request-3",
  });
  expect(aws.seen).toHaveLength(3);
});

it("a real STS client throws AwsError without the ARNs of the raw message", async () => {
  const aws = fakeAws();
  aws.on("sts", "AssumeRole", stsError(403, "AccessDenied", RAW));
  const sts = new STSClient({
    region: "ap-southeast-1",
    requestHandler: aws.handler,
    maxAttempts: 1,
  });
  mapErrors(sts);
  const error = await sts
    .send(
      new AssumeRoleCommand({
        RoleArn: "arn:aws:iam::210987654321:role/TcProvisioner",
        RoleSessionName: "tc-test",
        ExternalId: "tc-ext-7f3a9c",
      }),
    )
    .catch((e: unknown) => e);
  expect(error).toMatchObject({
    name: "AwsError",
    code: "forbidden",
    awsErrorName: "AccessDenied",
    operation: "AssumeRole",
  });
  expect(JSON.stringify(error) + String((error as Error).stack)).not.toMatch(LEAK);
});
