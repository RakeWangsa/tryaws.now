import { expect, it } from "vitest";
import { normalizeDisplayName } from "./display-name";

it("collapses and trims whitespace", () => {
  expect(normalizeDisplayName("  রহিম   উদ্দিন ")).toBe("রহিম উদ্দিন");
  expect(normalizeDisplayName("Rahim  Uddin")).toBe("Rahim Uddin");
});

it("normalises to NFC", () => {
  expect(normalizeDisplayName("Café Owner")).toBe("Café Owner");
});

it("accepts 2 and 80 code points", () => {
  expect(normalizeDisplayName("Al")).toBe("Al");
  expect(normalizeDisplayName("a".repeat(80))).toBe("a".repeat(80));
});

it.each([
  ["A"],
  ["a".repeat(81)],
  ["a<b"],
  ["a>b"],
  ["a&b"],
  ['a"b'],
  ["a​b"],
  ["‮evil"],
  ["a\nb"],
  ["a\u0000b"],
  ["   "],
  [""],
])("%j is refused", (input) => {
  expect(normalizeDisplayName(input)).toBeNull();
});

it.each([undefined, null, 5, ["Rahim"]])("%j (not a string) is null", (input) => {
  expect(normalizeDisplayName(input)).toBeNull();
});
