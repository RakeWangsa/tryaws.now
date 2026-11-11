import {
  insertRow,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { expect, it } from "vitest";
import { transitionOperation } from "./transition";

const t = useTempDatabase();

it("an illegal pair throws before any statement, even for a pair the database would allow", async () => {
  await expect(
    transitionOperation(undefined as never, "worker", {
      id: "x",
      from: "succeeded",
      to: "queued",
    }),
  ).rejects.toThrow("operation: illegal transition succeeded -> queued by worker");
  await expect(
    transitionOperation(undefined as never, "worker", {
      id: "x",
      from: "needs_attention",
      to: "queued",
    }),
  ).rejects.toThrow("by worker");
});

it("a legal pair updates the row", async () => {
  const resource = await newResource(t.pool, await newCustomer(t.pool));
  const id = await insertRow(t.pool, "operations", {
    resource_id: resource,
    kind: "reboot",
    state: "queued",
    idempotency_key: "t:" + uniqueSuffix(),
  });
  const result = await runTransaction(
    t.db,
    (tx) =>
      transitionOperation(tx, "worker", {
        id,
        from: "queued",
        to: "running",
        nextRunAt: new Date("2030-01-01T00:02:00Z"),
      }),
    { role: "worker_rw" },
  );
  expect(result).toEqual({ applied: true, enqueueSeq: 0 });
});
