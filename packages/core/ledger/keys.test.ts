import { describe, expect, it } from "vitest";
import { ledgerKey } from "./keys";

const ID = "01A1C982-80F0-7000-8000-00000000ABCD";
const id = ID.toLowerCase();

describe("ledgerKey (spec 9.1)", () => {
  it("derives each key from ids, in lower case", () => {
    expect(ledgerKey.topup(ID)).toBe(`topup:${id}`);
    expect(ledgerKey.purchase("Ab-_0123456789xyz")).toBe("order:Ab-_0123456789xyz");
    expect(ledgerKey.purchase("Ab+/0123456789xyz==")).toBe("order:Ab+/0123456789xyz==");
    expect(ledgerKey.reversal(ID)).toBe(`reversal:${id}`);
    expect(ledgerKey.orderReversal(ID)).toBe(`order-reversal:${id}`);
    expect(ledgerKey.refund(ID)).toBe(`refund:${id}`);
    expect(ledgerKey.renewal(ID, new Date("2026-12-01T00:00:00Z"))).toBe(
      `renew:${id}:2026-12-01T00:00:00.000Z`,
    );
    // WPU-Y2: attempt 0 is the key of the period as before; a retry after a reversed domain renewal is `:a<n>`.
    expect(ledgerKey.renewal(ID, new Date("2026-12-01T00:00:00Z"), 0)).toBe(
      `renew:${id}:2026-12-01T00:00:00.000Z`,
    );
    expect(ledgerKey.renewal(ID, new Date("2026-12-01T00:00:00Z"), 3)).toBe(
      `renew:${id}:2026-12-01T00:00:00.000Z:a3`,
    );
    expect(ledgerKey.metered(ID, "snapshot_gb", "2026-11-11")).toBe(
      `meter:${id}:snapshot_gb:2026-11-11`,
    );
    expect(ledgerKey.metered(ID, "transfer_gb", "2026-11-11T05")).toBe(
      `meter:${id}:transfer_gb:2026-11-11T05`,
    );
    expect(ledgerKey.adjustment(ID)).toBe(`adjustment:${id}`);
  });
  it("two callers with the same payment id get the same key (one credit per payment)", () => {
    expect(ledgerKey.topup(id)).toBe(ledgerKey.topup(ID));
  });
  it.each([
    ["topup", () => ledgerKey.topup("42")],
    ["reversal", () => ledgerKey.reversal("")],
    ["adjustment", () => ledgerKey.adjustment(undefined as never)],
    ["refund", () => ledgerKey.refund("not-a-uuid")],
    ["orderReversal", () => ledgerKey.orderReversal("42")],
    ["purchase", () => ledgerKey.purchase("short")],
    ["purchase", () => ledgerKey.purchase("has space has space")],
    ["renewal", () => ledgerKey.renewal(ID, new Date("nope"))],
    ["renewal", () => ledgerKey.renewal("x", new Date())],
    ["renewal", () => ledgerKey.renewal(ID, new Date(), -1)],
    ["renewal", () => ledgerKey.renewal(ID, new Date(), 1.5)],
    ["renewal", () => ledgerKey.renewal(ID, new Date(), 100)],
    ["metered", () => ledgerKey.metered(ID, "Bad Metric", "2026-11-11")],
    ["metered", () => ledgerKey.metered(ID, "snapshot_gb", "yesterday")],
  ])("%s refuses a part that has the wrong form, and the text holds no value", (name, call) => {
    expect(call).toThrow(TypeError);
    expect(call).toThrow(new RegExp(`^ledgerKey\\.${name}: `));
  });
});
