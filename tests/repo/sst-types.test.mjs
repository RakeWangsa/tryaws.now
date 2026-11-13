import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// WPU-B4 (audit item 38): type-check the SST stack files (infra/stacks, infra/app.ts and the root sst.config.ts).
// They use the globals of SST ($config, $app, sst.aws.*), which exist only after `sst install` has
// generated .sst/platform/config.d.ts, and that command downloads Pulumi and the AWS provider: it needs
// network. Without that file this check is SKIPPED with the reason below (never a pass of the types).
//
// For a person with network, once:
//   pnpm install --frozen-lockfile
//   pnpm exec sst install          # writes .sst/platform/config.d.ts; no AWS credentials, no deploy
//   pnpm exec tsc -p infra/tsconfig.stacks.json
//   pnpm test --filter repo sst-types      # runs the same tsc call as this test
const root = resolve(import.meta.dirname, "../..");
const platformTypes = resolve(root, ".sst/platform/config.d.ts");
const SKIP_REASON =
  "SST types are not generated here: run `pnpm exec sst install` (needs network, no AWS credentials) " +
  "and then `pnpm exec tsc -p infra/tsconfig.stacks.json`";

describe("infra/tsconfig.stacks.json", () => {
  const config = JSON.parse(readFileSync(resolve(root, "infra/tsconfig.stacks.json"), "utf8"));

  it("covers the stack files, the SST config and the generated SST types", () => {
    expect(config.include).toEqual(
      expect.arrayContaining([
        "app.ts",
        "../sst.config.ts",
        "stacks/**/*.ts",
        "../.sst/platform/config.d.ts",
      ]),
    );
    expect(config.extends).toBe("../tsconfig.base.json");
  });

  it("is not part of the ordinary typecheck, which stays offline (the lib part is checked by infra/tsconfig.json)", () => {
    const ordinary = JSON.parse(readFileSync(resolve(root, "infra/tsconfig.json"), "utf8"));
    expect(ordinary.include).toEqual(["lib/**/*.ts"]);
  });
});

it.skipIf(!existsSync(platformTypes))(
  `the SST stack files type-check (skipped when the SST types are missing: ${SKIP_REASON})`,
  () => {
    const run = spawnSync("pnpm", ["exec", "tsc", "-p", "infra/tsconfig.stacks.json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.stdout + run.stderr).toBe("");
    expect(run.status).toBe(0);
  },
  180_000,
);
