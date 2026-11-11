import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { CreateInstancesCommand, LightsailClient } from "@aws-sdk/client-lightsail";
import { expect, it } from "vitest";
import { AwsError, mapErrors, operationOf, toAwsError, toLogFields } from "../errors";
import {
  LEAK,
  RAW_ACCESS_DENIED as RAW,
  expectNoLeak,
  fakeAws,
  lightsailError,
  stsError,
} from "./fake-aws";

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
    "invalid input (Lightsail's generic 400: it may be a state conflict, so it is not final)",
    sdk("InvalidInputException", 400, "The blueprint is not valid"),
    "validation",
    true,
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
  expectNoLeak(e);
  expectNoLeak(toLogFields(e));
  expect(e.message).not.toMatch(LEAK);
  expect("cause" in e).toBe(false);
});

it("the log fields are exactly these ten", () => {
  expect(
    Object.keys(toLogFields(toAwsError(sdk("ThrottlingException", 400), "GetRegions"))).sort(),
  ).toEqual([
    "awsErrorName",
    "errorCode",
    "httpStatus",
    "mayHaveActed",
    "nodeCode",
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
    mayHaveActed: true,
  });
  expectNoLeak(e);
  // in the credentials step nothing of the caller's request was sent
  expect(toAwsError(hostile, "AssumeRole")).toMatchObject({ retryable: true, mayHaveActed: false });
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
  expectNoLeak(error);
});

it("keeps a request id and a status only in their plain form", () => {
  const withMeta = (requestId: unknown, httpStatusCode: unknown) =>
    toAwsError(
      Object.assign(new Error("x"), {
        name: "ServiceException",
        $metadata: { requestId, httpStatusCode },
      }),
      "GetRegions",
    );
  expect(withMeta("0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e", 500)).toMatchObject({
    requestId: "0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e",
    httpStatus: 500,
  });
  for (const bad of [RAW, "a b", "x".repeat(129), "", 12345, null, { toString: () => "abc" }]) {
    expect(withMeta(bad, 500).requestId).toBeNull();
  }
  for (const bad of [-1, 0, 99, 600, 1e9, 200.5, "500", null, Number.NaN]) {
    expect(withMeta("abc", bad).httpStatus).toBeNull();
  }
  // a status that is not kept does not classify either: -1 is not "500 to 599"
  expect(withMeta("abc", -1)).toMatchObject({
    code: "upstream_unavailable",
    awsErrorName: "ServiceException",
  });
  expect(
    toAwsError(
      Object.assign(new Error("x"), { name: "Weird", $metadata: { httpStatusCode: "503" } }),
      null,
    ),
  ).toMatchObject({
    code: "internal",
    httpStatus: null,
  });
});

it("a name that holds an account id is not stored", () => {
  const e = toAwsError(
    Object.assign(new Error("x"), { name: "x210987654321", $metadata: { httpStatusCode: 400 } }),
    "GetRegions",
  );
  expect(e.awsErrorName).toBe("Unknown");
  expect(JSON.stringify(e) + e.message).not.toMatch(/210987654321/);
});

it("the operation is the command name without its suffix, or null", () => {
  expect(operationOf("CreateInstancesCommand")).toBe("CreateInstances");
  for (const odd of ["Command", "", "GetRegions", undefined, null, 7, { replace: () => "x" }]) {
    expect(operationOf(odd)).toBeNull();
  }
});

it.each([
  [
    "quota phrase and 'in use' together",
    sdk(
      "InvalidInputException",
      400,
      "You have reached the maximum number of instances; some names are already in use",
    ),
    "capacity_full",
    true,
    true,
  ],
  ["invalid input with HTTP 429", sdk("InvalidInputException", 429), "rate_limited", true, false],
  ["access denied with HTTP 503", sdk("AccessDeniedException", 503), "forbidden", true, false],
  [
    "service fault with a quota phrase",
    sdk("ServiceException", 500, "Quota exceeded"),
    "capacity_full",
    true,
    true,
  ],
  ["not found with HTTP 500", sdk("NotFoundException", 500), "not_found", true, false],
  [
    "a socket error that the SDK renamed",
    Object.assign(new Error("socket"), { name: "TimeoutError", code: "ECONNRESET" }),
    "upstream_unavailable",
    true,
    false,
  ],
])("when two rows match, the earlier one wins: %s", (_label, input, code, retryable, poolFull) => {
  const e = toAwsError(input, "CreateInstances");
  expect({ code: e.code, retryable: e.retryable, poolFull: e.poolFull }).toEqual({
    code,
    retryable,
    poolFull,
  });
});

