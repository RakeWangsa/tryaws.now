import { expect, it } from "vitest";
import { vitestArgs } from "./test-args.mjs";

it("runs everything with no arguments", () => {
  expect(vitestArgs([])).toEqual(["run"]);
});
it("maps --filter <package> to --project", () => {
  expect(vitestArgs(["--filter", "@tc/core"])).toEqual(["run", "--project", "@tc/core"]);
});
it("maps --filter=<package> to --project", () => {
  expect(vitestArgs(["--filter=@tc/core"])).toEqual(["run", "--project", "@tc/core"]);
});
it("passes other arguments through", () => {
  expect(vitestArgs(["-t", "rounds half up"])).toEqual(["run", "-t", "rounds half up"]);
});
