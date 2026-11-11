import { parseRegistrantContact, type StepResult } from "@tc/core";
import { describe, expect, it } from "vitest";
import {
  createDomainAdapter,
  renewDomainOnce,
  resendVerification,
  type DomainAdapterConfig,
} from "../adapters/domain";
import type { Route53Port } from "../adapters/route53-port";
import type { OpCtx } from "../adapters/types";
import { AwsError } from "../errors";
import { createFakeDomains } from "./fake-domains";
import { createFakeRoute53 } from "./fake-route53";

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

function setup(opts: { finishAfterPolls?: number } = {}) {
  const r53 = createFakeRoute53();
  const fake = createFakeDomains({
    route53: r53.port,
    now: () => NOW,
    ...(opts.finishAfterPolls === undefined ? {} : { finishAfterPolls: opts.finishAfterPolls }),
  });
  // The adapter must never create a zone itself: RegisterDomain makes it (spec 12).
  const guarded: Route53Port = {
    ...r53.port,
    createHostedZone: async () => {
      throw new Error("the domain adapter must not call CreateHostedZone");
    },
  };
  const adapter = createDomainAdapter({
    domains: () => fake.port,
    route53: () => guarded,
    unsealContact: async (sealed) => JSON.parse(Buffer.from(sealed).toString("utf8")) as unknown,
  });
  return { r53, fake, adapter };
}

function ctxFor(
  config: DomainAdapterConfig,
  extra: { step?: string | null; resourceConfig?: unknown; now?: Date; createdAt?: Date } = {},
): OpCtx<DomainAdapterConfig> {
  const now = extra.now ?? NOW;
  return {
    operation: {
      id: "0190a000-0000-7000-8000-000000000001",
      kind: "create",
      step: extra.step ?? null,
      attempt: 1,
      createdAt: extra.createdAt ?? NOW,
      payload: {},
    },
    stepKey: "k",
    resource: {
      id: "0190a000-0000-7000-8000-0000000000aa",
      customerId: "0190a000-0000-7000-8000-0000000000bb",
      family: "domain",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "creating",
      config: extra.resourceConfig ?? {},
    },
    config,
    account: { awsAccountId: "tc-dns", externalId: "tc-dns" },
    region: "us-east-1",
    access: {} as never,
    env: {} as never,
    clock: { now: () => now },
    owned: async () => null,
  } as OpCtx<DomainAdapterConfig>;
}

const RAW = { name: "example.com", tld: "com", years: 1, contactSealed: SEALED };

describe("parseConfig", () => {
  it("accepts the config of a resource and refuses anything else", () => {
    const { adapter } = setup();
    expect(adapter.family).toBe("domain");
    expect(adapter.parseConfig(RAW)).toEqual({
      name: "example.com",
      contactSealed: SEALED,
      years: 1,
    });
    for (const bad of [
      null,
      {},
      { ...RAW, name: "Example.com" },
      { ...RAW, name: "example.net" },
      { ...RAW, name: "a.b.com" },
      { ...RAW, contactSealed: "not base64!" },
      { ...RAW, contactSealed: undefined },
      { ...RAW, years: 0 },
      { ...RAW, tld: undefined },
    ]) {
      expect(() => adapter.parseConfig(bad)).toThrow();
    }
  });
});

async function step(
  adapter: ReturnType<typeof setup>["adapter"],
  config: DomainAdapterConfig,
  name: string | null,
  resourceConfig: unknown = {},
  now: Date = NOW,
): Promise<StepResult> {
  return adapter.aws.create(ctxFor(config, { step: name, resourceConfig, now }));
}

