import { v7 as uuidv7 } from "uuid";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { resetCapacity, seedPool } from "../testing/capacity";
import { runTransaction } from "../tx";
import { ensureMarket, newAdmin, newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WP8-T5: the reads of /operations and /capacity, as admin_rw. They need no audit row (a read), but the
// decisions that follow them do, and the detail shows that trail.
const t = useTempDatabase();
const REGION = "ap-southeast-1";
const AT = new Date("2030-01-01T00:00:00.000Z");
let actor: AdminActor;
let resourceId = "";
const asAdmin = <T>(a: AdminActor, fn: (r: AdminRepos) => Promise<T>) =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, a)), { role: "admin_rw" });
const seed = (state: string, over: Record<string, unknown> = {}) =>
  insertRow(t.pool, "operations", {
    resource_id: resourceId,
    kind: "reboot",
    state,
    idempotency_key: "a:" + uniqueSuffix(),
    ...over,
  });

beforeAll(async () => {
  resourceId = await newResource(t.pool, await newCustomer(t.pool), { region: REGION });
  actor = { adminId: await newAdmin(t.pool, "ops"), role: "ops", ip: "203.0.113.9" };
});
beforeEach(async () => {
  await ensureMarket(t.pool);
  await t.pool.query("delete from operations");
});

describe("operations.queue", () => {
  it("lists the rows of one state, oldest first, and pages with a cursor", async () => {
    const a = await seed("needs_attention", { created_at: "2030-01-01T00:00:01Z" });
    const b = await seed("needs_attention", { created_at: "2030-01-01T00:00:02Z" });
    await seed("queued");
    const first = await asAdmin(actor, (r) =>
      r.operations.queue({ state: "needs_attention", limit: 1 }),
    );
    expect(first.rows.map((x) => x.id)).toEqual([a]);
    expect(first.nextAfter).toBe(a);
    const second = await asAdmin(actor, (r) =>
      r.operations.queue({ state: "needs_attention", limit: 1, after: a }),
    );
    expect(second.rows.map((x) => x.id)).toEqual([b]);
    expect(second.nextAfter).toBeNull();
    expect(first.rows[0]).toMatchObject({
      resourceId,
      kind: "reboot",
      state: "needs_attention",
      destructive: false,
      region: REGION,
    });
  });

  it("marks a destructive kind and filters by kind", async () => {
    const d = await seed("needs_approval", { kind: "destroy", needs_approval: true });
    await seed("needs_approval", { needs_approval: true });
    const page = await asAdmin(actor, (r) => r.operations.queue({ kind: "destroy" }));
    expect(page.rows.map((x) => x.id)).toEqual([d]);
    expect(page.rows[0]?.destructive).toBe(true);
  });

  it("refuses a filter that is not ours before any query", async () => {
    await expect(
      asAdmin(actor, (r) => r.operations.queue({ state: "x'; drop table operations" as never })),
    ).rejects.toThrow(TypeError);
    await expect(asAdmin(actor, (r) => r.operations.queue({ limit: 0 }))).rejects.toThrow(
      TypeError,
    );
    await expect(asAdmin(actor, (r) => r.operations.queue({ after: "nope" }))).rejects.toThrow(
      TypeError,
    );
  });
});

describe("operations.counts", () => {
  it("counts every state, zero when empty", async () => {
    await seed("needs_attention");
    await seed("needs_attention");
    await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    const counts = await asAdmin(actor, (r) => r.operations.counts());
    expect(counts).toMatchObject({
      needs_attention: 2,
      needs_approval: 1,
      running: 0,
      failed: 0,
      queued: 0,
      waiting: 0,
      succeeded: 0,
    });
  });
});

describe("operations.detail", () => {
  it("shows the row and the trail of admin decisions on it, newest last", async () => {
    const id = await seed("needs_approval", { needs_approval: true, kind: "destroy" });
    expect(
      await asAdmin(actor, (r) => r.operations.approve({ operationId: id, at: AT }, "phone call")),
    ).toMatchObject({ ok: true });
    const detail = await asAdmin(actor, (r) => r.operations.detail(id));
    expect(detail).toMatchObject({
      ok: true,
      value: { id, state: "queued", approvedBy: actor.adminId, kind: "destroy" },
    });
    if (!detail.ok) throw new Error("unreachable");
    expect(detail.value.trail).toEqual([
      {
        action: "operation.approve",
        actorId: actor.adminId,
        at: expect.any(Date),
        reason: "phone call",
      },
    ]);
  });

  it("answers not_found for an unknown id and for a text that is not a UUID", async () => {
    expect(await asAdmin(actor, (r) => r.operations.detail(uuidv7()))).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await asAdmin(actor, (r) => r.operations.detail("nope"))).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});

describe("waitlist.counts", () => {
  it("counts the open entries of each family, Region and reason, not the notified or served", async () => {
    await t.pool.query("delete from waitlist_entries");
    const mk = (over: Record<string, unknown> = {}) =>
      insertRow(t.pool, "waitlist_entries", {
        email: `w${uniqueSuffix()}@example.test`,
        product_family: "linux_instance",
        region: REGION,
        reason: "capacity",
        ...over,
      });
    await mk();
    await mk();
    await mk({ notified_at: "2030-01-01T00:00:00Z" });
    await mk({ reason: "flag_off" });
    const counts = await asAdmin(actor, (r) => r.waitlist.counts());
    expect(counts).toContainEqual({
      productFamily: "linux_instance",
      region: REGION,
      reason: "capacity",
      open: 2,
    });
    expect(counts).toContainEqual({
      productFamily: "linux_instance",
      region: REGION,
      reason: "flag_off",
      open: 1,
    });
  });
});

describe("capacity.pending", () => {
  it("is the unreleased reservations of resources still creating in the cell", async () => {
    await resetCapacity(t.pool);
    const pool = await seedPool(t.pool, {
      cells: [{ region: REGION, quotaCode: "instance_vcpu", limit: 20, used: 3 }],
    });
    await newResource(t.pool, await newCustomer(t.pool), {
      pool_account_id: pool.poolAccountId,
      state: "creating",
      config: {
        capacityReservation: { cells: [{ region: REGION, quotaCode: "instance_vcpu", amount: 2 }] },
      },
    });
    const n = await asAdmin(actor, (r) =>
      r.capacity.pending({
        poolAccountId: pool.poolAccountId,
        region: REGION,
        quotaCode: "instance_vcpu",
      }),
    );
    expect(n).toBe(2);
    await expect(
      asAdmin(actor, (r) =>
        r.capacity.pending({
          poolAccountId: "x",
          region: REGION,
          quotaCode: "instance_vcpu",
        }),
      ),
    ).rejects.toThrow(TypeError);
  });
});
