import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

it("pins the two SDK clients of section 4 to one exact version and adds nothing else (R17)", () => {
  expect(pkg.dependencies).toEqual({
    "@aws-sdk/client-lightsail": "3.1166.0",
    "@aws-sdk/client-sts": "3.1166.0",
    "@tc/core": "workspace:*",
  });
  expect(pkg.devDependencies).toEqual({ "@types/node": "24.19.2" });
});
