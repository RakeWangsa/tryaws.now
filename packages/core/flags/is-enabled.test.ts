import { ensureMarket, insertRow, runTransaction, useBoundTestDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { FEATURE_FLAGS, isEnabled, isEnabledIn } from "./index";

// withTx runs on the temporary database, as web_rw, for the whole file.
const t = useBoundTestDatabase("web_rw");

beforeAll(async () => {
  await ensureMarket(t.pool, "BD");
  await insertRow(t.pool, "feature_flags", { key: "cdn", market: "BD", enabled: true });
});

it("isEnabled(flag, market) of section F is true for the flag that is on and false for every other", async () => {
  expect(await isEnabled("cdn", "BD")).toBe(true);
  for (const flag of FEATURE_FLAGS.filter((f) => f !== "cdn")) {
    expect(await isEnabled(flag, "BD"), flag).toBe(false);
  }
  expect(await isEnabled("cdn", "KE")).toBe(false);
});

it("inside a transaction isEnabled is refused with the nested-transaction error, and isEnabledIn is the form to use", async () => {
  const outcome = await runTransaction(
    t.db,
    async (tx) => {
      const inside = await isEnabledIn(tx, "cdn", "BD");
      const nested = await isEnabled("cdn", "BD").then(
        () => "ran",
        (e: Error) => e.message,
      );
      return { inside, nested };
    },
    { role: "web_rw" },
  );
  expect(outcome).toEqual({
    inside: true,
    nested: "withTx: nested transaction; pass the tx down instead",
  });
});