it.each([
  "ValidationError",
  "ValidationException",
  "MalformedHttpRequestException",
  "RequestEntityTooLargeException",
  "UnknownOperationException",
  "MalformedPolicyDocument",
  "MalformedPolicyDocumentException",
  "PackedPolicyTooLarge",
  "PackedPolicyTooLargeException",
])("%s is the request's own fault: final, never retried", (name) => {
  expect(toAwsError(sdk(name, 400), "CreateInstances")).toMatchObject({
    code: "validation",
    retryable: false,
    poolFull: false,
  });
});

it("only the nine names of row 4 are final", () => {
  const every = [
    "ThrottlingException",
    "NotFoundException",
    "ResourceNotFoundException",
    "NoSuchEntity",
    "OperationFailureException",
    "AccessDeniedException",
    "AccessDenied",
    "NotAuthorized",
    "UnauthorizedOperation",
    "OptInRequired",
    "RegionDisabledException",
    "UnauthenticatedException",
    "ExpiredTokenException",
    "AccountSetupInProgressException",
    "RegionSetupInProgressException",
    "ServiceException",
    "InternalFailure",
    "ServiceUnavailable",
    "TimeoutError",
    "AbortError",
    "SomethingNew",
    "Error",
    "InvalidInputException",
  ];
  for (const name of every)
    expect(toAwsError(sdk(name, 400), "CreateInstances").retryable).toBe(true);
});

it("InvalidInputException keeps the code validation but may be repeated: the real text is not known (W28)", () => {
  for (const message of ["x", "The blueprint is not valid", "Some text no regex knows"]) {
    expect(toAwsError(sdk("InvalidInputException", 400, message), "CreateInstances")).toMatchObject(
      { code: "validation", retryable: true, poolFull: false },
    );
  }
});

it.each([
  ["ServiceQuotaExceededException", "x"],
  ["QuotaExceededException", "x"],
  ["InvalidInputException", "You have reached the maximum number of static IPs"],
  ["OperationFailureException", "limit exceeded"],
  ["ServiceException", "You have exceeded your limit of disks"],
  ["InvalidInputException", "You have reached the limit"],
])("%s with %j marks the pool as full", (name, message) => {
  expect(toAwsError(sdk(name, 400, message), "CreateInstances")).toMatchObject({
    code: "capacity_full",
    retryable: true,
    poolFull: true,
  });
});

