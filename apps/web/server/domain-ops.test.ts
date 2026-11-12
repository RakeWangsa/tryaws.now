import { describe, expect, it, vi } from "vitest";
import type { DomainActionDeps, DomainRepos } from "./domain-actions.ts";
import { resendVerificationCore, setNameServersCore } from "./domain-ops.ts";

// WPU-B2: the cores of "resend the verification e-mail" and "change the name servers". R1: each one writes
// an operation row and nothing else; there is no AWS call to prove absent, the module imports no client.
// R9 order, R8 (another customer's domain is one answer with a missing one), R7 (the key), R12, R16.

const CUSTOMER = "0190aaaa-0000-7000-8000-0000000000c1";
const RESOURCE = "0190aaaa-0000-7000-8000-0000000000e1";
const REQUEST = "0190aaaa-0000-7000-8000-0000000000f1";
const SESSION = { customerId: CUSTOMER, kycStatus: "verified", riskTier: "new", locale: "en" };
const OK = { ok: true as const, value: { id: "op" } as never, replayed: false };

function setup(
  opts: {
    flag?: boolean;
    found?: boolean;
    status?: string;
    family?: string;
    state?: string;
    allowed?: boolean;
    inFlight?: boolean;
    audit?: boolean;
    request?: unknown;
    session?: boolean;
  } = {},
) {
  const order: string[] = [];
  const request = vi.fn(async () => {
    order.push("request");
    return (opts.request ?? OK) as never;
  });
  const record = vi.fn(async () => {
    order.push("audit");
    return opts.audit === false ? ({ ok: false, error: "x" } as never) : OK;
  });
  const consume = vi.fn(async () => {
    order.push("rate");
    return { allowed: opts.allowed !== false };
  });
  const repos = {
    domains: {
      getByName: async (name: string) =>
        opts.found === false
          ? null
          : { resourceId: RESOURCE, name, status: opts.status ?? "registered" },
    },
    resources: {
      get: async () => ({
        id: RESOURCE,
        family: opts.family ?? "domain",
        state: opts.state ?? "active",
      }),
    },
    operations: {
      request,
      listForResource: async () =>
        opts.inFlight === true ? [{ id: "o0", kind: "set_name_servers", state: "queued" }] : [],
    },
    audit: { record },
    rateLimits: { consume },
    domainOn: async () => {
      order.push("flag");
      return opts.flag !== false;
    },
  } as unknown as DomainRepos;
  const authenticate = vi.fn(async () => {
    order.push("auth");
    return opts.session === false ? null : (SESSION as never);
  });
  const deps: DomainActionDeps = {
    authenticate,
    now: () => new Date("2030-01-01T00:00:00Z"),
    store: (_c, fn) => fn(repos),
  };
  return { deps, request, record, consume, order, authenticate };
}

const RESEND = { name: "shop.com", requestId: REQUEST };
const NS = {
  name: "shop.com",
  requestId: REQUEST,
  nameServers: "NS1.Example.net\nns2.example.net",
  confirmName: "shop.com",
};

