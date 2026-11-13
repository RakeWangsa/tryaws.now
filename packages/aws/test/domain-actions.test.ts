import { decideFailure, registryHoldsRenewal, type FailureFacts } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createDomainAdapter, type DomainAdapterConfig } from "../adapters/domain";
import { AwsError, toAwsError } from "../errors";
import type { DomainsPort } from "../adapters/domains-port";
import type { OpCtx } from "../adapters/types";
import { createFakeDomains } from "./fake-domains";
import { createFakeRoute53 } from "./fake-route53";

// WPU-B2: the three domain actions (renew_domain, resend_verification, set_name_servers). The payload is
// written by the web tier or the lifecycle, so the adapter validates it again; the live domain is the truth.

const NOW = new Date("2030-01-01T00:00:00.000Z");
const CONTACT = {
  contactType: "PERSON",
  firstName: "Rahim",
  lastName: "Uddin",
  email: "rahim@example.com",
  phoneNumber: "+880.1712345678",
  addressLine1: "House 1, Road 2",
  city: "Dhaka",
  state: "Dhaka",
  countryCode: "BD",
  zipCode: "1212",
};
const SEALED = Buffer.from(JSON.stringify(CONTACT)).toString("base64");
const RAW = { name: "example.com", tld: "com", years: 1, contactSealed: SEALED };

type Kind = "renew_domain" | "resend_verification" | "set_name_servers";

/** `renewDomain`: replaces the fake's RenewDomain (an AWS error that the real client can throw). */
async function registered(renewDomain?: DomainsPort["renewDomain"]) {
  const r53 = createFakeRoute53();
  const fake = createFakeDomains({ route53: r53.port, now: () => NOW });
  const adapter = createDomainAdapter({
    domains: () => (renewDomain === undefined ? fake.port : { ...fake.port, renewDomain }),
    route53: () => r53.port,
    unsealContact: async (sealed) => JSON.parse(Buffer.from(sealed).toString("utf8")) as unknown,
    holdsName: async () => true,
    zoneHeldByOther: async () => false,
  });
  const reg = await fake.port.registerDomain({
    name: "example.com",
    years: 1,
    contact: CONTACT as never,
  });
  await fake.finish(reg.operationId, "successful");
  return { adapter, fake };
}

interface Extra {
  step?: string | null;
  resourceConfig?: unknown;
  now?: Date;
  createdAt?: Date;
}

function ctx(
  adapter: Awaited<ReturnType<typeof registered>>["adapter"],
  kind: Kind | "reboot" | "stop" | "change_dns_record" | "set_ports",
  payload: unknown,
  extra: Extra = {},
): OpCtx<DomainAdapterConfig> {
  const now = extra.now ?? NOW;
  return {
    operation: {
      id: "0190a000-0000-7000-8000-000000000001",
      kind,
      step: extra.step ?? null,
      attempt: 1,
      createdAt: extra.createdAt ?? NOW,
      payload,
    },
    stepKey: "k",
    resource: {
      id: "0190a000-0000-7000-8000-0000000000aa",
      customerId: "0190a000-0000-7000-8000-0000000000bb",
      family: "domain",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "active",
      config: extra.resourceConfig ?? {},
    },
    config: adapter.parseConfig(RAW),
    account: { awsAccountId: "tc-dns", externalId: "tc-dns" },
    region: "us-east-1",
    access: {} as never,
    env: {} as never,
    clock: { now: () => now },
    owned: async () => null,
  } as OpCtx<DomainAdapterConfig>;
}

type Registered = Awaited<ReturnType<typeof registered>>;
const run = (a: Registered["adapter"], kind: Kind, payload: unknown, extra?: Extra) =>
  a.aws.action(kind, ctx(a, kind, payload, extra));

function configOf(result: unknown): Record<string, unknown> {
  return (result as { patch: { configMerge: Record<string, unknown> } }).patch.configMerge;
}

describe("resend_verification", () => {
  it("resends while the check is open and records the time, and says so when it is already done", async () => {
    const { adapter, fake } = await registered();
    const first = await run(adapter, "resend_verification", {});
    expect(first).toMatchObject({ kind: "done" });
    expect(configOf(first)).toEqual({ verificationEmailResentAt: NOW.toISOString() });
    fake.verifyContact("example.com");
    const again = await run(adapter, "resend_verification", {});
    expect(configOf(again)).toEqual({ reachability: "done", domainStatus: "registered" });
    expect(fake.calls.filter((c) => c.op === "resendContactReachabilityEmail")).toHaveLength(1);
  });

  it("fails for a domain that is not in the account", async () => {
    const { adapter, fake } = await registered();
    fake.domains.clear();
    await expect(run(adapter, "resend_verification", {})).rejects.toMatchObject({
      code: "validation",
    });
  });
});