it("'already exists' is a conflict, like 'already in use'", () => {
  expect(
    toAwsError(sdk("InvalidInputException", 400, "The key pair already exists"), "CreateKeyPair"),
  ).toMatchObject({
    code: "conflict",
    retryable: true,
    poolFull: false,
  });
});
// W29: one row per case. mayHaveActed is true when AWS may already have acted on the request.
it.each([
  [
    "throttling (AWS does not run a throttled request)",
    sdk("ThrottlingException", 400),
    false,
    null,
  ],
  ["HTTP 429 of an unknown name", sdk("SlowDownPlease", 429), false, null],
  ["a modelled 4xx refusal (NotFound)", sdk("NotFoundException", 400), false, null],
  ["a modelled 4xx refusal (AccessDenied)", sdk("AccessDeniedException", 403), false, null],
  ["a modelled 4xx refusal (invalid input)", sdk("InvalidInputException", 400), false, null],
  ["a quota refusal", sdk("ServiceQuotaExceededException", 400), false, null],
  ["a name already in use", sdk("InvalidInputException", 400, "already in use"), false, null],
  ["account setup in progress", sdk("AccountSetupInProgressException", 400), false, null],
  ["an unauthenticated refusal", sdk("ExpiredTokenException", 403), false, null],
  ["HTTP 500", sdk("ServiceException", 500), true, null],
  ["HTTP 503", sdk("ServiceUnavailable", 503), true, null],
  ["HTTP 502 of an unknown name", sdk("Weird", 502), true, null],
  ["a modelled name with HTTP 503", sdk("AccessDeniedException", 503), true, null],
  ["a 2xx answer whose body could not be read", sdk("SyntaxError", 200), true, null],
  ["the request time-out", Object.assign(new Error("t"), { name: "TimeoutError" }), true, null],
  [
    "the connect time-out (it looks like the request time-out)",
    Object.assign(new Error("t"), { name: "TimeoutError", code: "ETIMEDOUT" }),
    true,
    "ETIMEDOUT",
  ],
  ["abort", Object.assign(new Error("a"), { name: "AbortError" }), true, null],
  ["ECONNRESET", net("ECONNRESET"), true, "ECONNRESET"],
  ["EPIPE", net("EPIPE"), true, "EPIPE"],
  ["ETIMEDOUT", net("ETIMEDOUT"), true, "ETIMEDOUT"],
  ["ECONNREFUSED (nothing was sent)", net("ECONNREFUSED"), false, "ECONNREFUSED"],
  ["ENOTFOUND (nothing was sent)", net("ENOTFOUND"), false, "ENOTFOUND"],
  ["EAI_AGAIN (nothing was sent)", net("EAI_AGAIN"), false, "EAI_AGAIN"],
  ["ENETUNREACH (nothing was sent)", net("ENETUNREACH"), false, "ENETUNREACH"],
  ["EHOSTUNREACH (nothing was sent)", net("EHOSTUNREACH"), false, "EHOSTUNREACH"],
  [
    "the SDK's time-out that hides a Node code",
    Object.assign(new Error("s"), { name: "TimeoutError", code: "ECONNRESET" }),
    true,
    "ECONNRESET",
  ],
  ["an unknown error (when unsure, assume it acted)", new Error("boom"), true, null],
  ["a value that is not an error", "boom", true, null],
])("mayHaveActed and nodeCode: %s", (_label, input, mayHaveActed, nodeCode) => {
  const e = toAwsError(input, "CreateInstances");
  expect({ mayHaveActed: e.mayHaveActed, nodeCode: e.nodeCode }).toEqual({
    mayHaveActed,
    nodeCode,
  });
  expect(toLogFields(e)).toMatchObject({ mayHaveActed, nodeCode });
});

it("an error of the credentials step never says that AWS acted, whatever the HTTP status", () => {
  for (const input of [sdk("ServiceException", 500), net("ECONNRESET"), new Error("x")]) {
    expect(toAwsError(input, "AssumeRole").mayHaveActed).toBe(false);
  }
});

it("every error made by this package itself says that AWS did not act", () => {
  const local = new AwsError({
    code: "forbidden",
    retryable: true,
    reason: "role_not_allowed",
  });
  expect({ a: local.mayHaveActed, n: local.nodeCode }).toEqual({
    a: false,
    n: null,
  });
});

// W32: nothing from the credentials step is final.
it.each([
  ["STS ValidationError", sdk("ValidationError", 400)],
  ["MalformedPolicyDocument", sdk("MalformedPolicyDocument", 400)],
  ["PackedPolicyTooLarge", sdk("PackedPolicyTooLarge", 400)],
  ["InvalidInputException", sdk("InvalidInputException", 400)],
])("%s from AssumeRole stays retryable (a platform fault waits for an admin)", (_label, input) => {
  expect(toAwsError(input, "AssumeRole")).toMatchObject({
    code: "validation",
    retryable: true,
  });
});

it("the same STS names stay final when a Lightsail call returns them", () => {
  expect(toAwsError(sdk("ValidationError", 400), "CreateInstances").retryable).toBe(false);
});

// W37: every listed error name with a status that does not decide.
it.each([
  ["RegionDisabledException", "forbidden"],
  ["NotAuthorized", "forbidden"],
  ["UnauthorizedOperation", "forbidden"],
  ["ResourceNotFoundException", "not_found"],
  ["NoSuchEntity", "not_found"],
  ["ExpiredToken", "unauthenticated"],
  ["RequestExpired", "unauthenticated"],
  ["RequestLimitExceeded", "rate_limited"],
  ["LimitExceededException", "rate_limited"],
  ["TooManyRequestsException", "rate_limited"],
  ["InternalServerError", "upstream_unavailable"],
  ["InternalServerErrorException", "upstream_unavailable"],
  ["ServiceUnavailableException", "upstream_unavailable"],
  ["RequestTimeout", "upstream_unavailable"],
  ["RequestTimeoutException", "upstream_unavailable"],
  ["RequestAbortedException", "upstream_unavailable"],
])("the name %s maps to %s whatever the HTTP status says (400)", (name, code) => {
  expect(toAwsError(sdk(name, 400), "CreateInstances").code).toBe(code);
});

