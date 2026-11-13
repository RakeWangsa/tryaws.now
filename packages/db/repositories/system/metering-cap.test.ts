import { describe, expect, it } from "vitest";
import { OPERATIONS_READ_CAP, assertWithinOperationCap } from "./metering";

// Automated security review, 2026-11-13: operationsOf cut the read at 500 oldest rows, so on a busy
// resource the newest operations could be missing and a guard would decide on stale data (fail open).
describe("assertWithinOperationCap", () => {
  it("accepts up to the cap", () => {
    expect(() => assertWithinOperationCap(0)).not.toThrow();
    expect(() => assertWithinOperationCap(OPERATIONS_READ_CAP)).not.toThrow();
  });

  it("refuses one row more than the cap: the read was cut short (R16)", () => {
    expect(() => assertWithinOperationCap(OPERATIONS_READ_CAP + 1)).toThrow(RangeError);
  });
});
