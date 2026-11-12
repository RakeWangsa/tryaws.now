import { describe, expect, it } from "vitest";
import { createDomainAdapter, type DomainAdapterConfig } from "../adapters/domain";
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

async function registered() {
  const r53 = createFakeRoute53();
  const fake = createFakeDomains({ route53: r53.port, now: () => NOW });
  const adapter = createDomainAdapter({
    domains: () => fake.port,
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
  it("renews with the expiry year of the payload, waits, and saves the new expiry", async () => {
    const { adapter, fake } = await registered();
    const payload = { currentExpiryYear: 2031, years: 1 };
    const started = await run(adapter, "renew_domain", payload);
    expect(started).toMatchObject({ kind: "wait", step: "poll" });
    const opId = configOf(started)["renewOperationId"] as string;
    await fake.finish(opId, "successful");
    const done = await run(adapter, "renew_domain", payload, {
      step: "poll",
      resourceConfig: { renewOperationId: opId },
    });
    expect(done).toMatchObject({ kind: "done" });
    expect(configOf(done)).toEqual({ expiresAt: "2032-01-01T00:00:00.000Z" });
  });

  it("a repeat of the start after the renewal went through renews nothing a second time", async () => {
    const { adapter, fake } = await registered();
    const payload = { currentExpiryYear: 2031, years: 1 };
    const started = await run(adapter, "renew_domain", payload);
    await fake.finish(configOf(started)["renewOperationId"] as string, "successful");
    // The first answer was lost: the start runs again with the same payload.
    const again = await run(adapter, "renew_domain", payload);
    expect(again).toMatchObject({ kind: "done" });
    expect(configOf(again)).toEqual({ expiresAt: "2032-01-01T00:00:00.000Z" });
    expect(fake.calls.filter((c) => c.op === "renewDomain")).toHaveLength(1);
  });

  it("validates the payload, and refuses a year the domain does not have", async () => {
    const { adapter, fake } = await registered();
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
      await expect(run(adapter, "renew_domain", bad)).rejects.toMatchObject({
        code: "validation",
      });
    }
    expect(fake.calls.filter((c) => c.op === "renewDomain")).toHaveLength(0);
  });

  it("fails when the registry says failed, and when the wait is too long", async () => {
    const { adapter, fake } = await registered();
    const payload = { currentExpiryYear: 2031 };
    const started = await run(adapter, "renew_domain", payload);
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
});

it("every other kind is still refused", async () => {
  const { adapter } = await registered();
  for (const kind of ["reboot", "stop", "change_dns_record", "set_ports"] as const) {
    await expect(adapter.aws.action(kind, ctx(adapter, kind, {}))).rejects.toMatchObject({
      code: "validation",
    });
  }
});
