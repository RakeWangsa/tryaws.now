import { describe, expect, it } from "vitest";
import { cx } from "./cx";

describe("cx", () => {
  it("joins the truthy parts with one space", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
  });

  it("is an empty string without parts", () => {
    expect(cx()).toBe("");
  });

  it("drops an empty string", () => {
    expect(cx("a", "", "b")).toBe("a b");
  });
});
