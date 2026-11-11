import { expect, it } from "vitest";
import { readAdminApprover } from "../repositories/admin/approver";
import { runTransaction } from "../tx";
import { newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const read = (id: string) =>
  runTransaction(t.db, (tx) => readAdminApprover(tx, id), { role: "admin_rw" });

it("reads the id, the role and the status of an admin, and nothing else", async () => {
  const id = await newAdmin(t.pool, "superadmin");
  expect(await read(id)).toEqual({ id, role: "superadmin", status: "active" });
});

it("a disabled admin is read as disabled", async () => {
  const id = await newAdmin(t.pool, "finance");
  await t.pool.query("update admin_users set status = 'disabled' where id = $1", [id]);
  expect(await read(id)).toMatchObject({ role: "finance", status: "disabled" });
});

it("an id that names no admin, or is not an id, gives null", async () => {
  expect(await read("01900000-0000-7000-8000-000000000000")).toBeNull();
  for (const id of ["", "x", "x'; drop table admin_users; --"])
    expect(await read(id), id).toBeNull();
});
