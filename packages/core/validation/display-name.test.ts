import { expect, it } from "vitest";
import { normalizeDisplayName } from "./display-name";

it("collapses and trims whitespace", () => {
  expect(normalizeDisplayName("  রহিম   উদ্দিন ")).toBe("রহিম উদ্দিন");
  expect(normalizeDisplayName("Rahim  Uddin")).toBe("Rahim Uddin");
});

it("accepts a ZWJ or ZWNJ between letters, as correct Bengali spelling needs", () => {
  expect(normalizeDisplayName("র‍্যাব")).toBe("র‍্যাব");
  expect(normalizeDisplayName("আবদুল‌লাহ")).toBe("আবদুল‌লাহ");
});

it("still refuses a joiner at an edge or doubled, and other format characters", () => {
  expect(normalizeDisplayName("‍রাব")).toBeNull();
  expect(normalizeDisplayName("রাব‍")).toBeNull();
  expect(normalizeDisplayName("রা‍‍ব")).toBeNull();
  expect(normalizeDisplayName("রা​ব")).toBeNull();
  expect(normalizeDisplayName("রা‮ব")).toBeNull();
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