describe("resendVerificationCore", () => {
  it("writes one operation row of the kind resend_verification and audits it, in the order of R9", async () => {
    const { deps, request, record, order } = setup();
    expect(await resendVerificationCore(deps, RESEND)).toEqual({
      ok: true,
      done: "verificationSent",
    });
    expect(request).toHaveBeenCalledWith({
      resourceId: RESOURCE,
      kind: "resend_verification",
      idempotencyKey: `domain.resend:${REQUEST}`,
      payload: {},
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "domain.resend_verification", targetId: RESOURCE }),
    );
    expect(order).toEqual(["auth", "flag", "rate", "request", "audit"]);
  });

  it("refuses without a session before anything is read", async () => {
    const { deps, request, order } = setup({ session: false });
    expect(await resendVerificationCore(deps, RESEND)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(request).not.toHaveBeenCalled();
    expect(order).toEqual(["auth"]);
  });

  it("another customer's domain and a missing one are one answer; nothing is written (R8)", async () => {
    const { deps, request, record } = setup({ found: false });
    expect(await resendVerificationCore(deps, RESEND)).toEqual({ ok: false, error: "not_found" });
    expect(request).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("flag off, a resource that is no active domain, a failed or expired row: refused, no row (R12, R16)", async () => {
    for (const [opts, error] of [
      [{ flag: false }, "flag_off"],
      [{ family: "linux_instance" }, "not_found"],
      [{ state: "creating" }, "not_allowed"],
      [{ status: "failed" }, "not_allowed"],
      [{ status: "pending" }, "not_allowed"],
    ] as const) {
      const { deps, request } = setup(opts);
      expect(await resendVerificationCore(deps, RESEND), JSON.stringify(opts)).toEqual({
        ok: false,
        error,
      });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("validates before the store, and a rate limit stops it before the row", async () => {
    const bad = setup();
    expect(await resendVerificationCore(bad.deps, { name: "not a name", requestId: "x" })).toEqual({
      ok: false,
      error: "validation",
      fields: { name: "invalid", requestId: "invalid" },
    });
    expect(bad.order).toEqual(["auth"]);
    const limited = setup({ allowed: false });
    expect(await resendVerificationCore(limited.deps, RESEND)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.request).not.toHaveBeenCalled();
  });

  it("an audit entry that is refused rolls everything back (R9, R16)", async () => {
    const { deps } = setup({ audit: false });
    expect(await resendVerificationCore(deps, RESEND)).toEqual({ ok: false, error: "unavailable" });
  });

  it("a repository that refuses the kind or the resource is unavailable or not_found", async () => {
    expect(
      await resendVerificationCore(
        setup({ request: { ok: false, error: "not_found" } }).deps,
        RESEND,
      ),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await resendVerificationCore(
        setup({ request: { ok: false, error: "validation" } }).deps,
        RESEND,
      ),
    ).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("setNameServersCore", () => {
  it("writes one operation row with the servers in plain form, keyed by the request and the servers", async () => {
    const { deps, request, record } = setup();
    expect(await setNameServersCore(deps, NS)).toEqual({ ok: true, done: "nameServersRequested" });
    const call = request.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0]).toMatchObject({
      resourceId: RESOURCE,
      kind: "set_name_servers",
      payload: { nameServers: ["ns1.example.net", "ns2.example.net"] },
    });
    expect(String(call[0]["idempotencyKey"])).toMatch(
      new RegExp(`^domain\\.nameservers:${REQUEST}:[0-9a-f]{8}$`),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "domain.set_name_servers", targetId: RESOURCE }),
    );
  });

  it("the same form again is the same key; other servers are another key (R7)", async () => {
    const key = async (text: string) => {
      const { deps, request } = setup();
      await setNameServersCore(deps, { ...NS, nameServers: text });
      return (request.mock.calls[0] as unknown as [{ idempotencyKey: string }])[0].idempotencyKey;
    };
    expect(await key("a.example.net b.example.net")).toBe(
      await key("a.example.net\nb.example.net"),
    );
    expect(await key("a.example.net b.example.net")).not.toBe(
      await key("a.example.net c.example.net"),
    );
  });

  it("needs the typed name (second confirmation) and a valid list, before the store", async () => {
    for (const over of [
      { confirmName: "other.com" },
      { confirmName: "" },
      { confirmName: undefined },
      { nameServers: "ns1.example.net" },
      { nameServers: "ns1.example.net 10.0.0.1" },
      { nameServers: 5 },
      { requestId: "x" },
    ]) {
      const { deps, request, consume, order } = setup();
      const r = await setNameServersCore(deps, { ...NS, ...over });
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false, error: "validation" });
      expect(request).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(order).toEqual(["auth"]);
    }
  });

  it("answers with field codes only, never the text that was typed", async () => {
    const { deps } = setup();
    const r = await setNameServersCore(deps, { ...NS, nameServers: "secret-text" });
    expect(JSON.stringify(r)).not.toContain("secret-text");
  });

  it("another customer's domain, flag off, a busy domain and a domain that is not registered", async () => {
    expect(await setNameServersCore(setup({ found: false }).deps, NS)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await setNameServersCore(setup({ flag: false }).deps, NS)).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(await setNameServersCore(setup({ inFlight: true }).deps, NS)).toEqual({
      ok: false,
      error: "busy",
    });
    for (const status of ["pending", "review", "failed", "expired"]) {
      const { deps, request } = setup({ status });
      expect(await setNameServersCore(deps, NS)).toEqual({ ok: false, error: "not_allowed" });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("a domain that waits for the e-mail check may still change its servers", async () => {
    expect(
      await setNameServersCore(setup({ status: "awaiting_verification" }).deps, NS),
    ).toMatchObject({ ok: true });
  });
});
