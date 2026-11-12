import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newResource } from "./fixtures";
import { useTempDatabase } from "./temp-db";

// WPU-G9: a manual snapshot of a database is a child `backup` row like the one of a server or a disk.
const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);

it("createBackupRow works under the customer's own database and not under another family or customer", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const database = await newResource(t.pool, a, { family: "database", state: "active" });
  const lb = await newResource(t.pool, a, { family: "load_balancer", state: "active" });
  const id = uuidv7();
  const first = await as(a, (r) =>
    r.resources.createBackupRow({ id, parentId: database, displayName: "before migration" }),
  );
  expect(first).toMatchObject({
    ok: true,
    replayed: false,
    value: { id, family: "backup", state: "creating", parentResourceId: database },
  });
  expect(await as(a, (r) => r.resources.listChildren(database, "backup"))).toHaveLength(1);
  // Another customer neither creates under it nor lists it.
  expect(
    await as(b, (r) =>
      r.resources.createBackupRow({ id: uuidv7(), parentId: database, displayName: "x" }),
    ),
  ).toEqual({ ok: false, error: "not_found" });
  expect(await as(b, (r) => r.resources.listChildren(database, "backup"))).toEqual([]);
  // A load balancer has no snapshot.
  expect(
    await as(a, (r) =>
      r.resources.createBackupRow({ id: uuidv7(), parentId: lb, displayName: "x" }),
    ),
  ).toEqual({ ok: false, error: "not_found" });
});
