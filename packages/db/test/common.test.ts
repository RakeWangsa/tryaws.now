import { expect, it } from "vitest";
import { inList } from "../schema/common";
import { markets } from "../schema/index";

it("inList refuses an empty list and a value that is not a plain lower-case word", () => {
  expect(() => inList(markets.code, [])).toThrow("inList: no values");
  expect(() => inList(markets.code, ["ok", "not'ok"])).toThrow("inList: not a plain value: not'ok");
  expect(() => inList(markets.code, ["Upper"])).toThrow("inList: not a plain value: Upper");
  expect(() => inList(markets.code, ["a_1", "b2"])).not.toThrow();
});
