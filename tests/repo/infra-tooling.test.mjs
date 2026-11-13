// WP0-T2: the tooling accepts infra/ the way it is meant to, and nothing secret or account specific is
// written there. SST is not installed, so tsc covers infra/lib only; stacks are linted and formatted.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { childEnv } from "./child-env.mjs";

const root = resolve(import.meta.dirname, "../..");

function files(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

// infra/org belongs to another task and holds organization templates.
const ours = [
  "sst.config.ts",
  ...files("infra").filter((f) => !f.startsWith(join("infra", "org"))),
];

describe("tooling", () => {
  it("type-checks infra/lib with the repository's tsc", () => {
    const tsc = resolve(root, "node_modules/typescript/bin/tsc");
    const run = spawnSync(process.execPath, [tsc, "-p", "infra/tsconfig.json"], {
      cwd: root,
      encoding: "utf8",
      env: childEnv(),
    });
    expect(run.stdout + run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("scopes the infra tsconfig to the pure libraries, because sst types are absent", () => {
    const config = JSON.parse(readFileSync(resolve(root, "infra/tsconfig.json"), "utf8"));
    expect(config.include).toEqual(["lib/**/*.ts"]);
  });

  it("does not exclude infra from ESLint or Prettier (a rule or a format would be skipped)", () => {
    const eslint = readFileSync(resolve(root, "eslint.config.mjs"), "utf8");
    const ignores = /ignores: \[([\s\S]*?)\],\n {2}\},/.exec(eslint)?.[1] ?? "";
    expect(ignores).not.toMatch(/infra|sst\.config/);
    const prettier = readFileSync(resolve(root, ".prettierignore"), "utf8");
    expect(prettier).not.toMatch(/^infra|sst\.config/m);
    expect(prettier).not.toMatch(/^\.sst/m);
  });

  it("keeps SST's own working folder out of git", () => {
    expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toMatch(/^\.sst\/?$/m);
  });

  it("pins sst exactly in the root devDependencies (WPU-D2, C.1) and adds no @pulumi package of its own", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.devDependencies.sst).toBe("4.17.2");
    expect(manifest.dependencies?.sst).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toMatch(/@pulumi/);
  });

  it("leaves infra/org alone", () => {
    expect(existsSync(resolve(root, "infra/org"))).toBe(true);
  });

  // WPU-Z10: the one public 12-digit number allowed is the AWS account that publishes the fck-nat images
  // (NAT_INSTANCE.amiOwner of infra/lib/lean.ts, the AMI owner filter of SST 4.17.2 vpc.ts), there only.
  // WPU-Z18: the one sst.Secret with a placeholder is the optional FirstAdminSub (the placeholder is the
  // literal not-configured of infra/lib/functions.ts, not a value), in infra/stacks/secrets.ts only.
  it("writes no account id, ARN of an account, key or secret value in infra/", () => {
    const FCK_NAT_PUBLISHER = `amiOwner: "568608671756"`;
    const FIRST_ADMIN_SUB = "new sst.Secret(FIRST_ADMIN_SUB_SECRET, OPTIONAL_SECRET_PLACEHOLDER)";
    for (const file of ours) {
      const raw = readFileSync(resolve(root, file), "utf8");
      const allowed =
        file === join("infra", "lib", "lean.ts")
          ? FCK_NAT_PUBLISHER
          : file === join("infra", "stacks", "secrets.ts")
            ? FIRST_ADMIN_SUB
            : null;
      const text = allowed === null ? raw : raw.replace(allowed, "");
      expect(text, file).not.toMatch(/\b\d{12}\b/);
      expect(text, file).not.toMatch(/arn:aws:[a-z0-9-]*:[a-z0-9-]*:\d{12}/);
      expect(text, file).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/);
      expect(text, file).not.toMatch(/aws_secret_access_key|BEGIN [A-Z ]*PRIVATE KEY/i);
      expect(text, file).not.toMatch(/sst\.Secret\([^)]*,[^)]*\)/);
      expect(text, file).not.toMatch(/\.ticoncloud\.com|ticoncloud\.com/);
    }
  });

  it("reads nothing from the environment outside the root sst.config.ts", () => {
    for (const file of ours.filter((f) => f.endsWith(".ts") && f !== "sst.config.ts")) {
      expect(readFileSync(resolve(root, file), "utf8"), file).not.toMatch(/process\.env/);
    }
  });

  it("imports no AWS SDK client into infra (R1 and the SDK rule)", () => {
    for (const file of ours.filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(resolve(root, file), "utf8"), file).not.toMatch(
        /@aws-sdk\/|from "@tc\/aws"/,
      );
    }
  });

  it("marks every stack file as not type-checked and lists VERIFY items in them", () => {
    const stacks = files("infra/stacks");
    expect(stacks.length).toBeGreaterThanOrEqual(10);
    let verify = 0;
    for (const file of stacks) {
      const text = readFileSync(resolve(root, file), "utf8");
      expect(text, file).toMatch(/NOT TYPE-CHECKED/);
      verify += (text.match(/VERIFY:/g) ?? []).length;
    }
    expect(verify).toBeGreaterThanOrEqual(25);
  });
});
