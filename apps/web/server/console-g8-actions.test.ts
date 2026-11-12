import type { CustomerSession } from "@tc/auth";
import type { CatalogProduct, ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  CDN_CACHE_BEHAVIORS,
  CDN_ORIGIN,
  CDN_PLAN,
  CDN_REFRESH_CERTIFICATE,
  CDN_REQUEST_CERTIFICATE,
  CONTAINER_ENDPOINT,
  CONTAINER_PLAN,
  CONTAINER_REFRESH_CERTIFICATE,
  CONTAINER_REQUEST_CERTIFICATE,
  consoleCore,
  type ConsoleSpec,
} from "./console-actions.ts";
import type { FamilyActionDeps, FamilyRepos } from "./family-actions.ts";

// WPU-G8: the console actions of the container service and the CDN distribution. The generic proofs
// (R7, R8, R9, R16) run for every spec; the finalize step of each spec has its own cases.

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const ID = "0190aaaa-0000-7000-8000-0000000000e1";
const FOREIGN = "0190aaaa-0000-7000-8000-0000000000ff";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const CURRENT = "0190aaaa-0000-7000-8000-0000000000c1";
const NEXT = "0190aaaa-0000-7000-8000-0000000000c2";
const ORIGIN_A = "0190aaaa-0000-7000-8000-0000000000a1";
const ORIGIN_B = "0190aaaa-0000-7000-8000-0000000000a2";
const OTHERS = "0190aaaa-0000-7000-8000-0000000000b1";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(NOW.getTime() - 60_000),
});

const SAVED = {
  containers: {
    c1: { image: "nginx:1.27", environment: { TOKEN: "s3cr3t" }, ports: { "80": "HTTP" } },
  },
};

