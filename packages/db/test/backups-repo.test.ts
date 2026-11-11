import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { ensureFinalBackup, listBackupsOf, markFinalBackup } from "../repositories/backups";
import { lifecycleRepo } from "../repositories/system/lifecycle";
import { runTransaction } from "../tx";
import { insertRow } from "./sql";
import { newCustomer, newPoolAccount, newResource, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const worker = <T>(fn: (tx: Tx) => Promise<T>) => runTransaction(t.db, fn, { role: "worker_rw" });
let customerId = "";
let otherCustomerId = "";
let parentId = "";

beforeAll(async () => {
  customerId = await newCustomer(t.pool);
  otherCustomerId = await newCustomer(t.pool);
  parentId = await newResource(t.pool, customerId, {
    pool_account_id: await newPoolAccount(t.pool),
    region: "ap-southeast-1",
    state: "active",
  });
});

const newOperation = (kind: string) =>
  insertRow(t.pool, "operations", {
    resource_id: parentId,
    kind,
    state: "running",
    idempotency_key: "b:" + uniqueSuffix(),
  });

describe("ensureFinalBackup", () => {
  it("makes one child backup row per operation and copies the placement of the parent", async () => {
    const operationId = await newOperation("final_snapshot");
    const a = await worker((tx) =>
      ensureFinalBackup(tx, { customerId, parentResourceId: parentId, operationId }),
    );
    const b = await worker((tx) =>
      ensureFinalBackup(tx, { customerId, parentResourceId: parentId, operationId }),
    );
    expect(b).toEqual(a);
    const { rows } = await t.pool.query("select * from resources where id = $1", [a.id]);
    expect(rows[0]).toMatchObject({
      customer_id: customerId,
      family: "backup",
      parent_resource_id: parentId,
      state: "creating",
      region: "ap-southeast-1",
      config: { final: true, finalOperation: operationId },
    });
  });

  it("refuses a parent that is not the customer's (R8, R16)", async () => {
    const operationId = await newOperation("final_snapshot");
    await expect(
      worker((tx) =>
        ensureFinalBackup(tx, {
          customerId: otherCustomerId,
          parentResourceId: parentId,
          operationId,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("markFinalBackup and the lifecycle guard", () => {
  it("counts only after the row is active, and only for the latest final_snapshot operation", async () => {
    const operationId = await newOperation("final_snapshot");
    const { id } = await worker((tx) =>
      ensureFinalBackup(tx, { customerId, parentResourceId: parentId, operationId }),
    );
    const facts = () => worker((tx) => lifecycleRepo(tx).resourceOfOperation(parentId));
    expect((await facts())?.hasFinalSnapshot).toBe(false);
    await worker((tx) =>
      markFinalBackup(tx, { id, customerId, awsName: "tc-snapshot-0123456789abcdef", sizeGb: 40 }),
    );
    expect((await facts())?.hasFinalSnapshot).toBe(true);
    const { rows } = await t.pool.query(
      "select state, aws_name, config from resources where id = $1",
      [id],
    );
    expect(rows[0]).toMatchObject({ state: "active", aws_name: "tc-snapshot-0123456789abcdef" });
    expect(rows[0].config).toMatchObject({ final: true, sizeGb: 40 });
    // A later final_snapshot operation needs a new backup (R13).
    await newOperation("final_snapshot");
    expect((await facts())?.hasFinalSnapshot).toBe(false);
  });

  it("does not mark another customer's row", async () => {
    const operationId = await newOperation("final_snapshot");
    const { id } = await worker((tx) =>
      ensureFinalBackup(tx, { customerId, parentResourceId: parentId, operationId }),
    );
    await expect(
      worker((tx) =>
        markFinalBackup(tx, {
          id,
          customerId: otherCustomerId,
          awsName: "tc-snapshot-aaaaaaaaaaaaaaaa",
          sizeGb: null,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("listBackupsOf", () => {
  it("lists the children that are not destroyed, for the owner only", async () => {
    const own = await worker((tx) => listBackupsOf(tx, { customerId, parentResourceId: parentId }));
    expect(own.length).toBeGreaterThan(0);
    const other = await worker((tx) =>
      listBackupsOf(tx, { customerId: otherCustomerId, parentResourceId: parentId }),
    );
    expect(other).toEqual([]);
  });
});
