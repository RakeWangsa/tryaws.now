import { expect, it } from "vitest";
import * as testing from "../testing/index";

it("the testing entry re-exports the harness and the fixtures of WP1-T1", () => {
  for (const name of [
    "useTempDatabase",
    "createTempDatabase",
    "insertRow",
    "inTransaction",
    "uniqueSuffix",
    "ensureMarket",
    "newAdmin",
    "newCustomer",
    "newResource",
  ]) {
    expect(typeof (testing as Record<string, unknown>)[name], name).toBe("function");
  }
});
