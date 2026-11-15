import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { APPROVAL_SETTING } from "../operations/approval";
import {
  OperationKeyConflict,
  insertOperation,
  operationInsertValues,
  type OperationInput,
} from "../operations/insert";
import { APPROVAL_UNTIL } from "../operations/kinds";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket, newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
let resourceId = "";
let customerId = "";
// WPU-X23: one live destroy per resource, so every destroy of a test gets a resource of its own.
const freshResource = () => newResource(t.pool, customerId);
// the end date of R13 is the settings row r13_approval_until (value: a JSON string); undefined removes the row
const putUntil = async (value: unknown) => {
  await ensureMarket(t.pool, "BD");
  await t.pool.query("delete from settings where key = $1", [APPROVAL_SETTING.key]);
  if (value === undefined) return;
  await t.pool.query(
    "insert into settings (id, key, market, scope, scope_id, value) values (gen_random_uuid(), $1, $2, $3, null, $4::jsonb)",
    [APPROVAL_SETTING.key, APPROVAL_SETTING.market, APPROVAL_SETTING.scope, JSON.stringify(value)],
  );
};
beforeAll(async () => {
  customerId = await newCustomer(t.pool);
  resourceId = await newResource(t.pool, customerId);
  await putUntil(APPROVAL_UNTIL);
});
const NOW = new Date("2026-11-11T10:00:00Z");
const CUTOFF = new Date("2026-12-01T18:00:00Z");
const UNTIL = new Date(APPROVAL_UNTIL);
const as =
  (role: DatabaseRole) =>
  <T>(fn: (tx: Tx) => Promise<T>) =>
    runTransaction(t.db, fn, { role });
const input = (over: Partial<OperationInput> = {}): OperationInput => ({
  resourceId,
  kind: "reboot",
  payload: {},
  idempotencyKey: "test:" + uniqueSuffix(),
  ...over,
});
const stored = async (id: string) =>
  (
    await t.pool.query(
      "select state, needs_approval, kind, payload, enqueue_seq from operations where id = $1",
      [id],
    )
  ).rows[0];
const count = async (key: string) =>
  (
    await t.pool.query("select count(*)::int as n from operations where idempotency_key = $1", [
      key,
    ])
  ).rows[0].n as number;

