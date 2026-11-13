import { LAUNCH_PRICING_STEPS, seedLaunchData } from "@tc/db";
import { ensureMarket, insertRow, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { validateRule } from "../pricing/index";
import { pricingInForce, quoteInForce } from "./index";
import { asOwner, asRole, clockAt } from "../test/rates-support";

const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";
const price = (family: string | null, clock: string, over: Record<string, unknown> = {}) =>
  asRole(t, "web_rw", (tx) =>
    quoteInForce(
      tx,
      { market: "BD", productFamily: family, awsPriceUsd: "5", ...over },
      clockAt(clock),
    ),
  );
const totalOf = async (family: string | null, clock: string) => {
  const r = await price(family, clock);
  if (!r.ok) throw new Error("refused: " + JSON.stringify(r));
  return r.value.quote.totalMinor;
};

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
  // a rule of the family linux_instance with a service charge of 3 percent, from 15 November
  const withMarkup = LAUNCH_PRICING_STEPS.map((s) =>
    s.code === "markup" ? { ...s, rate: "0.03" } : s,
  );
  await insertRow(t.pool, "pricing_rules", {
    market: "BD",
    product_family: "linux_instance",
    steps: JSON.stringify(withMarkup),
    effective_from: "2026-11-15T00:00:00Z",
  });
  // WPU-Y1: the same rate again from 15 November, as an admin re-confirms it (a rate older than 7 days prices nothing)
  await insertRow(t.pool, "fx_rates", {
    market: "BD",
    rate: "127",
    effective_from: "2026-11-15T00:00:00Z",
  });
  // a new rate from 20 November
  await insertRow(t.pool, "fx_rates", {
    market: "BD",
    rate: "130",
    effective_from: "2026-11-20T00:00:00Z",
  });
  await ensureMarket(t.pool, "KE");
});

it("the rule that the seed stores is a valid rule of the engine", () => {
  expect(validateRule({ version: "seed", steps: LAUNCH_PRICING_STEPS })).toEqual([]);
});

it("the staging seed prices the 5 USD plan at 74295 and builds the snapshot that an order stores", async () => {
  const r = await price("windows_instance", T0);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const { quote, snapshot, inForce } = r.value;
  expect(quote.totalMinor).toBe(74295n);
  expect(quote.ruleVersion).toBe(inForce.rule.id);
  expect(inForce.pricedAt).toEqual(new Date(T0));
  expect(inForce.rule.productFamily).toBeNull();
  expect(snapshot).toEqual({
    v: 1,
    currency: "BDT",
    pricedAt: T0,
    awsPriceUsd: "5",
    quantity: "1",
    fxRate: "127",
    ruleVersion: inForce.rule.id,
    baseMinor: "63500",
    steps: [
      { code: "korea_vat", amountMinor: "6350", rate: "0.10" },
      { code: "bd_vat", amountMinor: "3175", rate: "0.05" },
      { code: "processing_fee", amountMinor: "1270", rate: "0.02" },
      { code: "markup", amountMinor: "0", rate: "0" },
    ],
    totalMinor: "74295",
  });
});

it("a family rule takes over from its start; another family keeps the market rule", async () => {
  expect(await totalOf("linux_instance", "2026-11-14T23:59:59.999Z")).toBe(74295n);
  expect(await totalOf("linux_instance", "2026-11-15T00:00:00.000Z")).toBe(76200n); // 63500 + 6350 + 3175 + 1270 + 1905
  expect(await totalOf("windows_instance", "2026-11-16T00:00:00.000Z")).toBe(74295n);
  const r = await asRole(t, "web_rw", (tx) =>
    pricingInForce(
      tx,
      { market: "BD", productFamily: "linux_instance" },
      clockAt("2026-11-16T00:00:00Z"),
    ),
  );
  expect(r.ok && r.value.rule.productFamily).toBe("linux_instance");
});

it("a new rate takes over exactly at its start, for every family", async () => {
  expect(await totalOf("windows_instance", "2026-11-19T23:59:59.999Z")).toBe(74295n);
  expect(await totalOf("windows_instance", "2026-11-20T00:00:00.000Z")).toBe(76050n); // 65000 + 6500 + 3250 + 1300
  expect(await totalOf("linux_instance", "2026-11-20T00:00:00.000Z")).toBe(78000n); // 65000 + 6500 + 3250 + 1300 + 1950
  const r = await price("windows_instance", "2026-11-20T00:00:00.000Z");
  expect(r.ok && r.value.quote.fxRate).toBe("130");
});

