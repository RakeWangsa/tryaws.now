import { seedLaunchData } from "@tc/db";
import { useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { asOwner, asRole, clockAt } from "../test/rates-support";
import { CONFIG_PRICE_FAMILY, previewConfigPrice } from "./index";

// WPU-G10: the live preview of a config price (load balancer, snapshot, block storage, hosted zone). It
// prices one unit with the engine (the function that prices an order) under the price in force and under
// the candidate, with the rate and the rule of the same instant, and writes nothing.
const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";
const preview = (input: Record<string, unknown>) =>
  asRole(t, "admin_rw", (tx) =>
    previewConfigPrice(
      tx,
      { market: "BD", key: "config_price.dns_zone_month", usd: "0.50", ...input } as never,
      clockAt(T0),
    ),
  );

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
});

it("names the product family each config price belongs to, for the rule and the margin", () => {
  expect(CONFIG_PRICE_FAMILY).toEqual({
    "config_price.block_storage_gb_month": "disk",
    "config_price.snapshot_gb_month": "backup",
    "config_price.load_balancer_month": "load_balancer",
    "config_price.dns_zone_month": "dns_zone",
    "config_price.static_ip_unattached_hour": "static_ip",
  });
});

it("prices the candidate with the engine: USD 0.50 at FX 127 is 6350 paisa of base cost before the rule", async () => {
  const r = await preview({});
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.fxRate).toBe("127");
  expect(r.value.candidate.baseMinor).toBe(6350n);
  // no price stored yet: there is no current figure to compare
  expect(r.value.current).toBeNull();
  expect(r.value.deltaMinor).toBeNull();
});

it("with a price in force the preview shows both and the change", async () => {
  const r = await preview({ current: "0.25" });
  if (!r.ok) throw new Error("refused");
  expect(r.value.current?.baseMinor).toBe(3175n);
  expect(r.value.candidate.baseMinor).toBe(6350n);
  expect(r.value.deltaMinor).toBe(
    r.value.candidate.totalMinor - (r.value.current?.totalMinor ?? 0n),
  );
});

it("refuses a key that is no config price and a price that is not plain decimal text, and prices nothing", async () => {
  expect(await preview({ key: "config_price.other" })).toMatchObject({
    ok: false,
    error: "validation",
  });
  for (const usd of ["", "0", "-1", "1e2", "1.23456", "abc"]) {
    expect(await preview({ usd }), usd).toMatchObject({ ok: false, error: "validation" });
  }
});

it("with no rate in force nothing is priced (R16)", async () => {
  const r = await asRole(t, "admin_rw", (tx) =>
    previewConfigPrice(
      tx,
      { market: "BD", key: "config_price.dns_zone_month", usd: "0.50" },
      clockAt("2000-01-01T00:00:00.000Z"),
    ),
  );
  expect(r).toMatchObject({ ok: false, error: "not_found" });
});
