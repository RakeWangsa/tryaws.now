import { beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "../client";
import { ensureFinalBackup, listBackupsOf, markFinalBackup } from "../repositories/backups";
import { lifecycleRepo } from "../repositories/system/lifecycle";
import { meteringRepo } from "../repositories/system/metering";
import { runTransaction } from "../tx";
import { insertRow } from "./sql";
import { newCustomer, newPoolAccount, newResource, uniqueSuffix } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
// The generated AWS name of a backup row (R11), as the provisioner writes it.
const awsName = (id: string) => `tc-snapshot-${id.replaceAll("-", "")}`;
// The rule of the lifecycle guard for a customer's delete_backup (packages/core/lifecycle/guard.ts), here as data so
// the db package does not import core: a backup that is not final may be deleted.
const decideDestructive = (kind: string, facts: { family: string; isFinalBackup: boolean }) =>
  kind === "delete_backup" && facts.family === "backup" && !facts.isFinalBackup;
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
      markFinalBackup(tx, {
        id,
        customerId,
        operationId,
        awsName: "tc-snapshot-0123456789abcdef",
        sizeGb: 40,
      }),
    );
    expect((await facts())?.hasFinalSnapshot).toBe(true);
    // WP5-T6: the row itself is flagged as a final backup, the parent is not.
    expect((await facts())?.isFinalBackup).toBe(false);
    expect((await worker((tx) => lifecycleRepo(tx).resourceOfOperation(id)))?.isFinalBackup).toBe(
      true,
    );
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
          operationId,
          awsName: "tc-snapshot-aaaaaaaaaaaaaaaa",
          sizeGb: null,
        }),
      ),
    ).rejects.toThrow();
  });
});

// WPU-X1: a final snapshot that already started when its retention ended (a revival of the server, the unpaid
// payback) finishes as an ordinary backup: `active`, not final, so it is metered like any snapshot and the customer
// may delete it (delete_backup). It is never left `creating` (no AWS snapshot without a row that can delete it) nor
// final (billed and undeletable).
describe("a final snapshot whose retention ended while it ran (WPU-X1)", () => {
  // A parent of its own with a subscription in the given status.
  async function parentWith(status: string): Promise<string> {
    const id = await newResource(t.pool, customerId, {
      pool_account_id: await newPoolAccount(t.pool),
      region: "ap-southeast-1",
      state: "active",
    });
    await insertRow(t.pool, "subscriptions", {
      resource_id: id,
      customer_id: customerId,
      term_days: 30,
      price_snapshot: "{}",
      period_start: "2026-01-01T00:00:00Z",
      period_end: "2026-01-31T00:00:00Z",
      status,
    });
    return id;
  }
  const opOf = (resourceId: string) =>
    insertRow(t.pool, "operations", {
      resource_id: resourceId,
      kind: "final_snapshot",
      state: "running",
      idempotency_key: "x1:" + uniqueSuffix(),
    });
  const rowOf = async (id: string) =>
    (await t.pool.query("select state, aws_name, config from resources where id = $1", [id]))
      .rows[0] as { state: string; aws_name: string | null; config: Record<string, unknown> };
  const deletable = async (id: string) => {
    const facts = await worker((tx) => lifecycleRepo(tx).resourceOfOperation(id));
    return facts !== null && decideDestructive("delete_backup", facts);
  };

  it("a row made before the release, superseded by it, becomes an active, ordinary backup", async () => {
    const parent = await parentWith("retained");
    const operationId = await opOf(parent);
    const { id } = await worker((tx) =>
      ensureFinalBackup(tx, { customerId, parentResourceId: parent, operationId }),
    );
    expect((await rowOf(id)).config).toMatchObject({ final: true });
    // The release (completeRestore, releaseServerDisks, the unpaid payback): the subscription is active again
    // and the final backups of the parent stop being final.
    await t.pool.query("update subscriptions set status = 'active' where resource_id = $1", [
      parent,
    ]);
    await worker((tx) => meteringRepo(tx).supersedeFinalBackups(parent));
    await worker((tx) =>
      markFinalBackup(tx, { id, customerId, operationId, awsName: awsName(id), sizeGb: 32 }),
    );
    const row = await rowOf(id);
    expect(row.state).toBe("active");
    expect(row.aws_name).toBe(awsName(id));
    expect(row.config).toMatchObject({ final: false, finalOperation: operationId, sizeGb: 32 });
    expect(await deletable(id)).toBe(true);
    // It does not count as the final snapshot of a later retention either (R13).
    expect(
      (await worker((tx) => lifecycleRepo(tx).resourceOfOperation(parent)))?.hasFinalSnapshot,
    ).toBe(false);
  });

  it.each(["active", "grace"])(
    "a row made after the release (subscription %s) is not final from the start",
    async (status) => {
      const parent = await parentWith(status);
      const operationId = await opOf(parent);
      const { id } = await worker((tx) =>
        ensureFinalBackup(tx, { customerId, parentResourceId: parent, operationId }),
      );
      expect((await rowOf(id)).config).toMatchObject({ final: false, finalOperation: operationId });
      await worker((tx) =>
        markFinalBackup(tx, { id, customerId, operationId, awsName: awsName(id), sizeGb: 20 }),
      );
      const row = await rowOf(id);
      expect(row.state).toBe("active");
      expect(row.config).toMatchObject({ final: false, sizeGb: 20 });
      expect(await deletable(id)).toBe(true);
    },
  );

  it("a row made while the subscription is retained stays final (R13 unchanged)", async () => {
    const parent = await parentWith("retained");
    const operationId = await opOf(parent);
    const { id } = await worker((tx) =>
      ensureFinalBackup(tx, { customerId, parentResourceId: parent, operationId }),
    );
    await worker((tx) =>
      markFinalBackup(tx, { id, customerId, operationId, awsName: awsName(id), sizeGb: 20 }),
    );
    expect((await rowOf(id)).config).toMatchObject({ final: true });
    expect(await deletable(id)).toBe(false);
    expect(
      (await worker((tx) => lifecycleRepo(tx).resourceOfOperation(parent)))?.hasFinalSnapshot,
    ).toBe(true);
  });

  it("marks only the row of the same final_snapshot operation, never another backup (R16)", async () => {
    const parent = await parentWith("retained");
    const operationId = await opOf(parent);
    const other = await opOf(parent);
    const { id } = await worker((tx) =>
      ensureFinalBackup(tx, { customerId, parentResourceId: parent, operationId }),
    );
    await expect(
      worker((tx) =>
        markFinalBackup(tx, {
          id,
          customerId,
          operationId: other,
          awsName: awsName(id),
          sizeGb: 1,
        }),
      ),
    ).rejects.toThrow();
    // A manual backup (no finalOperation) is never marked by this path.
    const manual = await insertRow(t.pool, "resources", {
      customer_id: customerId,
      family: "backup",
      parent_resource_id: parent,
      state: "creating",
      config: JSON.stringify({ final: false }),
    });
    await expect(
      worker((tx) =>
        markFinalBackup(tx, {
          id: manual,
          customerId,
          operationId,
          awsName: awsName(manual),
          sizeGb: 1,
        }),
      ),
    ).rejects.toThrow();
    expect((await rowOf(manual)).state).toBe("creating");
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