describe("insertOperation", () => {
  it.each(["web_rw", "worker_rw", "admin_rw"] as const)(
    "%s inserts a queued operation, and the same key again inserts nothing",
    async (role) => {
      const i = input();
      const first = await as(role)((tx) => insertOperation(tx, i, NOW));
      expect(first).toEqual({
        operationId: expect.any(String),
        created: true,
        state: "queued",
        enqueueSeq: 0,
      });
      const again = await as(role)((tx) => insertOperation(tx, i, NOW));
      expect(again).toEqual({
        operationId: first.operationId,
        created: false,
        state: "queued",
        enqueueSeq: 0,
      });
      expect(await count(i.idempotencyKey)).toBe(1);
    },
  );

  it("[Review Focus 2] a destructive kind before the cutoff is stored as needs_approval with the flag, whatever the caller asks", async () => {
    for (const needsApproval of [undefined, false, true]) {
      const rid = await freshResource();
      const r = await as("web_rw")((tx) =>
        insertOperation(tx, input({ resourceId: rid, kind: "destroy", needsApproval }), NOW),
      );
      expect(r.state).toBe("needs_approval");
      expect(await stored(r.operationId)).toMatchObject({
        state: "needs_approval",
        needs_approval: true,
        kind: "destroy",
      });
    }
  });

  it("after the cutoff a destructive kind is queued without the flag, and a caller can flag any kind", async () => {
    const lateResource = await freshResource();
    const late = await as("worker_rw")((tx) =>
      insertOperation(tx, input({ resourceId: lateResource, kind: "destroy" }), CUTOFF),
    );
    expect(await stored(late.operationId)).toMatchObject({
      state: "queued",
      needs_approval: false,
    });
    const asked = await as("worker_rw")((tx) =>
      insertOperation(tx, input({ kind: "suspend", needsApproval: true }), NOW),
    );
    expect(await stored(asked.operationId)).toMatchObject({
      state: "needs_approval",
      needs_approval: true,
    });
  });

  it("the end date is read from the setting: moved earlier, moved later, missing and invalid (R13, R16)", async () => {
    const at = new Date("2026-11-20T00:00:00Z");
    const stateAfter = async () => {
      const i = input({ resourceId: await freshResource(), kind: "destroy" });
      return (await as("worker_rw")((tx) => insertOperation(tx, i, at))).state;
    };
    try {
      await putUntil("2026-11-15T00:00:00.000Z");
      expect(await stateAfter()).toBe("queued");
      await putUntil("2027-01-31T00:00:00.000Z");
      expect(await stateAfter()).toBe("needs_approval");
      for (const bad of [undefined, "tomorrow", 42, null]) {
        await putUntil(bad);
        expect(await stateAfter(), JSON.stringify(bad)).toBe("needs_approval");
      }
    } finally {
      await putUntil(APPROVAL_UNTIL);
    }
  });

  it("a key of the customer key space is for operations.request, not for a system caller", async () => {
    await expect(
      as("worker_rw")((tx) => insertOperation(tx, input({ idempotencyKey: "customer:x:k" }), NOW)),
    ).rejects.toThrow(RangeError);
    expect(await count("customer:x:k")).toBe(0);
  });

  it("a hostile string in the payload is stored and read back as it is, and the table still exists", async () => {
    const note = "it's $1; drop table operations; -- \\ \"";
    const r = await as("web_rw")((tx) =>
      insertOperation(tx, input({ kind: "set_ports", payload: { note } }), NOW),
    );
    expect((await stored(r.operationId)).payload).toEqual({ note });
    expect(await count("no-such-key")).toBe(0);
  });

  it("admin_rw cannot insert a flagged operation (its grant has no needs_approval column), and nothing is stored", async () => {
    const i = input({ kind: "destroy" });
    await expect(as("admin_rw")((tx) => insertOperation(tx, i, NOW))).rejects.toMatchObject({
      code: "42501",
    });
    expect(await count(i.idempotencyKey)).toBe(0);
  });

  it("the same key for another kind or another resource is a conflict, and the stored row stays", async () => {
    const i = input();
    const first = await as("web_rw")((tx) => insertOperation(tx, i, NOW));
    await expect(
      as("web_rw")((tx) => insertOperation(tx, { ...i, kind: "stop" }, NOW)),
    ).rejects.toBeInstanceOf(OperationKeyConflict);
    const other = await newResource(t.pool, await newCustomer(t.pool));
    await expect(
      as("web_rw")((tx) => insertOperation(tx, { ...i, resourceId: other }, NOW)),
    ).rejects.toBeInstanceOf(OperationKeyConflict);
    expect(await stored(first.operationId)).toMatchObject({ kind: "reboot" });
  });

  it("the payload is stored, and a replay with another payload returns the first row", async () => {
    const i = input({ kind: "set_ports", payload: { ports: [22, 443] } });
    const first = await as("worker_rw")((tx) => insertOperation(tx, i, NOW));
    const replay = await as("worker_rw")((tx) =>
      insertOperation(tx, { ...i, payload: { ports: [] } }, NOW),
    );
    expect(replay).toMatchObject({ operationId: first.operationId, created: false });
    expect((await stored(first.operationId)).payload).toEqual({ ports: [22, 443] });
  });

  it("two inserts with one key at the same moment give one row and one created", async () => {
    const i = input();
    const both = await Promise.all([
      as("web_rw")((tx) => insertOperation(tx, i, NOW)),
      as("web_rw")((tx) => insertOperation(tx, i, NOW)),
    ]);
    expect(both.filter((r) => r.created)).toHaveLength(1);
    expect(both[0]?.operationId).toBe(both[1]?.operationId);
    expect(await count(i.idempotencyKey)).toBe(1);
  });
});

