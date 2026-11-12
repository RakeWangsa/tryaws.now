import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import { BUCKET_INSTANCE_ACCESS, DB_OPTIONS, consoleCore } from "./console-actions.ts";
import type { FamilyActionDeps, FamilyRepos } from "./family-actions.ts";

// WPU-G9: the maintenance window of a database and the access of one instance to a bucket. The same
// proofs as the table of console-actions.test.ts: R7 key, R8 answer, R9 order, R16 refusals.
const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const BUCKET = "0190aaaa-0000-7000-8000-0000000000b1";
const INSTANCE = "0190aaaa-0000-7000-8000-0000000000c1";
const FOREIGN_INSTANCE = "0190aaaa-0000-7000-8000-0000000000c9";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const DB = "0190aaaa-0000-7000-8000-0000000000d1";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(NOW.getTime() - 60_000),
});
const row = (id: string, family: string, state = "active"): ResourceSummary => ({
  id,
  family,
  productId: null,
  region: "ap-southeast-1",
  state: state as ResourceSummary["state"],
  parentResourceId: null,
  config: { displayName: "mine" },
  createdAt: NOW,
  deletedAt: null,
});

function world(rows: ResourceSummary[]) {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const repos: FamilyRepos = {
    flagOn: async () => true,
    resources: { get: async (id: string) => rows.find((r) => r.id === id) ?? null } as never,
    subscriptions: {} as never,
    operations: {
      request: async (input: unknown) => {
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
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => session(),
    now: () => NOW,
    store: async (_c, fn) => fn(repos),
  };
  return { deps, calls, requests };
}

describe("database maintenance window", () => {
  const run = consoleCore(DB_OPTIONS);
  it("queues the window as a checked value", async () => {
    const w = world([row(DB, "database")]);
    const r = await run(w.deps, {
      databaseId: DB,
      requestId: REQ,
      maintenanceWindow: "tue:17:00-tue:17:30",
    });
    expect(r).toEqual({ ok: true, done: "optionsQueued" });
    expect(w.requests).toEqual([
      {
        resourceId: DB,
        kind: "set_db_options",
        idempotencyKey: `db-options:${REQ}`,
        payload: { maintenanceWindow: "tue:17:00-tue:17:30" },
      },
    ]);
  });
  it("refuses a window that is too short, in the wrong shape or with text around it", async () => {
    for (const bad of [
      "tue:17:00-tue:17:10",
      "17:00-17:30",
      "tue:17:00-tue:17:30;x",
      "TUE:17:00-TUE:18:00",
    ]) {
      const w = world([row(DB, "database")]);
      const r = await run(w.deps, { databaseId: DB, requestId: REQ, maintenanceWindow: bad });
      expect(r, bad).toMatchObject({
        ok: false,
        error: "validation",
        fields: { maintenanceWindow: "invalid" },
      });
      expect(w.requests).toEqual([]);
    }
  });
});

describe("bucket access for an instance", () => {
  const run = consoleCore(BUCKET_INSTANCE_ACCESS);
  const form = (over: Record<string, unknown> = {}) => ({
    bucketId: BUCKET,
    requestId: REQ,
    instanceId: INSTANCE,
    access: "allow",
    ...over,
  });
  const good = () => world([row(BUCKET, "bucket"), row(INSTANCE, "linux_instance")]);

  it("queues allow or deny for the customer's own instance (R7)", async () => {
    for (const access of ["allow", "deny"]) {
      const w = good();
      expect(await run(w.deps, form({ access }))).toEqual({
        ok: true,
        done: "instanceAccessQueued",
      });
      expect(w.requests).toEqual([
        {
          resourceId: BUCKET,
          kind: "set_bucket_resource_access",
          idempotencyKey: `bucket-instance-access:${REQ}`,
          payload: { instanceId: INSTANCE, access },
        },
      ]);
      expect(w.calls).toEqual(["request", "audit:bucket.instance_access"]);
    }
  });

  it("another customer's instance answers like a missing one and queues nothing (R8)", async () => {
    const foreign = good();
    const a = await run(foreign.deps, form({ instanceId: FOREIGN_INSTANCE }));
    const b = await run(good().deps, form({ instanceId: INSTANCE.replace("c1", "c2") }));
    expect(a).toEqual({ ok: false, error: "not_found" });
    expect(b).toEqual(a);
    expect(foreign.requests).toEqual([]);
  });

  it("an instance of a family or a state the action does not serve is the same answer (R8, R16)", async () => {
    for (const other of [row(INSTANCE, "database"), row(INSTANCE, "linux_instance", "destroyed")]) {
      const w = world([row(BUCKET, "bucket"), other]);
      expect(await run(w.deps, form())).toEqual({ ok: false, error: "not_found" });
      expect(w.requests).toEqual([]);
    }
  });

  it("validates the ids and the word before anything opens", async () => {
    const w = good();
    for (const bad of [
      { instanceId: "x" },
      { access: "maybe" },
      { access: "" },
      { instanceId: "" },
    ]) {
      expect(await run(w.deps, form(bad)), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(w.calls).toEqual([]);
  });

  it("refuses a bucket that is not active", async () => {
    const w = world([row(BUCKET, "bucket", "suspended"), row(INSTANCE, "linux_instance")]);
    expect(await run(w.deps, form())).toEqual({ ok: false, error: "not_allowed" });
    expect(w.requests).toEqual([]);
  });
});

// WPU-S6: the cap of 20 instances is refused at the console before an operation is queued.
describe("bucket access cap (WPU-S6)", () => {
  const run = consoleCore(BUCKET_INSTANCE_ACCESS);
  const many = Array.from(
    { length: 20 },
    (_, i) => `0190aaaa-0000-7000-8000-${String(i + 1).padStart(12, "1")}`,
  );
  const withList = (list: string[]) => {
    const bucket = {
      ...row(BUCKET, "bucket"),
      config: { displayName: "mine", accessInstances: list },
    };
    return world([bucket, row(INSTANCE, "linux_instance")]);
  };
  const form = (access: string) => ({
    bucketId: BUCKET,
    requestId: REQ,
    instanceId: INSTANCE,
    access,
  });

  it("refuses the 21st allow with a fixed error and queues nothing", async () => {
    const w = withList(many);
    const r = await run(w.deps, form("allow"));
    expect(r).toMatchObject({ ok: false, error: "not_allowed", fields: { instanceId: "limit" } });
    expect(w.requests).toEqual([]);
  });

  it("still queues allow for a listed instance, deny at 20 and allow at 19", async () => {
    expect((await run(withList([...many.slice(0, 19), INSTANCE]).deps, form("allow"))).ok).toBe(
      true,
    );
    expect((await run(withList(many).deps, form("deny"))).ok).toBe(true);
    expect((await run(withList(many.slice(0, 19)).deps, form("allow"))).ok).toBe(true);
  });
});
