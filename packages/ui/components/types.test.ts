import { describe, expect, it } from "vitest";
import { toLocale } from "./types";

describe("toLocale", () => {
  it("accepts bn and en", () => {
    expect(toLocale("bn")).toBe("bn");
    expect(toLocale("en")).toBe("en");
  });

  it.each(["", "BN", "fr", "bn-BD", " en"])("throws RangeError for %j", (value) => {
    expect(() => toLocale(value)).toThrow(RangeError);
  });
});
