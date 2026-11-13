import { seedLaunchData } from "@tc/db";
import { insertRow, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { isBookTerms, quote, quoteWithBook, validateBookTerms } from "../pricing/index";
import { asOwner, asRole, clockAt } from "../test/rates-support";
import { pricingInForce, quoteInForce } from "./index";

// WPA-P1: the margin and the commission of the price book reach the price of a NEW order through
// quoteInForce, from their start; an order that was priced before keeps its snapshot.
const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";
const START = "2026-11-12T00:00:00.000Z"; // the first entry of the book, a day after the rate and the rule
const THE_20TH = "2026-11-20T00:00:00.000Z";
const BY = "0191e8a0-0000-7000-8000-000000000001";

const book = (entries: unknown[]) =>
  JSON.stringify({ v: 1, entries: entries.map((e) => ({ by: BY, ...(e as object) })) });
const store = (family: string, value: string) =>
  insertRow(t.pool, "settings", {
    key: `price_book.${family}`,
    market: "BD",
    scope: "market",
    value,
  });
const price = (family: string, clock: string, over: Record<string, unknown> = {}) =>
  asRole(t, "web_rw", (tx) =>
    quoteInForce(
      tx,
      { market: "BD", productFamily: family, awsPriceUsd: "5", ...over },
      clockAt(clock),
    ),
  );

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
  // WPU-Y9: a rate older than 7 days (from its entry) prices nothing. The test prices up to the 20th, so the same
  // launch rate is entered again on the 19th, as an admin does every week.
  await t.pool.query(
    `insert into fx_rates (id, market, rate, effective_from, created_at)
     select gen_random_uuid(), 'BD', rate, '2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z'
     from fx_rates where market = 'BD' order by effective_from desc limit 1`,
  );
  await store(
    "linux_instance",
    book([
      {
        from: START,
        margin: { kind: "percent", value: "0.10" },
        commission: { kind: "percent", value: "0.2" },
      },
      { from: THE_20TH, margin: { kind: "fixed", value: "500" }, commission: null },
    ]),
  );
  await store("backup", JSON.stringify({ v: 1, entries: [{ from: "nonsense" }] }));
});

it("a family with a book is priced with its margin; the rule of section 8 alone gives 74295", async () => {
  const r = await price("linux_instance", START);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.quote.totalMinor).toBe(74295n + 6350n);
  expect(r.value.marginMinor).toBe(6350n);
  expect(r.value.commissionMinor).toBe(1270n);
  expect(r.value.quote.steps.find((s) => s.code === "markup")?.amountMinor).toBe(6350n);
  expect(r.value.snapshot.totalMinor).toBe("80645");
  expect(r.value.inForce.book).toEqual({
    margin: { kind: "percent", value: "0.10" },
    commission: { kind: "percent", value: "0.2" },
  });
});

it("is the engine: the same inputs through quoteWithBook give the same quote", async () => {
  const r = await price("linux_instance", START);
  if (!r.ok) throw new Error("refused");
  const direct = quoteWithBook(
    {
      awsPriceUsd: "5",
      fxRate: r.value.inForce.fx.rate,
      rule: r.value.inForce.rule.value,
    },
    r.value.inForce.book,
  );
  expect(r.value.quote).toEqual(direct.quote);
});

it("a scheduled entry takes over at its start and not a moment before", async () => {
  const before = await price("linux_instance", "2026-11-19T23:59:59.999Z");
  const after = await price("linux_instance", THE_20TH);
  if (!before.ok || !after.ok) throw new Error("refused");
  expect(before.value.marginMinor).toBe(6350n);
  expect(after.value.marginMinor).toBe(500n);
  expect(after.value.quote.totalMinor).toBe(74295n + 500n);
  expect(after.value.commissionMinor).toBe(0n);
});

