import { expect, it } from "vitest";
import { challengeIdFor, ipSubject, limitAddress, phoneSubject, viewerAddress } from "../otp/keys";
import { PEPPER } from "./harness";

const C = "01a1c989-a7aa-7337-aaf6-40387049a15d";

it("challengeIdFor is a version 8 UUID, repeatable, and different for another customer, key or pepper", () => {
  const id = challengeIdFor(PEPPER, C, "key-1");
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(challengeIdFor(PEPPER, C, "key-1")).toBe(id);
  for (const other of [
    challengeIdFor(PEPPER, C, "key-2"),
    challengeIdFor(PEPPER, C.replace("01a", "01b"), "key-1"),
    challengeIdFor(PEPPER + "x", C, "key-1"),
  ]) {
    expect(other).not.toBe(id);
  }
});

it("phoneSubject is 32 hex, repeatable, different for another number or key, and is not the number", () => {
  const s = phoneSubject(PEPPER, "+8801712345678");
  expect(s).toMatch(/^[0-9a-f]{32}$/);
  expect(phoneSubject(PEPPER, "+8801712345678")).toBe(s);
  expect(phoneSubject(PEPPER, "+8801712345679")).not.toBe(s);
  expect(phoneSubject(PEPPER + "x", "+8801712345678")).not.toBe(s);
});

it.each([
  ["203.0.113.9", "203.0.113.9"],
  ["::ffff:203.0.113.9", "203.0.113.9"],
  ["::FFFF:CB00:7109", "203.0.113.9"],
  ["2001:DB8:0:0:0:0:0:1", "2001:db8:0:0"],
  ["2001:db8::1", "2001:db8:0:0"],
  ["2001:db8:abcd:12:ffff:ffff:ffff:ffff", "2001:db8:abcd:12"],
  ["2001:db8:abcd:12::", "2001:db8:abcd:12"],
  ["::1", "0:0:0:0"],
  ["fe80::1%eth0", "fe80:0:0:0"],
])("limitAddress(%s) is %s", (ip, expected) => {
  expect(limitAddress(ip)).toBe(expected);
});

it.each(["010.1.1.1", "1.2.3", "1.2.3.4:80", "[::1]", "", "not an ip", " 1.2.3.4"])(
  "%j is not an address",
  (ip) => {
    expect(limitAddress(ip)).toBeNull();
    expect(ipSubject(PEPPER, ip)).toBeNull();
  },
);

it.each([
  ["198.51.100.10:46532", "198.51.100.10"],
  ["[2001:db8::1]:46532", "2001:db8::1"],
])("viewerAddress(%s) cuts the port: %s", (value, expected) => {
  expect(viewerAddress(value)).toBe(expected);
});

it.each([
  "198.51.100.10",
  "",
  undefined,
  null,
  "1.2.3.4,5.6.7.8:80",
  "evil",
  "1.2.3.4:0",
  "1.2.3.4:70000",
  "1.2.3.4:x",
  "[::1]",
  "2001:db8::1:80",
])("viewerAddress(%j) is null", (value) => {
  expect(viewerAddress(value as string | null | undefined)).toBeNull();
});

it("ipSubject is one subject per limit address: IPv4 and its mapped form, and two hosts of one /64, share it", () => {
  const v4 = ipSubject(PEPPER, "203.0.113.9");
  expect(v4).toMatch(/^[0-9a-f]{32}$/);
  expect(ipSubject(PEPPER, "::ffff:203.0.113.9")).toBe(v4);
  expect(ipSubject(PEPPER, "203.0.113.10")).not.toBe(v4);
  expect(ipSubject(PEPPER, "2001:db8:abcd:12::1")).toBe(
    ipSubject(PEPPER, "2001:db8:abcd:12:ffff::2"),
  );
  expect(ipSubject(PEPPER, "2001:db8:abcd:13::1")).not.toBe(
    ipSubject(PEPPER, "2001:db8:abcd:12::1"),
  );
  expect(ipSubject(PEPPER, "203.0.113.9")).not.toBe(phoneSubject(PEPPER, "203.0.113.9")); // the labels separate the uses
});
