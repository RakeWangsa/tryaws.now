import { APPROVAL_SETTING, APPROVAL_UNTIL, type OperationInput } from "@tc/db";
import {
  ensureMarket,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { enqueueOperation, makeEnqueueOperation } from "./enqueue";

const t = useTempDatabase();
let resourceId = "";
let customerId = "";
// WPU-X23: one live destroy per resource, so each destroy of a test gets a resource of its own.
const freshResource = () => newResource(t.pool, customerId);
beforeAll(async () => {
  customerId = await newCustomer(t.pool);
  resourceId = await newResource(t.pool, customerId);
  await ensureMarket(t.pool, "BD");
  await t.pool.query(
    "insert into settings (id, key, market, scope, scope_id, value) values (gen_random_uuid(), $1, $2, $3, null, $4::jsonb)",
    [
      APPROVAL_SETTING.key,
      APPROVAL_SETTING.market,
      APPROVAL_SETTING.scope,
      JSON.stringify(APPROVAL_UNTIL),
    ],
  );
});
const input = (over: Partial<OperationInput> = {}): OperationInput => ({
  resourceId,
  kind: "reboot",
  payload: {},
  idempotencyKey: "enq:" + uniqueSuffix(),
  ...over,
});
const stateOf = async (id: string) =>
  (await t.pool.query("select state from operations where id = $1", [id])).rows[0].state;

it("enqueueOperation has the two parameters of F and returns only the operation id", async () => {
  expect(enqueueOperation.length).toBe(2);
  const result = await runTransaction(t.db, (tx) => enqueueOperation(tx, input()), {
    role: "web_rw",
  });
  expect(Object.keys(result)).toEqual(["operationId"]);
  expect(await stateOf(result.operationId)).toBe("queued");
});

it("makeEnqueueOperation decides the approval flag with its own clock, to the millisecond", async () => {
  const before = makeEnqueueOperation({ now: () => new Date("2026-12-01T17:59:59.999Z") });
  const after = makeEnqueueOperation({ now: () => new Date("2026-12-01T18:00:00.000Z") });
  const ra = await freshResource();
  const rb = await freshResource();
  const a = await runTransaction(
    t.db,
    (tx) => before(tx, input({ resourceId: ra, kind: "destroy" })),
    { role: "worker_rw" },
  );
  const b = await runTransaction(
    t.db,
    (tx) => after(tx, input({ resourceId: rb, kind: "destroy" })),
    { role: "worker_rw" },
  );
  expect(await stateOf(a.operationId)).toBe("needs_approval");
  expect(await stateOf(b.operationId)).toBe("queued");
});

it("a repeated call with one key returns the same operation id (R7)", async () => {
  const i = input();
  const one = await runTransaction(t.db, (tx) => enqueueOperation(tx, i), { role: "web_rw" });
  const two = await runTransaction(t.db, (tx) => enqueueOperation(tx, i), { role: "web_rw" });
  expect(two).toEqual(one);
});

it("[D21] a caller cannot lower the gate of a destructive kind (needsApproval: false)", async () => {
  const early = makeEnqueueOperation({ now: () => new Date("2026-11-11T10:00:00Z") });
  const r = await runTransaction(
    t.db,
    (tx) => early(tx, input({ kind: "destroy", needsApproval: false })),
    { role: "web_rw" },
  );
  expect(await stateOf(r.operationId)).toBe("needs_approval");
});