it("before the first entry, and for a family with no book, the rule alone prices", async () => {
  const early = await price("linux_instance", T0);
  const other = await price("windows_instance", START);
  if (!early.ok || !other.ok) throw new Error("refused");
  expect(early.value.quote.totalMinor).toBe(74295n);
  expect(early.value.inForce.book).toBeNull();
  expect(other.value.quote.totalMinor).toBe(74295n);
  expect(other.value.marginMinor).toBe(0n);
});

it("an order priced earlier keeps its snapshot: the snapshot is data, a later change cannot reach it", async () => {
  const placed = await price("linux_instance", START);
  if (!placed.ok) throw new Error("refused");
  const frozen = JSON.stringify(placed.value.snapshot);
  const later = await price("linux_instance", THE_20TH);
  if (!later.ok) throw new Error("refused");
  expect(later.value.snapshot.totalMinor).not.toBe(placed.value.snapshot.totalMinor);
  expect(JSON.stringify(placed.value.snapshot)).toBe(frozen);
  expect(placed.value.snapshot.totalMinor).toBe("80645");
});

it("a stored book that does not parse prices nothing (R16)", async () => {
  const r = await price("backup", T0);
  expect(r).toEqual({ ok: false, error: "internal", fields: { book: "stored_book_invalid" } });
  const found = await asRole(t, "web_rw", (tx) =>
    pricingInForce(tx, { market: "BD", productFamily: "backup" }, clockAt(T0)),
  );
  expect(found.ok).toBe(false);
});

it("the market rule scope (no family) has no book", async () => {
  const found = await asRole(t, "web_rw", (tx) =>
    pricingInForce(tx, { market: "BD", productFamily: null }, clockAt(T0)),
  );
  expect(found.ok && found.value.book).toBeNull();
});

it("the quote without terms is quote() of the engine, for a rule without a markup step too", () => {
  const rule = {
    version: "x",
    steps: [{ code: "korea_vat", rate: "0.1", base: "aws" as const, label: { bn: "ক", en: "a" } }],
  };
  const input = { awsPriceUsd: "5", fxRate: "127", rule };
  expect(quoteWithBook(input, null).quote).toEqual(quote(input));
});

// @tc/db cannot import the engine, so its check of a stored amount is a copy of validateBookTerms of
// the engine. This pins them together: they agree on every value below.
it("the check of a stored book in @tc/db agrees with validateBookTerms of the engine", async () => {
  const { isPriceBookCommission, isPriceBookMargin } = await import("@tc/db");
  const amounts: unknown[] = [
    { kind: "percent", value: "0" },
    { kind: "percent", value: "5" },
    { kind: "percent", value: "5.0000" },
    { kind: "percent", value: "5.0001" },
    { kind: "percent", value: "1" },
    { kind: "percent", value: "1.0001" },
    { kind: "percent", value: "0.1234" },
    { kind: "percent", value: "0.12345" },
    { kind: "percent", value: "10" },
    { kind: "percent", value: "-1" },
    { kind: "percent", value: "1e-1" },
    { kind: "percent", value: ".5" },
    { kind: "percent", value: 0.5 },
    { kind: "fixed", value: "0" },
    { kind: "fixed", value: "05" },
    { kind: "fixed", value: "999999999" },
    { kind: "fixed", value: "1000000000" },
    { kind: "fixed", value: "1.5" },
    { kind: "other", value: "1" },
    null,
    "5",
    [],
  ];
  for (const a of amounts) {
    expect(isPriceBookMargin(a), `margin ${JSON.stringify(a)}`).toBe(
      isBookTerms({ margin: a, commission: null }),
    );
    expect(isPriceBookCommission(a), `commission ${JSON.stringify(a)}`).toBe(
      a !== null && isBookTerms({ margin: { kind: "fixed", value: "0" }, commission: a }),
    );
  }
  expect(validateBookTerms({ margin: { kind: "fixed", value: "0" }, commission: null })).toEqual(
    [],
  );
});