describe("set_name_servers", () => {
  const SERVERS = ["NS1.Example.net", "ns2.example.net"];

  it("validates the payload before any call: 2 to 8 distinct host names, no IP, no junk", async () => {
    const { adapter, fake } = await registered();
    const before = fake.calls.length;
    for (const bad of [
      null,
      {},
      { nameServers: [] },
      { nameServers: ["ns1.example.net"] },
      { nameServers: ["ns1.example.net", "NS1.example.net"] },
      { nameServers: ["ns1.example.net", "10.0.0.1"] },
      { nameServers: ["ns1.example.net", "bad host.example.net"] },
      { nameServers: ["ns1.example.net", `${"x".repeat(300)}.net`] },
      { nameServers: Array.from({ length: 9 }, (_, i) => `ns${i}.example.net`) },
      { nameServers: ["ns1.example.net", 5] },
      { nameServers: "ns1.example.net,ns2.example.net" },
    ]) {
      await expect(run(adapter, "set_name_servers", bad)).rejects.toMatchObject({
        code: "validation",
      });
    }
    expect(fake.calls).toHaveLength(before);
  });

  it("updates the name servers (lower case), waits, and saves what the registry reports", async () => {
    const { adapter, fake } = await registered();
    const payload = { nameServers: SERVERS };
    const started = await run(adapter, "set_name_servers", payload);
    expect(started).toMatchObject({ kind: "wait", step: "poll" });
    const opId = configOf(started)["nameServerOperationId"] as string;
    const poll: Extra = { step: "poll", resourceConfig: { nameServerOperationId: opId } };
    expect(await run(adapter, "set_name_servers", payload, poll)).toMatchObject({
      kind: "wait",
      step: "poll",
    });
    await fake.finish(opId, "successful");
    const done = await run(adapter, "set_name_servers", payload, poll);
    expect(done).toMatchObject({ kind: "done" });
    expect(configOf(done)).toEqual({ nameServers: ["ns1.example.net", "ns2.example.net"] });
  });

  it("is done at once when the registry already has these servers (a repeat is not a second call)", async () => {
    const { adapter, fake } = await registered();
    fake.domains.get("example.com")!.nameServers = ["a.example.net", "b.example.net"];
    const result = await run(adapter, "set_name_servers", {
      nameServers: ["B.example.net", "a.example.net"],
    });
    expect(result).toMatchObject({ kind: "done" });
    expect(fake.calls.filter((c) => c.op === "updateNameServers")).toHaveLength(0);
  });

  it("fails when the registry says failed, and when the wait is too long", async () => {
    const { adapter, fake } = await registered();
    const payload = { nameServers: SERVERS };
    const started = await run(adapter, "set_name_servers", payload);
    const opId = configOf(started)["nameServerOperationId"] as string;
    const poll = (more: Extra = {}) =>
      run(adapter, "set_name_servers", payload, {
        step: "poll",
        resourceConfig: { nameServerOperationId: opId },
        ...more,
      });
    await expect(poll({ now: new Date("2030-01-10T00:00:00.000Z") })).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    await fake.finish(opId, "failed");
    await expect(poll()).rejects.toMatchObject({ code: "conflict" });
  });

  it("a poll without a saved operation id fails (R16)", async () => {
    const { adapter } = await registered();
    await expect(
      run(adapter, "set_name_servers", { nameServers: SERVERS }, { step: "poll" }),
    ).rejects.toMatchObject({ code: "internal" });
  });
});

