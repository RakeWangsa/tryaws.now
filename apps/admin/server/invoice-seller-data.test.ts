import { parseSellerDetails } from "@tc/core";
import { parseSellerFields } from "@tc/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-I1: the loader of /pricing/seller. A refusal or a failing database is a fixed "unavailable", never
// an empty screen and never the text of an error (R14, R16). Also: the seller rules of @tc/db (which
// cannot import @tc/core) and of @tc/core give the same answer for every case below.
const world = vi.hoisted(() => ({
  seller: { ok: true, value: { state: "none" } } as unknown,
  audit: { ok: true, value: { rows: [] as unknown[] } } as unknown,
  readThrows: false,
  backlog: { ok: true, value: { count: 0, oldest: null } } as unknown,
}));
vi.mock("./pricing-runtime.ts", () => ({
  readTx: async (fn: (tx: unknown) => unknown) => {
    if (world.readThrows) throw new Error("database down: secret detail");
    return fn({});
  },
}));
vi.mock("@tc/db", async (importActual) => ({
  ...(await importActual<typeof import("@tc/db")>()),
  adminRepos: () => ({
    invoiceSeller: { read: async () => world.seller, backlog: async () => world.backlog },
    audit: { search: async () => world.audit },
  }),
  readMarkets: async () => [{ code: "BD" }, { code: "KE" }],
}));

const { loadInvoiceSeller } = await import("./invoice-seller-data.ts");
const ADMIN = {
  adminId: "0191a000-0000-7000-8000-0000000000ad",
  role: "finance",
  ip: "203.0.113.7",
} as never;
const SELLER = {
  legalNameBn: "ক",
  legalNameEn: "A",
  bin: "0000000000000",
  addressBn: "ক",
  addressEn: "A",
  signatoryName: "A",
  signatoryDesignation: "A",
};

beforeEach(() => {
  world.readThrows = false;
  world.backlog = { ok: true, value: { count: 0, oldest: null } };
  world.seller = { ok: true, value: { state: "none" } };
  world.audit = { ok: true, value: { rows: [] } };
});

describe("loadInvoiceSeller", () => {
  it("no row is missing: no seller, no version", async () => {
    expect(await loadInvoiceSeller(ADMIN, {})).toMatchObject({
      kind: "ok",
      value: { market: "BD", state: "missing", seller: null, version: null, history: [] },
    });
  });
  it("WPU-I2: carries the count of invoices that wait for the seller details; a refused count is unavailable (R16)", async () => {
    const oldest = new Date("2026-11-12T01:00:00Z");
    world.backlog = { ok: true, value: { count: 4, oldest } };
    expect(await loadInvoiceSeller(ADMIN, {})).toMatchObject({
      kind: "ok",
      value: { backlog: { count: 4, oldest } },
    });
    world.backlog = { ok: false, error: "forbidden" };
    expect(await loadInvoiceSeller(ADMIN, {})).toEqual({ kind: "unavailable" });
  });
  it("an unreadable row is invalid", async () => {
    world.seller = { ok: true, value: { state: "invalid" } };
    expect(await loadInvoiceSeller(ADMIN, {})).toMatchObject({
      kind: "ok",
      value: { state: "invalid", seller: null },
    });
  });
  it("a saved row is ready, with its version and the names of the fields each save changed", async () => {
    world.seller = { ok: true, value: { state: "ok", seller: SELLER, version: 3 } };
    world.audit = {
      ok: true,
      value: {
        rows: [
          {
            id: "a",
            targetId: "BD",
            before: { ...SELLER, addressEn: "Old" },
            after: SELLER,
          },
          { id: "b", targetId: "KE", before: null, after: SELLER },
        ],
      },
    };
    const got = await loadInvoiceSeller(ADMIN, { market: "BD" });
    expect(got).toMatchObject({ kind: "ok", value: { state: "ready", version: 3 } });
    if (got.kind !== "ok") throw new Error("not ok");
    expect(got.value.history).toHaveLength(1);
    expect(got.value.history[0]?.changed).toEqual(["addressEn"]);
  });
  it("a market that is not offered falls back to the first one", async () => {
    const got = await loadInvoiceSeller(ADMIN, { market: "ZZ" });
    expect(got).toMatchObject({ kind: "ok", value: { market: "BD" } });
  });
  it("a refused read and a failing database are unavailable, with no error text", async () => {
    world.seller = { ok: false, error: "forbidden" };
    expect(await loadInvoiceSeller(ADMIN, {})).toEqual({ kind: "unavailable" });
    world.readThrows = true;
    const got = await loadInvoiceSeller(ADMIN, {});
    expect(got).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(got)).not.toContain("secret");
  });
});

describe("the seller rules of @tc/db and @tc/core agree", () => {
  const cases: unknown[] = [
    SELLER,
    { ...SELLER, vatCircle: " Dhaka South ", phone: "+8801700000000", email: "a@b.co" },
    { ...SELLER, bin: "123" },
    { ...SELLER, bin: "12345678901234" },
    { ...SELLER, bin: "১২৩৪৫৬৭৮৯০১২৩" },
    { ...SELLER, bin: 1234567890123 },
    { ...SELLER, addressEn: "   " },
    { ...SELLER, addressEn: "a\u0007b" },
    { ...SELLER, legalNameEn: "x".repeat(201) },
    { ...SELLER, signatoryName: "x".repeat(121) },
    { ...SELLER, phone: "abc" },
    { ...SELLER, email: "nope" },
    { ...SELLER, phone: "", email: "", vatCircle: "" },
    null,
    "x",
    [],
    {},
  ];
  it.each(cases.map((c, i) => [i, c] as const))("case %i", (_i, value) => {
    expect(parseSellerFields(value)).toEqual(parseSellerDetails(value));
  });
});