const row = (
  family: string,
  config: Record<string, unknown>,
  over: Partial<ResourceSummary> = {},
): ResourceSummary => ({
  id: ID,
  family,
  productId: CURRENT,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config,
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

const product = (over: Partial<CatalogProduct> = {}): CatalogProduct =>
  ({
    id: NEXT,
    family: "container_service",
    awsId: "large",
    platform: null,
    region: "ap-southeast-1",
    specs: { scale: 2 },
    awsPriceUsd: "40.0000",
    billingUnit: "month",
    featureFlag: "container_service",
    active: true,
    synced_at: undefined,
    ...over,
  }) as CatalogProduct;

function world(
  main: ResourceSummary,
  extra: ResourceSummary[] = [],
  opts: { catalog?: Record<string, CatalogProduct>; noCatalog?: boolean } = {},
) {
  const calls: string[] = [];
  const requests: { kind: string; idempotencyKey: string; payload: unknown }[] = [];
  const rows = new Map([main, ...extra].map((r) => [r.id, r]));
  const repos: FamilyRepos = {
    flagOn: async () => true,
    resources: {
      get: async (id: string) => {
        calls.push("get");
        return rows.get(id) ?? null;
      },
    } as never,
    subscriptions: {} as never,
    operations: {
      request: async (input: { kind: string; idempotencyKey: string; payload: unknown }) => {
        calls.push("request");
        requests.push(input);
        return { ok: true, value: {} };
      },
    } as never,
    audit: {
      record: async (input: { action: string }) => {
        calls.push(`audit:${input.action}`);
        return { ok: true };
      },
    } as never,
    rateLimits: { consume: async () => ({ allowed: true }) } as never,
    ...(opts.noCatalog === true
      ? {}
      : {
          catalogProduct: async (id: string) => {
            calls.push("catalog");
            return opts.catalog?.[id] ?? null;
          },
        }),
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => session(),
    now: () => NOW,
    store: async (_c, fn) => fn(repos),
  };
  return { deps, calls, requests };
}

const run = (spec: ConsoleSpec, w: ReturnType<typeof world>, form: Record<string, unknown>) =>
  consoleCore(spec)(w.deps, { requestId: REQ, ...form });

describe("plan change at the next renewal", () => {
  const cases = [
    {
      name: "container service",
      spec: CONTAINER_PLAN,
      idField: "containerId",
      family: "container_service",
      p: product(),
    },
    {
      name: "CDN",
      spec: CDN_PLAN,
      idField: "cdnId",
      family: "cdn",
      p: product({ family: "cdn", awsId: "large_1_0", specs: {} }),
    },
  ];

  describe.each(cases)("$name", ({ spec, idField, family, p }) => {
    const config = { region: "ap-southeast-1", productId: CURRENT, displayName: "svc" };
    const w = () => world(row(family, config), [], { catalog: { [NEXT]: p } });

    it("queues schedule_plan_change with the product id only, under a stable key, then audits (R7, R9)", async () => {
      const x = w();
      expect(await run(spec, x, { [idField]: ID, productId: NEXT })).toEqual({
        ok: true,
        done: "planScheduled",
      });
      expect(x.requests).toEqual([
        {
          resourceId: ID,
          kind: "schedule_plan_change",
          idempotencyKey: `${spec.keyPrefix}:${REQ}`,
          payload: { productId: NEXT },
        },
      ]);
      expect(x.calls).toEqual(["get", "catalog", "request", `audit:${spec.audit}`]);
    });

    it("cancels a pending change with no catalog read", async () => {
      const x = w();
      expect(await run(spec, x, { [idField]: ID, cancel: "yes" })).toMatchObject({ ok: true });
      expect(x.requests[0]?.payload).toEqual({ productId: null });
      expect(x.calls).not.toContain("catalog");
    });

    it("refuses a product that is the current plan, off sale, of another family or Region, or unknown", async () => {
      const bads: CatalogProduct[] = [
        { ...p, id: CURRENT },
        { ...p, active: false },
        { ...p, family: family === "cdn" ? "container_service" : "cdn" },
        { ...p, region: "ap-south-1" },
        { ...p, awsId: "nonsense", specs: {} },
      ];
      for (const bad of bads) {
        const x = world(row(family, config), [], { catalog: { [bad.id]: bad } });
        expect(
          await run(spec, x, { [idField]: ID, productId: bad.id }),
          JSON.stringify(bad),
        ).toEqual({ ok: false, error: "validation", fields: { productId: "invalid" } });
        expect(x.requests).toEqual([]);
      }
      const unknown = w();
      expect(await run(spec, unknown, { [idField]: ID, productId: OTHERS })).toMatchObject({
        ok: false,
        error: "validation",
      });
    });

    it("refuses a missing or malformed product id before the store, and a world without a catalog (R16)", async () => {
      const x = w();
      for (const form of [{}, { productId: "nope" }, { productId: "" }]) {
        expect(await run(spec, x, { [idField]: ID, ...form })).toMatchObject({
          ok: false,
          error: "validation",
        });
      }
      expect(x.calls).toEqual([]);
      const none = world(row(family, config), [], { noCatalog: true });
      expect(await run(spec, none, { [idField]: ID, productId: NEXT })).toEqual({
        ok: false,
        error: "unavailable",
      });
    });

    it("another customer's row and a missing one give one answer (R8); a destroyed one is not allowed", async () => {
      const a = await run(spec, w(), { [idField]: FOREIGN, productId: NEXT });
      const b = await run(spec, w(), { [idField]: OTHERS, productId: NEXT });
      expect(a).toEqual({ ok: false, error: "not_found" });
      expect(b).toEqual(a);
      expect(
        await run(spec, world(row(family, config, { state: "destroyed" })), {
          [idField]: ID,
          productId: NEXT,
        }),
      ).toEqual({ ok: false, error: "not_allowed" });
    });
  });
});

describe("certificates of a container service and a CDN", () => {
  const specs = [
    {
      request: CONTAINER_REQUEST_CERTIFICATE,
      refresh: CONTAINER_REFRESH_CERTIFICATE,
      id: "containerId",
      family: "container_service",
    },
    {
      request: CDN_REQUEST_CERTIFICATE,
      refresh: CDN_REFRESH_CERTIFICATE,
      id: "cdnId",
      family: "cdn",
    },
  ];
  describe.each(specs)("$family", ({ request, refresh, id, family }) => {
    it("queues a certificate request for a checked domain, once per resource", async () => {
      const x = world(row(family, {}));
      expect(await run(request, x, { [id]: ID, domain: " Shop.Example.com " })).toEqual({
        ok: true,
        done: "certificateQueued",
      });
      expect(x.requests[0]).toMatchObject({
        kind: "request_certificate",
        payload: { domain: "shop.example.com" },
      });
      const again = world(
        row(family, { certificate: { domain: "shop.example.com", status: "ISSUED" } }),
      );
      expect(await run(request, again, { [id]: ID, domain: "other.example.com" })).toEqual({
        ok: false,
        error: "not_allowed",
      });
      expect(again.requests).toEqual([]);
    });

    it("refuses a bad domain before the store", async () => {
      const x = world(row(family, {}));
      for (const domain of ["localhost", "*.example.com", "a b.com", "", undefined]) {
        expect(await run(request, x, { [id]: ID, domain })).toMatchObject({
          ok: false,
          error: "validation",
          fields: { domain: "invalid" },
        });
      }
      expect(x.calls).toEqual([]);
    });

    it("queues the check and attach; a foreign id gives the answer of a missing one (R8)", async () => {
      const x = world(row(family, {}));
      expect(await run(refresh, x, { [id]: ID })).toEqual({
        ok: true,
        done: "certificateRefreshQueued",
      });
      expect(x.requests[0]).toMatchObject({ kind: "refresh_certificate", payload: {} });
      expect(await run(refresh, world(row(family, {})), { [id]: FOREIGN })).toEqual({
        ok: false,
        error: "not_found",
      });
    });
  });
});

describe("cache behaviours of a CDN", () => {
  const form = {
    cdnId: ID,
    defaultBehavior: "cache",
    defaultTtl: "3600",
    minTtl: "0",
    maxTtl: "86400",
    allowedMethods: "GET,HEAD",
    cachedMethods: "GET,HEAD",
    cookies: "none",
    headers: "none",
    queryStrings: "off",
    paths: "/images/*=cache\n*.php=dont-cache",
  };

  it("queues the whole checked policy", async () => {
    const x = world(row("cdn", {}));
    expect(await run(CDN_CACHE_BEHAVIORS, x, form)).toEqual({ ok: true, done: "cacheQueued" });
    expect(x.requests[0]).toMatchObject({
      kind: "set_cache_behaviors",
      payload: {
        defaultBehavior: "cache",
        settings: { defaultTtl: 3600, maximumTtl: 86400, queryStrings: false },
        paths: [
          { path: "images/*", behavior: "cache" },
          { path: "*.php", behavior: "dont-cache" },
        ],
      },
    });
  });

  it("names every wrong field and queues nothing", async () => {
    const x = world(row("cdn", {}));
    const r = await run(CDN_CACHE_BEHAVIORS, x, {
      ...form,
      defaultTtl: "-1",
      allowedMethods: "ALL",
      paths: "nonsense",
    });
    expect(r).toMatchObject({
      ok: false,
      error: "validation",
      fields: { defaultTtl: "invalid", allowedMethods: "invalid", paths: "invalid" },
    });
    expect(x.calls).toEqual([]);
  });
});

describe("origin of a CDN (R8, R11)", () => {
  const config = { originId: ORIGIN_A, region: "us-east-1" };
  const server = row("linux_instance", {}, { id: ORIGIN_B });
  const w = (extra: ResourceSummary[] = [server]) => world(row("cdn", config), extra);

  it("changes to another active server, load balancer or bucket of the customer, by id", async () => {
    for (const family of ["linux_instance", "windows_instance", "load_balancer", "bucket"]) {
      const x = w([row(family, {}, { id: ORIGIN_B })]);
      expect(await run(CDN_ORIGIN, x, { cdnId: ID, originId: ORIGIN_B })).toEqual({
        ok: true,
        done: "originQueued",
      });
      expect(x.requests[0]).toMatchObject({
        kind: "set_cdn_origin",
        payload: { originId: ORIGIN_B },
      });
    }
  });

  it("refuses another family, an inactive row, the same origin, another customer's id and free text with one answer", async () => {
    const cases: [string, ResourceSummary[]][] = [
      [ORIGIN_B, [row("database", {}, { id: ORIGIN_B })]],
      [ORIGIN_B, [row("linux_instance", {}, { id: ORIGIN_B, state: "suspended" })]],
      [ORIGIN_A, [row("linux_instance", {}, { id: ORIGIN_A })]],
      [OTHERS, []],
    ];
    for (const [originId, extra] of cases) {
      const x = w(extra);
      expect(await run(CDN_ORIGIN, x, { cdnId: ID, originId })).toEqual({
        ok: false,
        error: "validation",
        fields: { originId: "invalid" },
      });
      expect(x.requests).toEqual([]);
    }
    for (const originId of ["my-server", "tc-instance-0123456789abcdef", "", undefined]) {
      const x = w();
      expect(await run(CDN_ORIGIN, x, { cdnId: ID, originId })).toMatchObject({
        ok: false,
        error: "validation",
      });
      expect(x.calls).toEqual([]);
    }
  });
});

describe("public endpoint of a container service", () => {
  const config = { deployment: SAVED };
  const form = { containerId: ID, container: "1", port: "80", healthCheckPath: "/up" };

  it("queues deploy_containers with the saved containers and the changed endpoint", async () => {
    const x = world(row("container_service", config));
    expect(await run(CONTAINER_ENDPOINT, x, form)).toEqual({ ok: true, done: "endpointQueued" });
    expect(x.requests[0]).toMatchObject({
      kind: "deploy_containers",
      idempotencyKey: `container-endpoint:${REQ}`,
      payload: {
        containers: [
          {
            image: "nginx:1.27",
            environment: { TOKEN: "s3cr3t" },
            ports: [{ port: 80, protocol: "HTTP" }],
          },
        ],
        publicEndpoint: { container: 0, port: 80, healthCheckPath: "/up" },
      },
    });
    // the environment value travels to the operation only, never to the audit entry (R14)
    expect(x.calls.join(" ")).not.toContain("s3cr3t");
  });

  it("removes the endpoint on request", async () => {
    const x = world(
      row("container_service", {
        deployment: { ...SAVED, publicEndpoint: { containerName: "c1", containerPort: 80 } },
      }),
    );
    expect(await run(CONTAINER_ENDPOINT, x, { containerId: ID, remove: "yes" })).toMatchObject({
      ok: true,
    });
    expect((x.requests[0]?.payload as Record<string, unknown>)["publicEndpoint"]).toBeUndefined();
  });

  it("refuses a port the container does not declare, a bad container number or path, and a service with no deployment", async () => {
    for (const bad of [
      { port: "9999" },
      { container: "2" },
      { container: "x" },
      { port: "" },
      { healthCheckPath: "up" },
    ]) {
      const x = world(row("container_service", config));
      expect(
        await run(CONTAINER_ENDPOINT, x, { ...form, ...bad }),
        JSON.stringify(bad),
      ).toMatchObject({
        ok: false,
        error: "validation",
      });
      expect(x.requests).toEqual([]);
    }
    const none = world(row("container_service", {}));
    expect(await run(CONTAINER_ENDPOINT, none, form)).toMatchObject({
      ok: false,
      error: "validation",
    });
  });

  it("another customer's service is a missing one (R8)", async () => {
    expect(
      await run(CONTAINER_ENDPOINT, world(row("container_service", config)), {
        ...form,
        containerId: FOREIGN,
      }),
    ).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});
