import type { AdminActor, Tx } from "@tc/db";
import { auditRowsOf, ensureMarket, useTempDatabase } from "@tc/db/testing";
import { expect, it } from "vitest";
import { adminActor } from "../test/admin-support";
import { asRole } from "../test/rates-support";
import {
  FEATURE_FLAGS,
  isEnabledIn,
  isFeatureFlag,
  listFeatureFlags,
  setFeatureFlag,
  type FeatureFlag,
  type SetFeatureFlagInput,
} from "./index";

const t = useTempDatabase();
let actor: AdminActor;
const set = (input: Partial<SetFeatureFlagInput>, as: AdminActor = actor) =>
  asRole(t, "admin_rw", (tx) =>
    setFeatureFlag(tx, as, {
      key: "linux_instance",
      market: "BD",
      enabled: true,
      reason: "launch",
      ...input,
    }),
  );
const on = (flag: FeatureFlag, market = "BD") =>
  asRole(t, "web_rw", (tx) => isEnabledIn(tx, flag, market));

// The first test of the file: no row exists yet, so this is the state of a database that was only migrated (R12).
it("every flag is off by default: no row, no flag on, in the check and in the list", async () => {
  for (const flag of FEATURE_FLAGS) expect(await on(flag), flag).toBe(false);
  const list = await asRole(t, "web_rw", (tx) => listFeatureFlags(tx, "BD"));
  expect(list).toHaveLength(12);
  expect(list.map((f) => f.key)).toEqual([...FEATURE_FLAGS]);
  expect(list.filter((f) => f.enabled)).toEqual([]);
});

it("a key that is no flag is off without a query", async () => {
  expect(await isEnabledIn({} as Tx, "toaster" as FeatureFlag, "BD")).toBe(false);
  expect(isFeatureFlag("cdn")).toBe(true);
  expect(isFeatureFlag("toaster")).toBe(false);
  expect(FEATURE_FLAGS).toHaveLength(12);
});

it("an ops admin switches a flag on; the check and the list follow; the audit row has the change", async () => {
  await ensureMarket(t.pool, "BD");
  actor = await adminActor(t, "ops");
  const r = await set({ reason: "Linux servers pass the M3 cycle" });
  expect(r).toEqual({
    ok: true,
    value: { key: "linux_instance", market: "BD", enabled: true, replayed: false },
  });
  expect(await on("linux_instance")).toBe(true);
  expect(await on("cdn")).toBe(false);
  const list = await asRole(t, "web_rw", (tx) => listFeatureFlags(tx, "BD"));
  expect(list.filter((f) => f.enabled).map((f) => f.key)).toEqual(["linux_instance"]);
  expect(await auditRowsOf(t.pool, actor.adminId)).toMatchObject([
    {
      action: "feature_flag.set",
      target_type: "feature_flag",
      target_id: "BD:linux_instance",
      metadata: {
        reason: "Linux servers pass the M3 cycle",
        before: null,
        after: { enabled: true },
      },
    },
  ]);
});

it("the same value again is a replay, and a flag can be switched off again", async () => {
  expect(await set({})).toMatchObject({ ok: true, value: { enabled: true, replayed: true } });
  expect(await set({ enabled: false })).toMatchObject({
    ok: true,
    value: { enabled: false, replayed: false },
  });
  expect(await on("linux_instance")).toBe(false);
});

it("a flag of one market does not switch on another market", async () => {
  await ensureMarket(t.pool, "KE");
  expect(await set({ market: "KE" })).toMatchObject({ ok: true });
  expect(await on("linux_instance", "KE")).toBe(true);
  expect(await on("linux_instance", "BD")).toBe(false);
});

it.each([
  ["a key that is no product family", { key: "toaster" }, { key: "unknown" }],
  ["a market in lower case", { market: "bd" }, { market: "invalid" }],
  ["a market that does not exist", { market: "ZZ" }, { market: "unknown" }],
  ["a blank reason", { reason: " " }, { reason: "required" }],
  ["a value that is no boolean", { enabled: "yes" as unknown as boolean }, { enabled: "invalid" }],
])(
  "%s is a validation failure that names the field, and nothing is written",
  async (_, over, fields) => {
    const before = (await auditRowsOf(t.pool, actor.adminId)).length;
    expect(await set(over)).toEqual({ ok: false, error: "validation", fields });
    expect((await auditRowsOf(t.pool, actor.adminId)).length).toBe(before);
  },
);

it("worker_rw has no grant on feature_flags: the check fails with a DbError and never answers true (R16)", async () => {
  await expect(
    asRole(t, "worker_rw", (tx) => isEnabledIn(tx, "linux_instance", "KE")),
  ).rejects.toMatchObject({ name: "DbError", code: "42501" });
});

it("web_rw cannot switch a flag: the database refuses with 42501", async () => {
  await expect(
    asRole(t, "web_rw", (tx) =>
      setFeatureFlag(tx, actor, { key: "cdn", market: "BD", enabled: true, reason: "x" }),
    ),
  ).rejects.toMatchObject({ name: "DbError", code: "42501" });
});
