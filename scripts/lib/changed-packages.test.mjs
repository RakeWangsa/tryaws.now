import { expect, it } from "vitest";
import { changedPackages } from "./changed-packages.mjs";

const packages = {
  "packages/core": "@tc/core",
  "apps/web": "@tc/web",
  "functions/reader": "@tc/fn-reader",
};

it("maps changed files to their packages, without duplicates", () => {
  expect(
    changedPackages(
      ["packages/core/pricing/a.ts", "packages/core/b.ts", "apps/web/app/c.ts"],
      packages,
    ),
  ).toEqual(["@tc/core", "@tc/web"]);
});
it("selects everything when a file outside the packages changed", () => {
  expect(changedPackages(["packages/core/pricing/a.ts", "scripts/verify.mjs"], packages)).toBe(
    "all",
  );
  expect(changedPackages(["package.json"], packages)).toBe("all");
});
it("selects everything when nothing changed", () => {
  expect(changedPackages([], packages)).toBe("all");
});
