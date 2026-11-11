import { posix } from "node:path";

const ENTRY = "packages/db/testing";
// A specifier is a string literal after `from`, `import`, `import(` or `require(` (the right side of
// `import t = require("...")` too). A template literal counts when it holds no `${`: with one, a
// scan cannot know the path. Group 1 is a quoted specifier, group 2 a template one.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(?:["']([^"']+)["']|`((?:[^`$]|\$(?!\{))+)`)/g;

function namesTestingEntry(path, specifier) {
  if (specifier === "@tc/db/testing" || specifier.startsWith("@tc/db/testing/")) return true;
  if (!specifier.startsWith(".")) return false;
  const target = posix.join(posix.dirname(path), specifier);
  return target === ENTRY || target.startsWith(`${ENTRY}/`);
}

/**
 * The paths (repository-relative, `/`-separated) whose text imports or re-exports
 * @tc/db/testing, by package name or by a relative path to packages/db/testing.
 * @param {[path: string, text: string][]} files
 * @returns {string[]}
 */
export function importsOfTestingEntry(files) {
  return files
    .filter(([path, text]) =>
      [...text.matchAll(SPECIFIER)].some((m) => namesTestingEntry(path, m[1] ?? m[2])),
    )
    .map(([path]) => path);
}
