// WPU-Y1 (written without a database in the sandbox: it needs PostgreSQL, see JOURNEY). A rate has a maximum age, so an
// admin must be able to confirm the SAME rate again: that writes a new row and restarts its age. Also the read of who
// saved the rate in force and when.
import { beforeAll, expect, it } from "vitest";
import { adminRepos, type AdminActor, type AdminRepos } from "../repositories/admin/index";
import { runTransaction, type DatabaseRole } from "../tx";
import { ensureMarket, newAdmin } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const T0 = new Date("2026-11-11T06:00:00.000Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

let actor: AdminActor;
let second: string;
beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  actor = {
    adminId: await newAdmin(t.pool, "finance"),
    role: "finance",
    ip: "203.0.113.9",
    userAgent: "test",
  };
  second = await newAdmin(t.pool, "superadmin");
});
const as = <T>(fn: (r: AdminRepos) => Promise<T>, role: DatabaseRole = "admin_rw") =>
  runTransaction(t.db, (tx) => fn(adminRepos(tx, actor)), { role });
const count = async () =>
  (await t.pool.query("select count(*)::int as n from fx_rates")).rows[0].n as number;

it("the first rate; the same rate saved again to start now is a replay unless it is a re-confirm", async () => {
  await as((r) =>
    r.fxRates.set({ market: "BD", rate: "127", effectiveFrom: T0, at: T0 }, "launch rate"),
  );
  expect(await count()).toBe(1);
  const at = day(3);
  expect(
    await as((r) => r.fxRates.set({ market: "BD", rate: "127", effectiveFrom: at, at }, "again")),
  ).toMatchObject({ ok: true, replayed: true });
  expect(await count()).toBe(1);
});

it("a re-confirm adds a row that starts at the call, restarts the age, and repeats as a replay", async () => {
  const at = day(3);
  const input = { market: "BD", rate: "127", effectiveFrom: at, at, approvedBy: second };
  const confirmed = await as((r) => r.fxRates.set({ ...input, reconfirm: true }, "re-confirmed"));
  expect(confirmed).toMatchObject({ ok: true, replayed: false, value: { rate: "127" } });
  expect(await count()).toBe(2);
  const meta = await as((r) => r.fxRates.meta("BD", at));
  expect(meta).toMatchObject({ setBy: actor.adminId });
  expect(
    await as((r) => r.fxRates.set({ ...input, reconfirm: true }, "re-confirmed")),
  ).toMatchObject({
    ok: true,
    replayed: true,
  });
  expect(await count()).toBe(2);
});

it("meta is null before the first rate and for a market code that is not valid, and web_rw may not read it", async () => {
  expect(await as((r) => r.fxRates.meta("BD", new Date("2020-01-01T00:00:00Z")))).toBeNull();
  expect(await as((r) => r.fxRates.meta("bd", day(3)))).toBeNull();
  await expect(as((r) => r.fxRates.meta("BD", day(3)), "web_rw")).rejects.toMatchObject({
    code: "42501",
  });
});
