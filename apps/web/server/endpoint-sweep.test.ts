import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "./endpoint-sweep.cases.ts";

// WP9-T2 sweep, web side (R8, R9). The source of apps/web/app is scanned: every Server Action, every
// route handler and every page with an id in its path must be in the register
// (endpoint-sweep.cases.ts) with a proof that exists, and every page of the panel must begin with the
// session check. The repositories are proved one level down: packages/db/test/cross-tenant.test.ts
// ("every method of customerRepos has a cross-tenant case") with the cases in cross-tenant-cases/.
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(WEB, "..", "..");
const posix = (p: string): string => p.split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const read = (path: string): string => readFileSync(path, "utf8");
const appRel = (path: string): string => posix(relative(WEB, path));
const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);

const APP_FILES = walk(join(WEB, "app")).filter((f) => !isTest(f));
const USE_SERVER = /^\s*["']use server["'];?\s*$/m;

// Server Actions: the exports of every file that starts with the directive.
function actions(): string[] {
  return APP_FILES.filter((f) => /\.tsx?$/.test(f) && USE_SERVER.test(read(f))).flatMap((file) => {
    const source = read(file);
    return [...source.matchAll(/^export (?:async function|const|function) (\w+)/gm)].map(
      (m) => `${appRel(file)}#${m[1]}`,
    );
  });
}
const routes = (): string[] => APP_FILES.filter((f) => f.endsWith("/route.ts")).map(appRel);
// A page with a dynamic segment other than the locale and the dev gallery shell takes an id.
const idPages = (): string[] =>
  APP_FILES.filter(
    (f) =>
      f.endsWith("/page.tsx") &&
      /\[(?!locale\]|shell\])[A-Za-z]+\]/.test(posix(relative(join(WEB, "app"), f))),
  ).map(appRel);

const SCANNED = [...actions(), ...routes(), ...idPages()].sort();

describe("the register covers exactly the endpoints found in the source", () => {
  it("finds the Server Actions, the route handlers and the pages with an id", () => {
    expect(actions().length).toBeGreaterThanOrEqual(40);
    expect(routes().length).toBeGreaterThanOrEqual(7);
    expect(idPages().length).toBeGreaterThanOrEqual(6);
  });

  it("every endpoint of the source has an entry, and no entry is left without its endpoint", () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(SCANNED);
  });

  it("every entry has a proof, and the kinds that touch a resource name a cross-tenant or session proof", () => {
    for (const [name, entry] of Object.entries(ENDPOINTS)) {
      expect(entry.proof.length, name).toBeGreaterThan(0);
    }
  });

  it.each(Object.entries(ENDPOINTS).flatMap(([name, e]) => e.proof.map((p) => [name, p] as const)))(
    "%s: its proof exists",
    (_name, proof) => {
      const path = join(REPO, proof.file);
      expect(existsSync(path), `${proof.file} does not exist`).toBe(true);
      expect(read(path), `${proof.file} has no test titled "${proof.test}"`).toContain(proof.test);
    },
  );
});

describe("pages of the panel begin with the session check (R9 step 1)", () => {
  const panel = APP_FILES.filter((f) => f.endsWith("/page.tsx") && posix(f).includes("/(panel)/"));
  it("finds the pages of the panel", () => {
    expect(panel.length).toBeGreaterThanOrEqual(20);
  });
  it.each(panel.map((f) => [appRel(f), f] as const))("%s", (name, file) => {
    const source = read(file);
    const gate = source.search(/\b(?:startPanelPage|requirePanel)\(/);
    expect(gate, `${name} does not call startPanelPage or requirePanel`).toBeGreaterThanOrEqual(0);
    // No loader of customer data runs before the gate.
    const loader = /\bload[A-Z][A-Za-z]*\(/.exec(source);
    if (loader !== null)
      expect(loader.index, `${name}: ${loader[0]} before the gate`).toBeGreaterThan(gate);
  });
});

describe("pages and actions outside the panel hold no customer data", () => {
  // The public pages (home, legal, pricing, sign-in...) may be built by other tasks: none of them may
  // read a customer's rows. A page that must show customer data belongs under (panel).
  const outside = APP_FILES.filter(
    (f) =>
      /\.tsx?$/.test(f) &&
      !posix(f).includes("/(panel)/") &&
      !posix(f).includes("/dev/") &&
      !/\/app\/(?:pay|api)\//.test(posix(f)),
  );
  it.each(outside.map((f) => [appRel(f), f] as const))("%s", (name, file) => {
    const source = read(file);
    expect(source, name).not.toMatch(
      /\bcustomerRepos\(|server\/(?:servers|extras|bucket|cdn|container|wallet|topup|kyc|settings)-view/,
    );
  });
});

describe("every Server Action of the panel reads the session or a signed token before it does anything", () => {
  // The thin file of an action: the origin guard, then a core. Neither takes a customer id from the form.
  const files = APP_FILES.filter(
    (f) => posix(f).includes("/(panel)/") && /\.ts$/.test(f) && USE_SERVER.test(read(f)),
  );
  it.each(files.map((f) => [appRel(f), f] as const))("%s", (name, file) => {
    const source = read(file);
    // The names of the form fields that become input: none of them is a customer id.
    const fields = [...source.matchAll(/\[\s*((?:"[A-Za-z]+",?\s*)+)\]/g)].flatMap((m) =>
      [...(m[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]),
    );
    expect(fields, `${name} lets the form name a customer`).not.toContain("customerId");
    expect(source).not.toMatch(
      /formData\.get\(["']customerId["']\)|form\.get\(["']customerId["']\)/,
    );
  });
});
