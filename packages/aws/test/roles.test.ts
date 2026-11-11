import { expect, it, vi } from "vitest";
import { AwsError } from "../errors";
import {
  CALLER_ROLES,
  LIGHTSAIL_REGIONS,
  LIGHTSAIL_ROLES,
  ROLE_NAMES,
  assertAccountRef,
  assertRoleAllowed,
  checkedAccountRef,
  roleArn,
  sessionName,
} from "../roles";
import {
  MUTATING_ROLES,
  REFRESH_MARGIN_MS,
  ROLE_KINDS,
  SESSION_SECONDS,
  STS_REGION,
  TIME_LIMITS,
  clientSettings,
  throttlingOnlyRetryStrategy,
} from "../settings";

const LIMITS = {
  connectionTimeout: 3000,
  requestTimeout: 15000,
  throwOnRequestTimeout: true,
  socketTimeout: 15000,
};

it("each caller may ask only for the roles that trust it (3.2, 6.3)", () => {
  expect(CALLER_ROLES).toEqual({
    provisioner: ["TcProvisioner", "TcDnsProvisioner"],
    reader: ["TcReader", "TcDnsReader"],
    "access-details": ["TcAccessDetails"],
    "catalog-sync": ["TcReader", "TcDnsReader"],
    reconciler: ["TcReader", "TcDnsReader", "TcBillingReader"],
  });
  expect(() => assertRoleAllowed("reader", "TcProvisioner")).toThrow(AwsError);
  expect(() => assertRoleAllowed("catalog-sync", "TcAccessDetails")).toThrow(/role_not_allowed/);
  expect(() => assertRoleAllowed("access-details", "TcReader")).toThrow(/role_not_allowed/);
  expect(() => assertRoleAllowed("provisioner", "TcProvisioner")).not.toThrow();
});

it("builds the role ARN from the account id and the fixed role name", () => {
  expect(roleArn("210987654321", "TcProvisioner")).toBe(
    "arn:aws:iam::210987654321:role/TcProvisioner",
  );
  expect(roleArn("123456789012", "TcReader")).toBe("arn:aws:iam::123456789012:role/TcReader");
});

it.each([
  [{ awsAccountId: "21098765432", externalId: "tc-ext-7f3a9c" }],
  [{ awsAccountId: "2109876543210", externalId: "tc-ext-7f3a9c" }],
  [{ awsAccountId: "21098765432a", externalId: "tc-ext-7f3a9c" }],
  [{ awsAccountId: "210987654321", externalId: "" }],
  [{ awsAccountId: "210987654321", externalId: "x" }],
  [{ awsAccountId: "210987654321", externalId: "has space" }],
  [{ awsAccountId: "210987654321", externalId: "x".repeat(1225) }],
])("refuses the account reference %j before any AWS call", (ref) => {
  expect(() => assertAccountRef(ref)).toThrow(/account_ref_invalid/);
});