describe("create", () => {
  it("registers once, waits, and adopts the zone that the registration made", async () => {
    const { adapter, fake, r53 } = setup();
    const config = adapter.parseConfig(RAW);

    const started = await step(adapter, config, null);
    expect(started.kind).toBe("wait");
    if (started.kind !== "wait") return;
    expect(started.step).toBe("poll");
    const operationId = started.patch?.configMerge?.["route53OperationId"] as string;
    expect(operationId).toMatch(/^fake-op-/);
    expect(fake.calls.filter((c) => c.op === "registerDomain")).toHaveLength(1);
    // The contact went to the registry unsealed, and only there.
    expect(fake.contactOf(operationId)).toEqual(
      parseRegistrantContact(CONTACT).ok ? CONTACT : null,
    );
    expect(JSON.stringify(started)).not.toContain("Rahim");

    const saved = { route53OperationId: operationId };
    const waiting = await step(adapter, config, "poll", saved);
    expect(waiting).toMatchObject({ kind: "wait", step: "poll" });

    await fake.finish(operationId, "successful");
    expect(await step(adapter, config, "poll", saved)).toMatchObject({
      kind: "next",
      step: "adopt",
    });

    const done = await step(adapter, config, "adopt", saved);
    expect(done.kind).toBe("done");
    if (done.kind !== "done") return;
    expect(done.patch?.state).toBe("active");
    const merge = done.patch?.configMerge ?? {};
    expect(merge["domainStatus"]).toBe("awaiting_verification");
    expect(merge["reachability"]).toBe("pending");
    expect(merge["expiresAt"]).toBe("2031-01-01T00:00:00.000Z");
    const zone = await r53.port.findHostedZoneByName("example.com");
    expect(zone).not.toBeNull();
    expect(merge["hostedZoneId"]).toBe(zone?.id);
    // One zone only: the registration made it and the adapter never made a second one.
    expect(r53.calls.filter((c) => c.op === "createHostedZone")).toHaveLength(1);
  });

  it("calls the domain registered once its contact is verified", async () => {
    const { adapter, fake } = setup({ finishAfterPolls: 1 });
    const config = adapter.parseConfig(RAW);
    const started = await step(adapter, config, null);
    const saved = {
      route53OperationId: (started as { patch: { configMerge: Record<string, string> } }).patch
        .configMerge["route53OperationId"],
    };
    expect(await step(adapter, config, "poll", saved)).toMatchObject({ kind: "next" });
    fake.verifyContact("example.com");
    const done = await step(adapter, config, "adopt", saved);
    expect(done.kind === "done" && done.patch?.configMerge?.["domainStatus"]).toBe("registered");
  });

  it("does not register again when an earlier try saved the operation", async () => {
    const { adapter, fake } = setup();
    const config = adapter.parseConfig(RAW);
    const again = await step(adapter, config, null, { route53OperationId: "fake-op-0001" });
    expect(again).toMatchObject({ kind: "next", step: "poll" });
    expect(fake.calls.filter((c) => c.op === "registerDomain")).toHaveLength(0);
  });

  it("goes on to adopt when a lost answer left the name registered in this account", async () => {
    const { adapter, fake } = setup();
    const config = adapter.parseConfig(RAW);
    const first = await fake.port.registerDomain({
      name: "example.com",
      years: 1,
      contact: CONTACT as never,
    });
    await fake.finish(first.operationId, "successful");
    expect(await step(adapter, config, null)).toMatchObject({ kind: "next", step: "adopt" });
    expect(fake.calls.filter((c) => c.op === "registerDomain")).toHaveLength(1);
  });

  it("fails closed for a taken name, a premium name and an unknown answer", async () => {
    const { adapter, fake } = setup();
    const config = adapter.parseConfig(RAW);
    fake.unavailable.add("example.com");
    await expect(step(adapter, config, null)).rejects.toMatchObject({
      code: "conflict",
      retryable: false,
    });
    fake.unavailable.clear();
    fake.premium.add("example.com");
    await expect(step(adapter, config, null)).rejects.toMatchObject({
      code: "conflict",
      retryable: false,
    });
    expect(fake.calls.filter((c) => c.op === "registerDomain")).toHaveLength(0);

    const unknown = createDomainAdapter({
      domains: () => ({ ...fake.port, checkAvailability: async () => "unknown" }),
      route53: () => setup().r53.port,
      unsealContact: async () => CONTACT,
    });
    await expect(step(unknown, config, null)).rejects.toMatchObject({
      code: "upstream_unavailable",
      retryable: true,
    });
  });

  it("fails the create when the registration fails, so the hook reverses the money", async () => {
    const { adapter, fake } = setup();
    const config = adapter.parseConfig(RAW);
    const started = await step(adapter, config, null);
    const operationId = (started as { patch: { configMerge: Record<string, string> } }).patch
      .configMerge["route53OperationId"] as string;
    await fake.finish(operationId, "failed");
    await expect(
      step(adapter, config, "poll", { route53OperationId: operationId }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
  });

  it("gives up on a registration that is older than three days", async () => {
    const { adapter } = setup();
    const config = adapter.parseConfig(RAW);
    const late = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000 + 1000);
    await expect(
      adapter.aws.create(
        ctxFor(config, {
          step: "poll",
          resourceConfig: { route53OperationId: "fake-op-0001" },
          now: late,
        }),
      ),
    ).rejects.toBeInstanceOf(AwsError);
  });

  it("refuses an unsealable or invalid contact without leaking it", async () => {
    const { fake } = setup();
    const config = { name: "example.com", contactSealed: SEALED, years: 1 };
    const broken = createDomainAdapter({
      domains: () => fake.port,
      route53: () => createFakeRoute53().port,
      unsealContact: async () => {
        throw new Error("kms: Rahim rahim@example.com");
      },
    });
    const error = await step(broken, config, null).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "internal", retryable: false });
    expect(JSON.stringify(error)).not.toContain("Rahim");
    const invalid = createDomainAdapter({
      domains: () => fake.port,
      route53: () => createFakeRoute53().port,
      unsealContact: async () => ({ ...CONTACT, email: "nope" }),
    });
    await expect(step(invalid, config, null)).rejects.toMatchObject({ code: "validation" });
    expect(fake.calls.filter((c) => c.op === "registerDomain")).toHaveLength(0);
  });

  it("knows no other step", async () => {
    const { adapter } = setup();
    await expect(step(adapter, adapter.parseConfig(RAW), "bogus")).rejects.toBeInstanceOf(AwsError);
  });
});

