import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { FamilyActionDeps, FamilyRepos } from "./bucket-frame.ts";
import {
  createContainerDraftCore,
  deployContainersCore,
  deploymentFromForm,
  destroyContainerServiceCore,
} from "./container-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SERVICE = "0190aaaa-0000-7000-8000-0000000000d1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const session = (signedInAt = new Date(NOW.getTime() - 60_000)): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

const row = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: SERVICE,
  family: "container_service",
  productId: PRODUCT,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "Web app" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

function world(
  over: {
    rows?: ResourceSummary[];
    flag?: boolean;
    allowed?: boolean;
    auditOk?: boolean;
    session?: CustomerSession | null;
    /** WPU-S3: the operations of the service, as the customer's repository lists them. */
    ops?: { kind: string; state: string }[] | "throws";
  } = {},
) {
  const calls: string[] = [];
  const payloads: unknown[] = [];
  const rows = over.rows ?? [row()];
  const repos: FamilyRepos = {
    flagOn: async () => over.flag !== false,
    resources: {
      list: async () => rows,
      get: async (id) => rows.find((r) => r.id === id) ?? null,
      countLive: async () => 0,
      listChildren: async () => [],
      createBackupRow: async () => {
        throw new Error("not used");
      },
    },
    subscriptions: {
      requestDestroy: async (input: { idempotencyKey: string; withFinalSnapshot: boolean }) => {
        calls.push(`destroy:${input.idempotencyKey}:${input.withFinalSnapshot}`);
        return {
          ok: true,
          replayed: false,
          value: { destroyOperationId: "d", finalSnapshotOperationId: null, needsApproval: true },
        } as never;
      },
    } as never,
    operations: {
      get: async () => null,
      listForResource: async () => {
        if (over.ops === "throws") throw new Error("operations unreadable");
        return (over.ops ?? []) as never;
      },
      listRecent: async () => [],
      request: async (input) => {
        calls.push(`op:${input.kind}:${input.idempotencyKey}:${input.resourceId}`);
        payloads.push(input.payload);
        return { ok: true, replayed: false, value: { needsApproval: false } } as never;
      },
    },
    audit: {
      record: async (input: { action: string }) => {
        calls.push(`audit:${input.action}`);
        return over.auditOk === false ? { ok: false, error: "validation" } : { ok: true };
      },
    } as never,
    rateLimits: {
      consume: async () => {
        calls.push("rate");
        return { allowed: over.allowed !== false } as never;
      },
    } as never,
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => (over.session === undefined ? session() : over.session),
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push(`store:${customerId}`);
      return fn(repos);
    },
  };
  return { deps, calls, payloads };
}

const form = {
  containerId: SERVICE,
  requestId: REQ,
  image: "nginx:1.27",
  port: "80",
  protocol: "HTTP",
  environment: "MODE=prod\nLOG_LEVEL=info\n\n",
  publicEndpoint: "on",
  healthCheckPath: "/health",
};

