import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { afterAll, expect, it } from "vitest";
import { awsSdkClients } from "../../eslint.config.mjs";
import { readWorkspacePackages } from "../../scripts/lib/changed-packages.mjs";

// R1, the closure of the TypeScript programs. Lint reads import statements by their text; this test
// asks TypeScript itself. For every app and for every package except packages/aws it builds the
// program of the project from its own tsconfig.json (so tsconfig paths, symbolic links and relative
// bridges are resolved by TypeScript) and fails when a source file of that program has its real path
// in packages/aws, under functions/, or in one of the AWS SDK packages of the lint config. It is a
// tripwire for accidents, like lint: it sees only what a program of these folders loads. It does not
// see the files that no tsconfig of apps/ or packages/ includes, a call that is not an import, or
// code that a bundler setting adds. IAM (WP0-T5, not built yet) is the boundary.
// A package that legitimately needs an SDK package of the list (for example an RDS signer that
// depends on credential-providers) makes this test fail: that is a decision for the review of the
// change, not for a quiet exception.

const ROOT = realpathSync(resolve(import.meta.dirname, "../.."));
const sdkPart = awsSdkClients
  .map((name) => name.replaceAll("/", "[/\\\\]").replaceAll("-", "\\-"))
  .join("|");
const BANNED = [
  { why: "packages/aws", test: /[/\\]packages[/\\]aws[/\\]/ },
  { why: "a function", test: /[/\\]functions[/\\][^/\\]+[/\\]/ },
  { why: "an AWS SDK package", test: new RegExp(`[/\\\\]node_modules[/\\\\](${sdkPart})[/\\\\]`) },
];

// Returns one line per project and banned file, and the number of files of each program.
function closure(root, dirs) {
  const problems = [];
  const checked = [];
  for (const dir of dirs) {
    const config = ts.readConfigFile(join(root, dir, "tsconfig.json"), ts.sys.readFile);
    expect(config.error, dir).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(root, dir));
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    const files = program.getSourceFiles();
    checked.push(`${dir}: ${files.length} files`);
    for (const file of files) {
      // Both the path as TypeScript names it and the real path, seen from the root, so that the
      // folders above the checkout never match.
      const seen = (path) => `/${relative(root, path).split(sep).join("/")}`;
      const real = seen(realpathSync(file.fileName));
      const named = seen(resolve(file.fileName));
      const hit = BANNED.find((b) => b.test.test(named) || b.test.test(real));
      if (hit) problems.push(`${dir} loads ${hit.why}: ${real.slice(1)}`);
    }
  }
  return { problems, checked };
}

it("no app and no package except packages/aws loads packages/aws, a function or an AWS SDK package", () => {
  const dirs = Object.keys(readWorkspacePackages(".")).filter(
    (dir) => (dir.startsWith("apps/") || dir.startsWith("packages/")) && dir !== "packages/aws",
  );
  expect(dirs).toEqual(expect.arrayContaining(["apps/web", "apps/admin", "packages/db"]));
  const started = Date.now();
  const { problems, checked } = closure(ROOT, dirs);
  const seconds = (Date.now() - started) / 1000;
  process.stdout.write(
    `closure: ${checked.length} programs in ${seconds}s (${checked.join("; ")})\n`,
  );
  expect(problems).toEqual([]);
  expect(seconds).toBeLessThan(60);
});

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "tc-closure-")));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const write = (path, text) => {
  mkdirSync(join(TMP, posix.dirname(path)), { recursive: true });
  writeFileSync(join(TMP, path), text);
};

it("finds a bridge outside apps/ and packages/, and a plain program is clean", () => {
  const tsconfig = JSON.stringify({
    compilerOptions: { module: "ESNext", moduleResolution: "Bundler", noEmit: true },
    include: ["*.ts"],
  });
  write("packages/aws/index.ts", "export const aws = 1;\n");
  write("functions/reader/index.ts", "export const reader = 1;\n");
  write("infra/bridge.ts", 'export { aws } from "../packages/aws/index";\n');
  write("infra/bridge2.ts", 'export { reader } from "../functions/reader/index";\n');
  write("apps/web/tsconfig.json", tsconfig);
  write(
    "apps/web/x.ts",
    'export * from "../../infra/bridge";\nexport * from "../../infra/bridge2";\n',
  );
  write("apps/clean/tsconfig.json", tsconfig);
  write("apps/clean/x.ts", "export const x = 1;\n");
  const { problems } = closure(TMP, ["apps/web", "apps/clean"]);
  expect(problems).toEqual([
    "apps/web loads packages/aws: packages/aws/index.ts",
    "apps/web loads a function: functions/reader/index.ts",
  ]);
});
