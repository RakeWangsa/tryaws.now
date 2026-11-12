import { seedLaunchData } from "@tc/db";
import { useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { asOwner, asRole, clockAt } from "../test/rates-support";
import { staticIpHourPrice } from "./static-ip-price";

// WPU-M2. The price of an unattached static IP hour. Needs the local PostgreSQL (pnpm db:up).
const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";
const KEY = "config_price.static_ip_unattached_hour";

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
});

const setRow = (value: string) =>
  t.pool.query(`update settings set value = $1::jsonb where key = $2 and market = 'BD'`, [
    value,
    KEY,
  ]);

it("USD 0.005 an hour is a price whose base and steps add up to it", async () => {
  const r = await asRole(t, "worker_rw", (tx) => staticIpHourPrice(tx, "BD", clockAt(T0)));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const b = r.value.breakdown;
  expect(b.totalMinor).toBe(r.value.perHourMinor);
  expect(b.steps.reduce((a, s) => a + s.amountMinor, b.baseMinor)).toBe(b.totalMinor);
});

it("a zero price is not a price: nothing is charged (R16)", async () => {
  for (const usd of ["0", "0.0", "0.0000"]) {
    await setRow(`{"usd":"${usd}","unit":"hour"}`);
    const r = await asRole(t, "worker_rw", (tx) => staticIpHourPrice(tx, "BD", clockAt(T0)));
    expect(r).toMatchObject({ ok: false, error: "not_found", fields: { price: "unavailable" } });
  }
});
