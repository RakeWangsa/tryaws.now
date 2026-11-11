import { expect, it } from "vitest";
import * as entry from "../index";
import * as testing from "../testing/index";

const exported = (module: object) => module as Record<string, unknown>;

it("@tc/db exports withTx and closeDatabase, and none of the test seams", () => {
  for (const name of ["withTx", "closeDatabase"]) {
    expect(typeof exported(entry)[name], name).toBe("function");
  }
  const names = Object.keys(entry);
  for (const name of ["runTransaction", "bindDatabase", "attachErrorListeners", "getDatabase"]) {
    expect(names, name).not.toContain(name);
  }
});

it("@tc/db/testing exports the helpers of the transaction wrapper", () => {
  for (const name of [
    "runTransaction",
    "bindDatabase",
    "attachErrorListeners",
    "useBoundTestDatabase",
  ]) {
    expect(typeof exported(testing)[name], name).toBe("function");
  }
});