it("the clock is read once, so the rate and the rule are those of one instant", async () => {
  let reads = 0;
  const counting = {
    now: () => {
      reads++;
      return new Date(T0);
    },
  };
  await asRole(t, "web_rw", (tx) =>
    quoteInForce(tx, { market: "BD", productFamily: null, awsPriceUsd: "5" }, counting),
  );
  expect(reads).toBe(1);
});

it.each(["web_rw", "admin_rw", "worker_rw"] as const)(
  "%s can price (renewals run as worker_rw)",
  async (role) => {
    const r = await asRole(t, role, (tx) =>
      quoteInForce(tx, { market: "BD", productFamily: null, awsPriceUsd: "5" }, clockAt(T0)),
    );
    expect(r.ok && r.value.quote.totalMinor).toBe(74295n);
  },
);

it("with no rate in force nothing is priced: before the first row, in a market without rows", async () => {
  const refused = {
    ok: false,
    error: "upstream_unavailable",
    fields: { fxRate: "missing" },
    data: { code: "prices_updating" },
  };
  expect(await price(null, "2026-11-01T00:00:00Z")).toEqual(refused);
  const ke = await asRole(t, "web_rw", (tx) =>
    quoteInForce(tx, { market: "KE", productFamily: null, awsPriceUsd: "5" }, clockAt(T0)),
  );
  expect(ke).toEqual(refused);
});

it("with a rate but no rule, and with a stored rule that fails the engine, nothing is priced either", async () => {
  await insertRow(t.pool, "fx_rates", {
    market: "KE",
    rate: "1.25",
    effective_from: "2026-11-10T00:00:00Z",
  });
  const ke = () =>
    asRole(t, "web_rw", (tx) =>
      quoteInForce(tx, { market: "KE", productFamily: null, awsPriceUsd: "5" }, clockAt(T0)),
    );
  expect(await ke()).toEqual({ ok: false, error: "not_found", fields: { rule: "not_in_force" } });
  const handling = { code: "handling", rate: "0.01", base: "aws", label: { bn: "ক", en: "a" } };
  await insertRow(t.pool, "pricing_rules", {
    market: "KE",
    steps: JSON.stringify([handling]),
    effective_from: "2026-11-10T00:00:00Z",
  });
  expect(await ke()).toEqual({
    ok: false,
    error: "internal",
    fields: { rule: "stored_rule_invalid" },
  });
});

it("a bad market, family, price or quantity is a validation failure that names the field", async () => {
  const fieldsOf = async (over: Record<string, unknown>) => {
    const r = await price(null, T0, over);
    return r.ok ? null : Object.keys(r.fields ?? {});
  };
  expect(await fieldsOf({ market: "bd" })).toEqual(["market"]);
  expect(await fieldsOf({ productFamily: "toaster" })).toEqual(["productFamily"]);
  expect(await fieldsOf({ awsPriceUsd: "abc" })).toEqual(["awsPriceUsd"]);
  expect(await fieldsOf({ quantity: "-1" })).toEqual(["quantity"]);
});

it("WPU-Y1: a rate is fresh for exactly 7 days and refuses one millisecond later (the rate of 15 November)", async () => {
  expect((await price(null, "2026-11-22T00:00:00.000Z")).ok).toBe(true);
  // the rate of 20 November is in force from then; the one of 15 November is the last before it
  const refused = {
    ok: false,
    error: "upstream_unavailable",
    fields: { fxRate: "stale" },
    data: { code: "prices_updating" },
  };
  // the seed rate (11 November 06:00) is the one in force until 15 November 00:00: 4.75 days old at 15 Nov
  expect((await price(null, "2026-11-14T23:59:59.999Z")).ok).toBe(true);
  // after the rate of 20 November: 7 days later is 27 November 00:00
  expect((await price(null, "2026-11-27T00:00:00.000Z")).ok).toBe(true);
  expect(await price(null, "2026-11-27T00:00:00.001Z")).toEqual(refused);
  expect(await price(null, "2027-01-01T00:00:00.000Z")).toEqual(refused);
});

it("WPU-Y1: an admin preview may still read a stale rate; a sale never does", async () => {
  const stale = "2027-01-01T00:00:00.000Z";
  const viaSale = await asRole(t, "web_rw", (tx) =>
    pricingInForce(tx, { market: "BD", productFamily: null }, clockAt(stale)),
  );
  expect(viaSale.ok).toBe(false);
  const viaPreview = await asRole(t, "web_rw", (tx) =>
    pricingInForce(tx, { market: "BD", productFamily: null }, clockAt(stale), { allowStale: true }),
  );
  expect(viaPreview.ok).toBe(true);
});
