import { posix } from "node:path";

const ENTRY = "packages/db/testing";
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

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
      [...text.matchAll(SPECIFIER)].some((m) => namesTestingEntry(path, m[1])),
    )
    .map(([path]) => path);
}
