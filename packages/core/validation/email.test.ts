import { expect, it } from "vitest";
import { normalizeEmail } from "./email";

const long64 = "a".repeat(64);

it.each([
  ["a@b.co", "a@b.co"],
  ["Name.Last+tag@Example.COM", "name.last+tag@example.com"],
  [`${long64}@x.co`, `${long64}@x.co`],
  ["  a@b.co ", "a@b.co"],
])("%j is %j", (input, expected) => {
  expect(normalizeEmail(input)).toBe(expected);
});

it.each([
  "a@b",
  "a@@b.co",
  '"a b"@x.co',
  "a b@x.co",
  "a,b@x.co",
  "<a>@x.co",
  "a@x..co",
  ".a@x.co",
  "a.@x.co",
  "a..b@x.co",
  "a@-x.co",
  "a@x-.co",
  "a@x.c",
  "a@x.c0m",
  "a@বাংলা.বাংলা",
  `${"a".repeat(65)}@x.co`,
  "a@x.co\n",
  "a​b@x.co",
  "a@x​.co",
  "",
  "@x.co",
  "a@",
])("%j is refused", (input) => {
  expect(normalizeEmail(input)).toBeNull();
});

it("refuses an address of 255 characters", () => {
  const addr = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`;
  expect(addr.length).toBe(255);
  expect(normalizeEmail(addr)).toBeNull();
});

it("accepts the longest shape: a 64-character local part and a 127-character domain", () => {
  const addr = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(59)}.com`;
  expect(addr.length).toBe(192);
  expect(normalizeEmail(addr)).toBe(addr);
  expect(normalizeEmail(`${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(60)}.com`)).toBeNull();
});

it.each([undefined, null, 1, ["a@x.co"], {}, true])("%j (not a string) is null", (input) => {
  expect(normalizeEmail(input)).toBeNull();
});
