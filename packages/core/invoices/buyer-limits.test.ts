import { buyerTextLength, truncateBuyerText } from "@tc/db/buyer-rules";
import { expect, it } from "vitest";
import { buyerSnapshotFrom, parseBuyerSnapshot } from "./buyer";

// WPU-I5: one rule for the length of a buyer text: code points (what the customer sees), 120 for the name
// and 300 for the address. The profile name (sign-up allows 200) is the FALLBACK of the snapshot and is cut
// to the limit when the snapshot is made; a name the customer typed in the billing details is validated on
// input and is never cut here.
const none = { billingName: null, billingAddress: null, customerBin: null, customerNid: null };
const astral = "\u{1F600}"; // one code point, two UTF-16 units

it("counts code points, not UTF-16 units", () => {
  expect(buyerTextLength(astral.repeat(120))).toBe(120);
  expect(astral.repeat(120).length).toBe(240);
  expect(buyerTextLength("")).toBe(0);
});

it("truncates on a code point, never in the middle of a surrogate pair", () => {
  const cut = truncateBuyerText(astral.repeat(130), 120);
  expect(buyerTextLength(cut)).toBe(120);
  expect(cut).toBe(astral.repeat(120));
  expect(truncateBuyerText("short", 120)).toBe("short");
});

it("a 150-character profile name is cut to 120 as the fallback, and the snapshot parses", () => {
  const profileName = "N".repeat(150);
  const snapshot = buyerSnapshotFrom({ ...none, customerBin: "1234567890123" }, profileName);
  expect(snapshot?.name).toBe("N".repeat(120));
  expect(parseBuyerSnapshot(snapshot)).toEqual(snapshot);
});

it("an astral profile name of 150 code points is cut to 120 code points", () => {
  const snapshot = buyerSnapshotFrom(
    { ...none, billingAddress: "House 5, Dhaka" },
    astral.repeat(150),
  );
  expect(buyerTextLength(snapshot?.name ?? "")).toBe(120);
  expect(parseBuyerSnapshot(snapshot)).not.toBeNull();
});

it("a BIN-only profile gets the cut fallback name and the BIN", () => {
  const snapshot = buyerSnapshotFrom({ ...none, customerBin: "1234567890123" }, "B".repeat(200));
  expect(snapshot).toEqual({
    name: "B".repeat(120),
    address: null,
    taxId: { kind: "bin", value: "1234567890123" },
  });
});

it("a name the customer typed is never cut: it is kept as typed", () => {
  const typed = "T".repeat(120);
  expect(buyerSnapshotFrom({ ...none, billingName: typed }, "F".repeat(150))?.name).toBe(typed);
  // beyond the limit it would have been refused on input; if it ever arrives here it is not cut
  const tooLong = "T".repeat(121);
  expect(buyerSnapshotFrom({ ...none, billingName: tooLong }, null)?.name).toBe(tooLong);
});

it("parseBuyerSnapshot counts code points: 120 astral characters are valid, 121 are not", () => {
  const ok = { name: astral.repeat(120), address: astral.repeat(300), taxId: null };
  expect(parseBuyerSnapshot(ok)).toEqual(ok);
  expect(parseBuyerSnapshot({ ...ok, name: astral.repeat(121) })).toBeNull();
  expect(parseBuyerSnapshot({ ...ok, address: astral.repeat(301) })).toBeNull();
});

it("a null or missing fallback stays null", () => {
  expect(buyerSnapshotFrom({ ...none, customerNid: "1234567890" }, null)?.name).toBeNull();
});
