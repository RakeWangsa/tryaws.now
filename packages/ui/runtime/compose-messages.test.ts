import { describe, expect, it } from "vitest";
import { composeMessages } from "./compose-messages.ts";

describe("composeMessages", () => {
  it("merges two parts", () => {
    expect(composeMessages({ Shell: { a: "1" } }, { Web: { b: "2" } })).toEqual({
      Shell: { a: "1" },
      Web: { b: "2" },
    });
  });

  it("throws on a duplicate top-level namespace and names it", () => {
    expect(() => composeMessages({ Shell: { a: "1" } }, { Shell: { b: "2" } })).toThrow(/Shell/);
  });

  it("does not mutate its inputs", () => {
    const one = { Shell: { a: "1" } };
    const two = { Web: { b: "2" } };
    const result = composeMessages(one, two);
    expect(one).toEqual({ Shell: { a: "1" } });
    expect(two).toEqual({ Web: { b: "2" } });
    expect(result).not.toBe(one);
    expect(result).not.toBe(two);
  });

  it("keeps nested keys", () => {
    const result = composeMessages({ Shell: { nav: { home: "Home", deep: { x: "y" } } } });
    expect(result).toEqual({ Shell: { nav: { home: "Home", deep: { x: "y" } } } });
  });

  it("returns an empty object for no parts", () => {
    expect(composeMessages()).toEqual({});
  });
});
