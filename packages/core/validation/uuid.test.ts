import { describe, expect, it } from "vitest";
import { isUuid, UUID_PATTERN } from "./uuid";

// Final review M3: the one UUID check of the repository's id fields (the support views and actions, the family
// actions, the provisioner's reject, the domain renewal payload, the admin case pages). Pure: no I/O.
describe("isUuid", () => {
  it("accepts the text form of a UUID, in either case, as PostgreSQL does", () => {
    for (const id of [
      "0190a000-0000-7000-8000-000000000001",
      "00000000-0000-0000-0000-000000000000",
      "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D",
    ]) {
      expect(isUuid(id), id).toBe(true);
      expect(UUID_PATTERN.test(id), id).toBe(true);
    }
  });

  it("refuses every other value", () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      [],
      "",
      "0190a000000070008000000000000001",
      "{0190a000-0000-7000-8000-000000000001}",
      " 0190a000-0000-7000-8000-000000000001",
      "0190a000-0000-7000-8000-000000000001\n",
      "0190a000-0000-7000-8000-00000000000g",
      "0190a000-0000-7000-8000-0000000000011",
    ]) {
      expect(isUuid(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("keeps no state between calls (the pattern has no global flag)", () => {
    expect(UUID_PATTERN.flags).not.toContain("g");
    expect(UUID_PATTERN.flags).not.toContain("y");
    const id = "0190a000-0000-7000-8000-000000000001";
    expect([isUuid(id), isUuid(id), isUuid(id)]).toEqual([true, true, true]);
  });
});