describe("deploymentFromForm (what the fields of the form become)", () => {
  it("builds the shape of parseDeployment: one container, its port, the env, the public endpoint", () => {
    expect(deploymentFromForm(form)).toEqual({
      ok: true,
      value: {
        containers: [
          {
            image: "nginx:1.27",
            ports: [{ port: 80, protocol: "HTTP" }],
            environment: { MODE: "prod", LOG_LEVEL: "info" },
          },
        ],
        publicEndpoint: { container: 0, port: 80, healthCheckPath: "/health" },
      },
    });
  });

  it("has no port, no env and no endpoint when the fields are empty", () => {
    expect(
      deploymentFromForm({ image: "nginx", port: "", protocol: "HTTP", environment: "" }),
    ).toEqual({ ok: true, value: { containers: [{ image: "nginx" }] } });
  });

  it("names the field that is wrong, and a private registry image is one of them (no registry login)", () => {
    const field = (over: Record<string, string>) => {
      const r = deploymentFromForm({ ...form, ...over });
      return r.ok ? null : r.fields;
    };
    expect(field({ image: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/app:1" })).toEqual({
      image: "invalid",
    });
    expect(field({ image: "Not An Image" })).toEqual({ image: "invalid" });
    expect(field({ image: "" })).toEqual({ image: "invalid" });
    expect(field({ port: "0" })).toEqual({ port: "invalid" });
    expect(field({ port: "70000" })).toEqual({ port: "invalid" });
    expect(field({ port: "80x" })).toEqual({ port: "invalid" });
    expect(field({ protocol: "FTP" })).toEqual({ protocol: "invalid" });
    expect(field({ environment: "1BAD=x" })).toEqual({ environment: "invalid" });
    expect(field({ environment: "NOEQUALS" })).toEqual({ environment: "invalid" });
    expect(field({ environment: "A=1\u0007" })).toEqual({ environment: "invalid" });
    expect(field({ healthCheckPath: "health" })).toEqual({ healthCheckPath: "invalid" });
    expect(field({ healthCheckPath: "/a b" })).toEqual({ healthCheckPath: "invalid" });
    // A public endpoint needs a port to point at.
    expect(field({ port: "" })).toEqual({ port: "invalid" });
  });

  it("holds no name for the container: names are generated later (R11)", () => {
    const r = deploymentFromForm({ ...form, name: "evil", containerName: "x;rm" });
    expect(JSON.stringify(r)).not.toMatch(/evil|x;rm/);
  });
});

describe("deploymentFromForm: several containers, several ports and a command (WPU-G8)", () => {
  const base = { image: "nginx:1.27", port: "80, 8080/TCP", protocol: "HTTP", environment: "" };

  it("reads a port list with an optional protocol each, and a command with one argument per line", () => {
    expect(deploymentFromForm({ ...base, command: "nginx\n-g\ndaemon off;\n\n" })).toEqual({
      ok: true,
      value: {
        containers: [
          {
            image: "nginx:1.27",
            ports: [
              { port: 80, protocol: "HTTP" },
              { port: 8080, protocol: "TCP" },
            ],
            command: ["nginx", "-g", "daemon off;"],
          },
        ],
      },
    });
  });

  it("adds a second and a third container only when something was typed for them", () => {
    const r = deploymentFromForm({
      ...base,
      image2: "redis:7",
      port2: "6379",
      protocol2: "TCP",
      environment2: "MAXMEM=64mb",
      publicEndpoint: "on",
      endpointContainer: "1",
      endpointPort: "8080",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        containers: [
          {
            image: "nginx:1.27",
            ports: [
              { port: 80, protocol: "HTTP" },
              { port: 8080, protocol: "TCP" },
            ],
          },
          {
            image: "redis:7",
            ports: [{ port: 6379, protocol: "TCP" }],
            environment: { MAXMEM: "64mb" },
          },
        ],
        publicEndpoint: { container: 0, port: 8080 },
      },
    });
    const only = deploymentFromForm({ ...base, image3: "", port3: "" });
    expect(only.ok && (only.value["containers"] as unknown[]).length).toBe(1);
  });

  it("points the endpoint at the chosen container and its first port when no port is given", () => {
    const r = deploymentFromForm({
      ...base,
      image2: "api:1",
      port2: "3000",
      publicEndpoint: "on",
      endpointContainer: "2",
      healthCheckPath: "/up",
    });
    expect(r.ok && r.value["publicEndpoint"]).toEqual({
      container: 1,
      port: 3000,
      healthCheckPath: "/up",
    });
  });

  it("names the field of the container that is wrong", () => {
    const field = (over: Record<string, string>) => {
      const r = deploymentFromForm({ ...base, ...over });
      return r.ok ? null : r.fields;
    };
    expect(field({ image2: "", port2: "80" })).toEqual({ image2: "invalid" });
    expect(field({ image2: "x", environment2: "bad" })).toEqual({ environment2: "invalid" });
    expect(field({ image2: "x", port2: "99999" })).toEqual({ port2: "invalid" });
    expect(field({ port: "80, 80" })).toEqual({ port: "invalid" });
    expect(field({ command: "a\u0007b" })).toEqual({ command: "invalid" });
    expect(field({ command2: "x", image2: "x", port2: "1" })).toBeNull();
    // the endpoint names a container that was not filled in, or a port it does not declare
    expect(field({ publicEndpoint: "on", endpointContainer: "3" })).toEqual({
      endpointContainer: "invalid",
    });
    expect(field({ publicEndpoint: "on", endpointPort: "9" })).toEqual({ endpointPort: "invalid" });
  });

  it("never carries an environment value into an error", () => {
    const r = deploymentFromForm({ ...base, environment: "TOKEN=hunter2\nbad line" });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
});

describe("deployContainersCore", () => {
  it("authenticates, rates, writes deploy_containers with a stable key and audits, in order (R9, R7)", async () => {
    const { deps, calls, payloads } = world();
    expect(await deployContainersCore(deps, form)).toEqual({ ok: true, done: "deployQueued" });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `op:deploy_containers:container-deploy:${REQ}:${SERVICE}`,
      "audit:container.deploy",
    ]);
    expect(payloads).toEqual([
      {
        containers: [
          {
            image: "nginx:1.27",
            ports: [{ port: 80, protocol: "HTTP" }],
            environment: { MODE: "prod", LOG_LEVEL: "info" },
          },
        ],
        publicEndpoint: { container: 0, port: 80, healthCheckPath: "/health" },
      },
    ]);
    // The environment values are not in the audit call (R14).
    expect(calls.join(" ")).not.toContain("prod");
  });

  it("refuses bad fields before any store, with the name of the field", async () => {
    const { deps, calls } = world();
    expect(await deployContainersCore(deps, { ...form, image: "evil.example.com/x" })).toEqual({
      ok: false,
      error: "validation",
      fields: { image: "invalid" },
    });
    expect(await deployContainersCore(deps, { ...form, containerId: "../x" })).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(calls).toEqual([]);
  });

  it("only an active service is deployed to; another customer's service is not_found (R8)", async () => {
    for (const state of ["creating", "suspended", "stopped", "failed"] as const) {
      expect(await deployContainersCore(world({ rows: [row({ state })] }).deps, form)).toEqual({
        ok: false,
        error: "not_allowed",
      });
    }
    expect(await deployContainersCore(world({ rows: [] }).deps, form)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await deployContainersCore(world({ rows: [row({ family: "bucket" })] }).deps, form),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("respects session, flag, rate limit and the audit rule", async () => {
    expect(await deployContainersCore(world({ session: null }).deps, form)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(await deployContainersCore(world({ flag: false }).deps, form)).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(await deployContainersCore(world({ allowed: false }).deps, form)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(await deployContainersCore(world({ auditOk: false }).deps, form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("destroyContainerServiceCore (U10, R13)", () => {
  const input = { containerId: SERVICE, requestId: REQ, confirmName: "Web app" };

  it("needs a fresh sign-in first, then the typed name, then queues the destroy and audits", async () => {
    const stale = world({ session: session(new Date(NOW.getTime() - 3_600_000)) });
    expect(await destroyContainerServiceCore(stale.deps, input)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(stale.calls).toEqual([]);

    expect(
      await destroyContainerServiceCore(world().deps, { ...input, confirmName: "web app" }),
    ).toEqual({ ok: false, error: "name_mismatch" });

    const { deps, calls } = world();
    expect(await destroyContainerServiceCore(deps, input)).toEqual({
      ok: true,
      done: "destroyQueued",
      approval: true,
    });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `destroy:destroy:${REQ}:false`,
      "audit:container.destroy",
    ]);
  });

  it("is cross-tenant safe and refuses a service that is gone", async () => {
    expect(await destroyContainerServiceCore(world({ rows: [] }).deps, input)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await destroyContainerServiceCore(world({ rows: [row({ state: "destroyed" })] }).deps, input),
    ).toEqual({ ok: false, error: "not_allowed" });
  });
});

describe("WPU-S3: destroy while a plan apply is on its way", () => {
  const input = { containerId: SERVICE, requestId: REQ, confirmName: "Web app" };

  it("is refused with busy while scale_container is queued, running or waiting; nothing is queued or audited", async () => {
    for (const state of ["queued", "running", "waiting", "needs_approval"]) {
      const w = world({ ops: [{ kind: "scale_container", state }] });
      expect(await destroyContainerServiceCore(w.deps, input)).toEqual({
        ok: false,
        error: "busy",
      });
      expect(w.calls.filter((c) => c.startsWith("destroy:") || c.startsWith("audit:"))).toEqual([]);
    }
  });

  it("a finished or failed apply does not block, and an unreadable list refuses (R16)", async () => {
    for (const state of ["succeeded", "needs_attention"]) {
      expect(
        (
          await destroyContainerServiceCore(
            world({ ops: [{ kind: "scale_container", state }] }).deps,
            input,
          )
        ).ok,
      ).toBe(true);
    }
    expect(await destroyContainerServiceCore(world({ ops: "throws" }).deps, input)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("createContainerDraftCore", () => {
  const draft = { productId: PRODUCT, region: "ap-southeast-1", displayName: "Web app" };
  function orders() {
    const drafted: unknown[] = [];
    const deps = {
      authenticate: async () => session(),
      rateLimit: async () => ({ allowed: true }),
      orders: {
        createOrderDraft: async (_s: unknown, input: unknown) => {
          drafted.push(input);
          return { ok: true, value: { token: "signed.token" } };
        },
      },
    } as unknown as OrderActionDeps;
    return { deps, drafted };
  }

  it("passes only the three fields, as the family `container_service`; power and scale come from the plan", async () => {
    const { deps, drafted } = orders();
    expect(
      await createContainerDraftCore(deps, { ...draft, power: "xlarge", scale: "20", image: "x" }),
    ).toEqual({ ok: true, token: "signed.token" });
    expect(drafted).toEqual([{ family: "container_service", config: draft }]);
  });

  it("refuses without a session before the validation, the limit and the order code (R9, WP9-T2 sweep)", async () => {
    const touched: string[] = [];
    const deps = {
      authenticate: async () => null,
      rateLimit: async () => {
        touched.push("rateLimit");
        return { allowed: true };
      },
      orders: {
        createOrderDraft: async () => {
          touched.push("createOrderDraft");
          return { ok: true, value: { token: "t" } };
        },
      },
    } as unknown as OrderActionDeps;
    expect(await createContainerDraftCore(deps, draft)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(touched).toEqual([]);
  });

  it("refuses a bad name", async () => {
    expect(
      await createContainerDraftCore(orders().deps, { ...draft, displayName: "a;b" }),
    ).toMatchObject({ ok: false, error: "validation", fields: { displayName: "invalid" } });
  });
});