describe("operationInsertValues", () => {
  it("returns a UUID v7, the JSON of the payload, and {} for no payload", () => {
    const v = operationInsertValues(input({ payload: { a: 1 } }), NOW, UNTIL);
    expect(v.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(v).toMatchObject({
      state: "queued",
      needsApproval: false,
      payloadJson: '{"a":1}',
      resourceId,
    });
    expect(operationInsertValues(input({ payload: undefined }), NOW, UNTIL).payloadJson).toBe("{}");
    expect(operationInsertValues(input({ payload: null }), NOW, UNTIL).payloadJson).toBe("{}");
  });

  it("flags a destructive kind before the end date and when the end date is unknown, and accepts the customer key space", () => {
    expect(operationInsertValues(input({ kind: "destroy" }), NOW, UNTIL)).toMatchObject({
      state: "needs_approval",
      needsApproval: true,
    });
    expect(operationInsertValues(input({ kind: "destroy" }), CUTOFF, UNTIL)).toMatchObject({
      state: "queued",
      needsApproval: false,
    });
    expect(operationInsertValues(input({ kind: "destroy" }), CUTOFF, null)).toMatchObject({
      state: "needs_approval",
      needsApproval: true,
    });
    expect(
      operationInsertValues(input({ idempotencyKey: "customer:c:k" }), NOW, UNTIL).idempotencyKey,
    ).toBe("customer:c:k");
  });

  // D21: the fixed table decides; a request can raise the gate and never lower it.
  it("[D21] the request can raise the gate and never lower it", () => {
    expect(
      operationInsertValues(input({ kind: "destroy", needsApproval: false }), NOW, UNTIL),
    ).toMatchObject({ needsApproval: true, state: "needs_approval" });
    expect(
      operationInsertValues(input({ kind: "reboot", needsApproval: true }), NOW, UNTIL),
    ).toMatchObject({ needsApproval: true, state: "needs_approval" });
    expect(
      operationInsertValues(input({ kind: "reboot", needsApproval: false }), NOW, UNTIL),
    ).toMatchObject({ needsApproval: false, state: "queued" });
  });

  const refusals: [string, Partial<OperationInput>][] = [
    ["a resource id that is not a UUID", { resourceId: "x" }],
    ["a kind that is not an operation kind", { kind: "teleport" as never }],
    ["an empty key", { idempotencyKey: "" }],
    ["a key of 201 characters", { idempotencyKey: "a".repeat(201) }],
    ["a key with a space", { idempotencyKey: "a b" }],
    ["an array as payload", { payload: [] }],
    ["a string as payload", { payload: "x" }],
    ["a bigint in the payload", { payload: { n: 1n } }],
    ["a payload over 16 KiB", { payload: { x: "a".repeat(17_000) } }],
    [
      "a NUL character in a payload string (jsonb refuses it: 22P05)",
      { payload: { n: "a\u0000b" } },
    ],
    [
      "a lone surrogate in a payload string (jsonb refuses it: 22P02)",
      { payload: { n: "\ud800" } },
    ],
    ["a NUL character in a payload key", { payload: { "k\u0000": 1 } }],
    ["a lone surrogate in a nested payload string", { payload: { a: { b: ["ok", "\udc00"] } } }],
  ];
  it.each(refusals)("refuses %s before any query", (_name, over) => {
    expect(() => operationInsertValues(input(over), NOW, UNTIL)).toThrow(RangeError);
  });

  it("accepts an emoji pair and Bengali text", () => {
    expect(() =>
      operationInsertValues(input({ payload: { a: "😀", b: "বাংলা" } }), NOW, UNTIL),
    ).not.toThrow();
  });
});