it("accepts a 12-digit account and an ExternalId of the STS alphabet", () => {
  expect(() =>
    assertAccountRef({ awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" }),
  ).not.toThrow();
  expect(() =>
    assertAccountRef({ awsAccountId: "210987654321", externalId: "a+=,.@:/-_b" }),
  ).not.toThrow();
});

it.each(Object.keys(CALLER_ROLES))(
  "the session name of %s is generated and valid for STS",
  (caller) => {
    const name = sessionName(caller as keyof typeof CALLER_ROLES, "0123456789abcdef");
    expect(name).toBe(`tc-${caller}-0123456789abcdef`);
    expect(name).toMatch(/^[\w+=,.@-]{2,64}$/);
  },
);

it("the Regions are the three of the SCP, and the session values are the decided ones", () => {
  expect([...LIGHTSAIL_REGIONS]).toEqual(["ap-southeast-1", "ap-south-1", "us-east-1"]);
  expect({ STS_REGION, SESSION_SECONDS, REFRESH_MARGIN_MS }).toEqual({
    STS_REGION: "ap-southeast-1",
    SESSION_SECONDS: 3600,
    REFRESH_MARGIN_MS: 300_000,
  });
  expect([...MUTATING_ROLES]).toEqual(["TcProvisioner", "TcDnsProvisioner", "TcAccessDetails"]);
});

it.each(["TcReader", "TcDnsReader", "TcBillingReader", "sts"] as const)(
  "%s uses the SDK's standard retries (3 attempts) and both time limits",
  (target) => {
    expect(clientSettings(target)).toEqual({
      maxAttempts: 3,
      retryMode: "standard",
      requestHandler: LIMITS,
    });
  },
);

it.each(MUTATING_ROLES)("%s retries only throttling and has both time limits", (target) => {
  const s = clientSettings(target);
  expect(s).toMatchObject({ maxAttempts: 3, requestHandler: LIMITS });
  expect("retryMode" in s).toBe(false);
  expect("retryStrategy" in s && typeof s.retryStrategy.refreshRetryTokenForRetry).toBe("function");
});

it("the throttling-only strategy allows two retries of THROTTLING and none of anything else", async () => {
  const s = throttlingOnlyRetryStrategy();
  const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
  const t0 = await s.acquireInitialRetryToken("");
  const t1 = await s.refreshRetryTokenForRetry(t0, { errorType: "THROTTLING" });
  const t2 = await s.refreshRetryTokenForRetry(t1, { errorType: "THROTTLING" });
  random.mockRestore();
  expect([t0.getRetryCount(), t1.getRetryCount(), t2.getRetryCount()]).toEqual([0, 1, 2]);
  // full jitter of 1000 ms * 2^(n-1): floor(0.999 * 1000) and floor(0.999 * 2000)
  expect([t0.getRetryDelay(), t1.getRetryDelay(), t2.getRetryDelay()]).toEqual([0, 999, 1998]);
  await expect(s.refreshRetryTokenForRetry(t2, { errorType: "THROTTLING" })).rejects.toThrow();
  for (const errorType of ["TRANSIENT", "SERVER_ERROR", "CLIENT_ERROR"] as const) {
    await expect(s.refreshRetryTokenForRetry(t0, { errorType })).rejects.toThrow();
  }
});

it("the checks hold at run time for values the types do not allow", () => {
  for (const bad of [210987654321, ["210987654321"], null, undefined]) {
    expect(() =>
      assertAccountRef({ awsAccountId: bad as never, externalId: "tc-ext-7f3a9c" }),
    ).toThrow(/account_ref_invalid/);
  }
  for (const bad of [
    ["tc-ext-7f3a9c"],
    { toString: () => "tc-ext-7f3a9c" },
    null,
    undefined,
    12345,
  ]) {
    expect(() =>
      assertAccountRef({ awsAccountId: "210987654321", externalId: bad as never }),
    ).toThrow(/account_ref_invalid/);
  }
  expect(() => assertAccountRef(null as never)).toThrow(/account_ref_invalid/);
  for (const caller of ["__proto__", "constructor", "toString", "admin", ""]) {
    expect(() => assertRoleAllowed(caller as never, "TcReader")).toThrow(/role_not_allowed/);
  }
  for (const role of ["__proto__", "TcAdmin", "tcreader", ""]) {
    expect(() => assertRoleAllowed("reader", role as never)).toThrow(/role_not_allowed/);
  }
});

it("a trailing newline does not pass as an account id or an ExternalId", () => {
  expect(() =>
    assertAccountRef({ awsAccountId: "210987654321\n", externalId: "tc-ext-7f3a9c" }),
  ).toThrow(/account_ref_invalid/);
  expect(() =>
    assertAccountRef({ awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c\n" }),
  ).toThrow(/account_ref_invalid/);
});

it("the exported lists cannot be changed at run time, and each client gets its own settings object", () => {
  for (const list of [
    ROLE_NAMES,
    LIGHTSAIL_ROLES,
    LIGHTSAIL_REGIONS,
    MUTATING_ROLES,
    TIME_LIMITS,
    CALLER_ROLES,
  ]) {
    expect(Object.isFrozen(list)).toBe(true);
  }
  for (const roles of Object.values(CALLER_ROLES)) expect(Object.isFrozen(roles)).toBe(true);
  expect(() => (CALLER_ROLES.reader as unknown as string[]).push("TcProvisioner")).toThrow(
    TypeError,
  );
  expect(() => assertRoleAllowed("reader", "TcProvisioner")).toThrow(/role_not_allowed/);
  const a = clientSettings("TcReader");
  const b = clientSettings("TcReader");
  expect(a.requestHandler).not.toBe(b.requestHandler);
  expect(a.requestHandler).not.toBe(TIME_LIMITS);
});

it("every role has a decided kind, and the mutating list is exactly the mutating kinds", () => {
  expect(Object.keys(ROLE_KINDS).sort()).toEqual([...ROLE_NAMES].sort());
  expect(Object.isFrozen(ROLE_KINDS)).toBe(true);
  const mutating = ROLE_NAMES.filter((role) => ROLE_KINDS[role] === "mutating");
  expect([...mutating].sort()).toEqual([...MUTATING_ROLES].sort());
  for (const role of ROLE_NAMES) {
    const s = clientSettings(role);
    expect("retryStrategy" in s).toBe(ROLE_KINDS[role] === "mutating");
    expect("retryMode" in s).toBe(ROLE_KINDS[role] === "read");
  }
});

it("a target that is not a known role gets no settings at all", () => {
  for (const target of [
    "TcAdmin",
    "tcprovisioner",
    "__proto__",
    "constructor",
    "",
    "STS",
    undefined,
    null,
  ]) {
    const thrown = (() => {
      try {
        clientSettings(target as never);
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(AwsError);
    expect(thrown).toMatchObject({
      code: "forbidden",
      retryable: true,
      reason: "role_not_allowed",
    });
  }
});

it("no client setting ever holds a logger", () => {
  // the SDK's own logger middleware would write the raw AWS error before the mapping of Task 3 runs
  for (const target of [...ROLE_NAMES, "sts"] as const)
    expect("logger" in clientSettings(target)).toBe(false);
});

it("the number of attempts of the throttling-only strategy is a small integer", async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2.5, 11, "3"]) {
    expect(() => throttlingOnlyRetryStrategy(bad as never)).toThrow(RangeError);
  }
  const once = throttlingOnlyRetryStrategy(1);
  const t0 = await once.acquireInitialRetryToken("");
  await expect(once.refreshRetryTokenForRetry(t0, { errorType: "THROTTLING" })).rejects.toThrow();
});

it("checkedAccountRef reads each field once and returns a frozen copy of what it checked", () => {
  let reads = 0;
  const shifting = {
    get awsAccountId() {
      reads += 1;
      return reads === 1 ? "210987654321" : "999999999999";
    },
    externalId: "tc-ext-7f3a9c",
    extra: "ignored",
  };
  const checked = checkedAccountRef(shifting);
  expect(checked).toEqual({ awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" });
  expect(reads).toBe(1);
  expect(Object.isFrozen(checked)).toBe(true);
  expect(() =>
    checkedAccountRef({ awsAccountId: "21098765432", externalId: "tc-ext-7f3a9c" }),
  ).toThrow(/account_ref_invalid/);
});

it("an ExternalId at the two length limits is accepted", () => {
  expect(() => assertAccountRef({ awsAccountId: "210987654321", externalId: "ab" })).not.toThrow();
  expect(() =>
    assertAccountRef({ awsAccountId: "210987654321", externalId: "x".repeat(1224) }),
  ).not.toThrow();
});

it("roleArn and sessionName check their own inputs", () => {
  for (const bad of [
    "21098765432",
    "2109876543210",
    "21098765432a",
    "210987654321\n",
    "",
    210987654321,
    null,
  ]) {
    expect(() => roleArn(bad as never, "TcReader")).toThrow(/account_ref_invalid/);
  }
  for (const bad of ["TcAdmin", "tcreader", "__proto__", "", null]) {
    expect(() => roleArn("210987654321", bad as never)).toThrow(/role_not_allowed/);
  }
  for (const bad of [
    "0123456789abcde",
    "0123456789abcdef0",
    "0123456789ABCDEF",
    "My Server 123456",
    "0123456789abcdef\n",
    "",
    null,
  ]) {
    expect(() => sessionName("reader", bad as never)).toThrow(RangeError);
  }
  for (const bad of ["admin", "__proto__", "", null]) {
    expect(() => sessionName(bad as never, "0123456789abcdef")).toThrow(/role_not_allowed/);
  }
});

it("the refusals carry the decided code and stay retryable", () => {
  const caught = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
  };
  expect(
    caught(() => assertAccountRef({ awsAccountId: "x", externalId: "tc-ext-7f3a9c" })),
  ).toMatchObject({
    name: "AwsError",
    code: "internal",
    retryable: true,
    reason: "account_ref_invalid",
  });
  expect(caught(() => assertRoleAllowed("reader", "TcProvisioner"))).toMatchObject({
    name: "AwsError",
    code: "forbidden",
    retryable: true,
    reason: "role_not_allowed",
  });
});