describe("renew_domain", () => {
  const renewCalls = (fake: Registered["fake"]) =>
    fake.calls.filter((c) => c.op === "renewDomain").length;

  it("checks, moves to submit in a write of its own, renews there with the expiry year, waits, and saves the new expiry", async () => {
    const { adapter, fake } = await registered();
    const payload = { currentExpiryYear: 2031, years: 1 };
    // Step null only reads: nothing is sent to the registry before `submit` is recorded (review round 2).
    expect(await run(adapter, "renew_domain", payload)).toEqual({ kind: "next", step: "submit" });
    expect(renewCalls(fake)).toBe(0);
    const started = await run(adapter, "renew_domain", payload, { step: "submit" });
    expect(started).toMatchObject({ kind: "wait", step: "poll" });
    expect(renewCalls(fake)).toBe(1);
    const opId = configOf(started)["renewOperationId"] as string;
    await fake.finish(opId, "successful");
    const done = await run(adapter, "renew_domain", payload, {
      step: "poll",
      resourceConfig: { renewOperationId: opId },
    });
    expect(done).toMatchObject({ kind: "done" });
    expect(configOf(done)).toEqual({ expiresAt: "2032-01-01T00:00:00.000Z" });
  });

  it("a repeat of the start after the renewal went through renews nothing a second time, at submit and at step null", async () => {
    const { adapter, fake } = await registered();
    const payload = { currentExpiryYear: 2031, years: 1 };
    const started = await run(adapter, "renew_domain", payload, { step: "submit" });
    await fake.finish(configOf(started)["renewOperationId"] as string, "successful");
    // The first answer was lost: the step runs again with the same payload, and so does step null.
    for (const step of ["submit", null]) {
      const again = await run(adapter, "renew_domain", payload, { step });
      expect(again).toMatchObject({ kind: "done" });
      expect(configOf(again)).toEqual({ expiresAt: "2032-01-01T00:00:00.000Z" });
    }
    expect(renewCalls(fake)).toBe(1);
  });

  it("validates the payload, and refuses a year the domain does not have, at step null and at submit", async () => {
    const { adapter, fake } = await registered();
    for (const step of [null, "submit"]) {
      for (const bad of [
        null,
        {},
        { currentExpiryYear: "2031" },
        { currentExpiryYear: 2031.5 },
        { currentExpiryYear: 1999 },
        { currentExpiryYear: 2031, years: 0 },
        { currentExpiryYear: 2031, years: 11 },
        // The payload names a later year than the live expiry: the row and AWS disagree (R16).
        { currentExpiryYear: 2040 },
      ]) {
        await expect(run(adapter, "renew_domain", bad, { step })).rejects.toMatchObject({
          code: "validation",
        });
      }
    }
    expect(renewCalls(fake)).toBe(0);
  });

  it("a step it does not know is refused", async () => {
    const { adapter, fake } = await registered();
    await expect(
      run(adapter, "renew_domain", { currentExpiryYear: 2031 }, { step: "start" }),
    ).rejects.toMatchObject({ code: "internal" });
    expect(renewCalls(fake)).toBe(0);
  });

  it("fails when the registry says failed, and when the wait is too long", async () => {
    const { adapter, fake } = await registered();
    const payload = { currentExpiryYear: 2031 };
    const started = await run(adapter, "renew_domain", payload, { step: "submit" });
    const opId = configOf(started)["renewOperationId"] as string;
    const poll = (more: Extra = {}) =>
      run(adapter, "renew_domain", payload, {
        step: "poll",
        resourceConfig: { renewOperationId: opId },
        ...more,
      });
    await expect(poll({ now: new Date("2030-01-10T00:00:00.000Z") })).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    await fake.finish(opId, "failed");
    await expect(poll()).rejects.toMatchObject({ code: "conflict" });
  });

  // WPU-Z13: the contract between this adapter and the failure policy of @tc/core. The error the adapter throws is
  // turned into facts as functions/provisioner/step.ts does (factsOf) and decided by the real decideFailure.
  const decide = async (
    attempt: Promise<unknown>,
    step: string | null,
    previous: { attempts: number; lastError: string | null } = { attempts: 0, lastError: null },
  ) => {
    const error: unknown = await attempt.then(
      () => null,
      (e: unknown) => e,
    );
    if (!(error instanceof AwsError)) throw new Error("expected an AwsError");
    const facts: FailureFacts = {
      code: error.code,
      retryable: error.retryable,
      poolFull: error.poolFull,
      awsErrorName: error.awsErrorName,
      mayHaveActed: error.mayHaveActed,
    };
    return decideFailure({ kind: "renew_domain", step, ...previous, now: NOW, facts }).to;
  };

  // Review round 1: after RenewDomain was accepted the registry holds the renewal (TiCON pays for it, it may still
  // complete): a poll that gives up or cannot poll moves no money (needs_attention), and only the registry's own
  // FAILED answer fails the operation, refunded.
  it("from the step after RenewDomain only the registry's failed answer is a refusal that gives the charge back", async () => {
    const { adapter, fake } = await registered();
    const payload = { currentExpiryYear: 2031 };
    const started = await run(adapter, "renew_domain", payload, { step: "submit" });
    const step = started.kind === "wait" ? started.step : null;
    expect(registryHoldsRenewal("renew_domain", step)).toBe(true);
    const opId = configOf(started)["renewOperationId"] as string;
    const poll = (more: Extra = {}) =>
      run(adapter, "renew_domain", payload, {
        step,
        resourceConfig: { renewOperationId: opId },
        ...more,
      });
    // Still in progress three days after the operation was created: the registry may still renew the name.
    expect(await decide(poll({ now: new Date("2030-01-10T00:00:00.000Z") }), step)).toBe(
      "needs_attention",
    );
    // A poll without the registry's operation id.
    expect(await decide(run(adapter, "renew_domain", payload, { step }), step)).toBe(
      "needs_attention",
    );
    await fake.finish(opId, "failed");
    expect(await decide(poll(), step)).toBe("failed");
  });

  // Review round 2: RenewDomain is sent only at `submit`, which step null records first. A call that may have
  // reached the registry (a time-out, a reset connection, a 5xx after the request was sent) leaves the renewal at
  // `submit`, so `submit` is held: only an error that proves nothing was sent, in the first run there, refunds.
  it("at submit a RenewDomain that may have reached the registry gives nothing back; one refused for sure does", async () => {
    const payload = { currentExpiryYear: 2031 };
    const throwingRenew = async (error: unknown) => {
      const { adapter, fake } = await registered(async (input) => {
        fake.calls.push({ op: "renewDomain", name: input.name });
        throw error;
      });
      expect(await run(adapter, "renew_domain", payload)).toEqual({ kind: "next", step: "submit" });
      expect(registryHoldsRenewal("renew_domain", "submit")).toBe(true);
      return {
        adapter,
        fake,
        attempt: () => run(adapter, "renew_domain", payload, { step: "submit" }),
      };
    };
    // The SDK's errors go through the real mapping of the client (toAwsError): a time-out after the request was
    // sent and a 503 may have acted, final or not.
    const timeout = toAwsError(
      Object.assign(new Error("x"), { name: "TimeoutError", code: "ETIMEDOUT" }),
      "RenewDomain",
    );
    const unavailable = toAwsError(
      Object.assign(new Error("x"), {
        name: "ServiceUnavailable",
        $metadata: { httpStatusCode: 503 },
      }),
      "RenewDomain",
    );
    expect(timeout.mayHaveActed && unavailable.mayHaveActed).toBe(true);
    const finalActed = new AwsError({
      code: "internal",
      retryable: false,
      operation: "RenewDomain",
      mayHaveActed: true,
    });
    {
      const { attempt, fake } = await throwingRenew(finalActed);
      expect(await decide(attempt(), "submit")).toBe("needs_attention");
      expect(renewCalls(fake)).toBe(1);
    }
    for (const error of [timeout, unavailable]) {
      const { attempt } = await throwingRenew(error);
      // Retryable: waits at `submit`, which keeps the count; the next run's refusal proves nothing.
      expect(await decide(attempt(), "submit")).toBe("waiting");
    }
    // A refusal of RenewDomain itself (the client maps it with mayHaveActed false).
    const refused = new AwsError({
      code: "conflict",
      retryable: false,
      awsErrorName: "TLDRulesViolation",
      operation: "RenewDomain",
      mayHaveActed: false,
    });
    {
      const { attempt } = await throwingRenew(refused);
      expect(await decide(attempt(), "submit")).toBe("failed");
      // The same refusal after an earlier run at `submit` whose RenewDomain timed out: held.
      expect(
        await decide(attempt(), "submit", {
          attempts: 1,
          lastError: "upstream_unavailable:ETIMEDOUT",
        }),
      ).toBe("needs_attention");
    }
    // A request that never left the machine (ECONNREFUSED) proves nothing was sent: final or not, its own
    // decision, and a check of the adapter at step null (before anything is sent) refunds as before.
    const refusedConnection = toAwsError(
      Object.assign(new Error("x"), { name: "Error", code: "ECONNREFUSED" }),
      "RenewDomain",
    );
    expect(refusedConnection.mayHaveActed).toBe(false);
    const { adapter } = await registered();
    expect(await decide(run(adapter, "renew_domain", { currentExpiryYear: 2040 }), null)).toBe(
      "failed",
    );
  });
});

it("every other kind is still refused", async () => {
  const { adapter } = await registered();
  for (const kind of ["reboot", "stop", "change_dns_record", "set_ports"] as const) {
    await expect(adapter.aws.action(kind, ctx(adapter, kind, {}))).rejects.toMatchObject({
      code: "validation",
    });
  }
});
