import { describe, expect, it, vi } from "vitest";
import {
  createDomainDraftCore,
  setDomainAutoRenewCore,
  type DomainActionDeps,
  type DomainDraftDeps,
  type DomainRepos,
} from "./domain-actions.ts";

const CUSTOMER = "0190aaaa-0000-7000-8000-0000000000c1";
const TLD_ID = "0190aaaa-0000-7000-8000-0000000000d1";
const RESOURCE = "0190aaaa-0000-7000-8000-0000000000e1";
const REQUEST = "0190aaaa-0000-7000-8000-0000000000f1";
const SESSION = { customerId: CUSTOMER, kycStatus: "verified", riskTier: "new", locale: "en" };

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
const FORM = { name: "shop.com", confirmName: "shop.com", ...CONTACT };

function draftDeps(over: Partial<DomainDraftDeps> = {}) {
  const createOrderDraft = vi.fn(async () => ({
    ok: true as const,
    value: { token: "signed.token", quote: {} as never, expiresAt: new Date() },
  }));
  const seal = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const rateLimit = vi.fn(async () => ({ allowed: true }));
  const deps: DomainDraftDeps = {
    authenticate: async () => SESSION as never,
    rateLimit,
    orders: { createOrderDraft, placeOrder: vi.fn() } as never,
    tlds: async () => [{ id: TLD_ID, tld: "com" }],
    seal,
    ...over,
  };
  return { deps, createOrderDraft, seal, rateLimit };
}

describe("createDomainDraftCore", () => {
  it("seals the contact and sends only the sealed envelope in the config", async () => {
    const { deps, createOrderDraft, seal } = draftDeps();
    expect(await createDomainDraftCore(deps, FORM)).toEqual({ ok: true, token: "signed.token" });
    expect(seal).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(createOrderDraft.mock.calls[0]);
    expect(sent).toContain('"family":"domain"');
    expect(sent).toContain(TLD_ID);
    for (const secret of ["Rahim", "Uddin", "1712345678", "House 1", "rahim@"]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("refuses a second confirmation that does not repeat the name, before anything is sealed or counted", async () => {
    for (const confirmName of ["shop.net", "Shop.com", "", undefined]) {
      const { deps, createOrderDraft, seal, rateLimit } = draftDeps();
      const r = await createDomainDraftCore(deps, { ...FORM, confirmName });
      expect(r).toEqual({ ok: false, error: "validation", fields: { confirmName: "mismatch" } });
      expect(seal).not.toHaveBeenCalled();
      expect(rateLimit).not.toHaveBeenCalled();
      expect(createOrderDraft).not.toHaveBeenCalled();
    }
  });

  it("collects the invalid contact fields and repeats no value", async () => {
    const { deps, createOrderDraft } = draftDeps();
    const r = await createDomainDraftCore(deps, {
      ...FORM,
      email: "nope",
      phoneNumber: "017",
      firstName: "",
    });
    expect(r).toEqual({
      ok: false,
      error: "validation",
      fields: { email: "invalid", phoneNumber: "invalid", firstName: "invalid" },
    });
    expect(JSON.stringify(r)).not.toContain("nope");
    expect(createOrderDraft).not.toHaveBeenCalled();
  });

  it("refuses a name outside the sellable TLDs and an anonymous caller", async () => {
    const { deps } = draftDeps();
    expect(
      await createDomainDraftCore(deps, { ...FORM, name: "shop.xyz", confirmName: "shop.xyz" }),
    ).toMatchObject({ ok: false, error: "validation" });
    const anon = draftDeps({ authenticate: async () => null });
    expect(await createDomainDraftCore(anon.deps, FORM)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });

  it("fails closed when the seal or the order functions are not configured (R16)", async () => {
    expect(await createDomainDraftCore(draftDeps({ seal: null }).deps, FORM)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(await createDomainDraftCore(draftDeps({ orders: null }).deps, FORM)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("stops at the rate limit and says only that the name is taken for a conflict", async () => {
    const limited = draftDeps({ rateLimit: async () => ({ allowed: false }) });
    expect(await createDomainDraftCore(limited.deps, FORM)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.seal).not.toHaveBeenCalled();
    const taken = draftDeps();
    taken.createOrderDraft.mockResolvedValueOnce({ ok: false, error: "conflict" } as never);
    expect(await createDomainDraftCore(taken.deps, FORM)).toEqual({
      ok: false,
      error: "unavailable",
      fields: { name: "taken" },
    });
  });
});

function renewDeps(opts: { flag?: boolean; found?: boolean; allowed?: boolean } = {}) {
  const setAutoRenew = vi.fn(async () => ({
    ok: true as const,
    value: {} as never,
    replayed: false,
  }));
  const record = vi.fn(async () => ({ ok: true as const, value: {} as never, replayed: false }));
  const repos = {
    domains: {
      getByName: async (name: string) =>
        opts.found === false ? null : { resourceId: RESOURCE, name },
    },
    subscriptions: { setAutoRenew },
    audit: { record },
    rateLimits: { consume: async () => ({ allowed: opts.allowed !== false }) },
    domainOn: async () => opts.flag !== false,
  } as unknown as DomainRepos;
  const deps: DomainActionDeps = {
    authenticate: async () => SESSION as never,
    now: () => new Date(),
    store: (_c, fn) => fn(repos),
  };
  return { deps, setAutoRenew, record };
}
const REQ = { name: "shop.com", requestId: REQUEST, enabled: "on" };

describe("setDomainAutoRenewCore", () => {
  it("switches the renewal of the customer's own domain and audits it", async () => {
    const { deps, setAutoRenew, record } = renewDeps();
    expect(await setDomainAutoRenewCore(deps, REQ)).toEqual({ ok: true, done: "autoRenewOn" });
    expect(setAutoRenew).toHaveBeenCalledWith(RESOURCE, true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "domain.auto_renew_on", targetId: RESOURCE }),
    );
  });
  it("answers not_found for another customer's domain and flag_off with the flag off, writing nothing", async () => {
    const other = renewDeps({ found: false });
    expect(await setDomainAutoRenewCore(other.deps, REQ)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(other.setAutoRenew).not.toHaveBeenCalled();
    const off = renewDeps({ flag: false });
    expect(await setDomainAutoRenewCore(off.deps, REQ)).toEqual({ ok: false, error: "flag_off" });
    expect(off.setAutoRenew).not.toHaveBeenCalled();
  });
  it("validates before it touches the store and rate limits", async () => {
    const { deps, setAutoRenew } = renewDeps();
    expect(
      await setDomainAutoRenewCore(deps, { ...REQ, enabled: "maybe", requestId: "x" }),
    ).toEqual({
      ok: false,
      error: "validation",
      fields: { requestId: "invalid", enabled: "invalid" },
    });
    expect(setAutoRenew).not.toHaveBeenCalled();
    expect(await setDomainAutoRenewCore(renewDeps({ allowed: false }).deps, REQ)).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });
  it("reads only name, requestId and enabled with zod and refuses other shapes before the store", async () => {
    const { deps, setAutoRenew } = renewDeps();
    expect(
      await setDomainAutoRenewCore(deps, { ...REQ, name: ` SHOP.com `, customerId: "evil" }),
    ).toEqual({ ok: true, done: "autoRenewOn" });
    for (const raw of [null, [], "x", { ...REQ, name: 5 }, { ...REQ, name: "a".repeat(300) }]) {
      expect(await setDomainAutoRenewCore(deps, raw)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(setAutoRenew).toHaveBeenCalledTimes(1);
  });
});