it("a refused connection maps to upstream_unavailable and is named by its code", () => {
  expect(toAwsError(net("ECONNREFUSED"), "CreateInstances")).toMatchObject({
    code: "upstream_unavailable",
    awsErrorName: "ECONNREFUSED",
  });
});

it("toLogFields carries the values of the error", () => {
  const throttled = toAwsError(sdk("ThrottlingException", 400), "CreateInstances");
  expect(toLogFields(throttled)).toEqual({
    errorCode: "rate_limited",
    awsErrorName: "ThrottlingException",
    reason: null,
    operation: "CreateInstances",
    retryable: true,
    poolFull: false,
    httpStatus: 400,
    requestId: "req-1",
    mayHaveActed: false,
    nodeCode: null,
  });
  expect(
    toLogFields(toAwsError(sdk("ServiceQuotaExceededException", 400), "CreateInstances")),
  ).toMatchObject({
    errorCode: "capacity_full",
    retryable: true,
    poolFull: true,
  });
  expect(toLogFields(toAwsError(sdk("ValidationException", 400), "CreateInstances"))).toMatchObject(
    { errorCode: "validation", retryable: false },
  );
});

// W33: the error object itself.
it("an AwsError has exactly these own keys and is frozen", () => {
  const e = toAwsError(sdk("ThrottlingException", 400), "GetRegions");
  expect(Reflect.ownKeys(e).map(String).sort()).toEqual([
    "awsErrorName",
    "code",
    "httpStatus",
    "mayHaveActed",
    "message",
    "name",
    "nodeCode",
    "operation",
    "poolFull",
    "reason",
    "requestId",
    "retryable",
    "stack",
  ]);
  expect(Object.isFrozen(e)).toBe(true);
  expect(() => {
    (e as { code: string }).code = "ok";
  }).toThrow(TypeError);
});

it.each([
  [
    "awsErrorName with an account id",
    { awsErrorName: "Role210987654321" },
    "awsErrorName",
    "Unknown",
  ],
  ["awsErrorName with a space", { awsErrorName: "arn: x" }, "awsErrorName", "Unknown"],
  ["awsErrorName that is too long", { awsErrorName: "A".repeat(65) }, "awsErrorName", "Unknown"],
  ["a requestId with text", { requestId: "User: arn:aws:sts::1" }, "requestId", null],
  ["a requestId that is too long", { requestId: "a".repeat(129) }, "requestId", null],
  ["an operation with a space", { operation: "Create Instances" }, "operation", null],
  ["an operation that holds an ARN", { operation: "arn:aws:iam::210987654321" }, "operation", null],
  ["an operation in lower case", { operation: "createInstances" }, "operation", null],
  ["a nodeCode with text", { nodeCode: "connect to 210987654321" }, "nodeCode", null],
  ["a reason that is not one of ours", { reason: "arn:aws:x" as never }, "reason", null],
  ["an httpStatus out of range", { httpStatus: 42 }, "httpStatus", null],
])("the constructor keeps only the plain form: %s", (_label, init, field, expected) => {
  const e = new AwsError({ code: "internal", retryable: true, ...init });
  expect(e[field as keyof AwsError]).toBe(expected);
  expectNoLeak(e);
});

it("the constructor keeps plain values as they are", () => {
  const e = new AwsError({
    code: "rate_limited",
    retryable: true,
    awsErrorName: "ThrottlingException",
    requestId: "0b1c2d3e-4f5a",
    operation: "CreateInstances",
    httpStatus: 400,
    mayHaveActed: true,
    nodeCode: "ECONNRESET",
  });
  expect(e).toMatchObject({
    awsErrorName: "ThrottlingException",
    requestId: "0b1c2d3e-4f5a",
    operation: "CreateInstances",
    httpStatus: 400,
    mayHaveActed: true,
    nodeCode: "ECONNRESET",
  });
});