describe("a domain is never deleted by us (R13)", () => {
  it("refuses destroy and does nothing for suspend, resume and the snapshot steps", async () => {
    const { adapter, fake } = setup();
    const ctx = ctxFor(adapter.parseConfig(RAW));
    await expect(adapter.aws.destroy(ctx)).rejects.toMatchObject({ code: "validation" });
    expect(await adapter.aws.suspend(ctx)).toEqual({ kind: "done" });
    expect(await adapter.aws.resume(ctx)).toEqual({ kind: "done" });
    expect(await adapter.aws.finalSnapshot(ctx)).toEqual({ kind: "done" });
    expect(await adapter.aws.purgeSnapshots(ctx)).toEqual({ kind: "done" });
    await expect(adapter.aws.action("reboot", ctx)).rejects.toBeInstanceOf(AwsError);
    // No call of the fake is a delete of any kind.
    expect(fake.calls).toHaveLength(0);
  });
});

describe("describe", () => {
  it("is missing before the registration and active after it", async () => {
    const { adapter, fake } = setup();
    const ctx = ctxFor(adapter.parseConfig(RAW));
    expect(await adapter.aws.describe(ctx)).toEqual({ state: "missing" });
    const reg = await fake.port.registerDomain({
      name: "example.com",
      years: 1,
      contact: CONTACT as never,
    });
    await fake.finish(reg.operationId, "successful");
    expect(await adapter.aws.describe(ctx)).toEqual({ state: "active" });
  });
});

describe("renewal and verification helpers", () => {
  it("renews with the expiry year of the live domain and refuses a second renewal for the same year", async () => {
    const { fake } = setup();
    const reg = await fake.port.registerDomain({
      name: "example.com",
      years: 1,
      contact: CONTACT as never,
    });
    await fake.finish(reg.operationId, "successful");
    const renewed = await renewDomainOnce(fake.port, { name: "example.com" });
    await fake.finish(renewed.operationId, "successful");
    expect(fake.domains.get("example.com")?.expiresAt.toISOString()).toBe(
      "2032-01-01T00:00:00.000Z",
    );
    await expect(renewDomainOnce(fake.port, { name: "missing.com" })).rejects.toBeInstanceOf(
      AwsError,
    );
  });

  it("resends the e-mail only while the check is open", async () => {
    const { fake } = setup();
    const reg = await fake.port.registerDomain({
      name: "example.com",
      years: 1,
      contact: CONTACT as never,
    });
    await fake.finish(reg.operationId, "successful");
    expect(await resendVerification(fake.port, "example.com")).toBe("sent");
    fake.verifyContact("example.com");
    expect(await resendVerification(fake.port, "example.com")).toBe("not_needed");
    expect(fake.calls.filter((c) => c.op === "resendContactReachabilityEmail")).toHaveLength(1);
    await expect(resendVerification(fake.port, "other.com")).rejects.toBeInstanceOf(AwsError);
  });
});
