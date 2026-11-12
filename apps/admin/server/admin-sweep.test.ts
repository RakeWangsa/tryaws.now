import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECTION_ROLES } from "./sections.ts";

// WP9-T2 sweep, admin app (R9, R10, R16). The source of apps/admin is scanned, so a new page, Server
// Action, route handler, flow or data module that does not begin with the authenticate-and-authorize
// step fails here. The database side of the same rule (isActiveAdmin and the role check in every
// method of adminRepos, reads included) is packages/db/test/admin-gates.test.ts.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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
const rel = (path: string): string => posix(relative(ROOT, path));
const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);

const APP_FILES = walk(join(ROOT, "app")).filter((f) => !isTest(f));
const SERVER_FILES = walk(join(ROOT, "server")).filter((f) => !isTest(f));
const USE_SERVER = /^\s*["']use server["'];?\s*$/m;

// What is NOT a gated admin page, route or action, and why. Anything else must be gated.
const PAGE_EXEMPT: Record<string, string> = {
  "app/[locale]/login/page.tsx":
    "the sign-in page: it is the way to authenticate (the form posts to signInAction)",
  "app/[locale]/dev/ui/page.tsx":
    "the component gallery: notFound() unless isDevUiEnabled (never in production)",
  "app/[locale]/dev/ui/[shell]/page.tsx": "the component gallery: notFound() unless isDevUiEnabled",
};
const ROUTE_EXEMPT: Record<string, string> = {
  "app/api/csp-report/route.ts": "receives browser CSP reports: no admin data in or out",
};
const ACTION_EXEMPT: Record<string, string> = {
  "server/actions.ts#signInAction":
    "it IS the authentication (its own limiter, TOTP and allowlist, sign-in.ts)",
  "server/actions.ts#signOutAction": "ends the session of the caller; writes one access-audit row",
};

describe("pages: loadPageAdmin (authenticate and authorize with the roles of the section) comes first", () => {
  const pages = APP_FILES.filter((f) => f.endsWith("/page.tsx"));

  it("finds the pages of the admin app", () => {
    expect(pages.length).toBeGreaterThanOrEqual(20);
  });

  it.each(pages.map((f) => [rel(f), f] as const))("%s", (name, file) => {
    if (PAGE_EXEMPT[name] !== undefined) return;
    const source = read(file);
    const gate = source.search(/\bloadPageAdmin\(\s*locale\s*,\s*([A-Za-z"']+)/);
    expect(gate, `${name} does not call loadPageAdmin(locale, <section>)`).toBeGreaterThanOrEqual(
      0,
    );
    // The section is a literal key of the role matrix, or the route's own [section] param.
    const call = /\bloadPageAdmin\(\s*locale\s*,\s*([A-Za-z"']+)/.exec(source);
    const argument = (call?.[1] ?? "").replace(/["']/g, "");
    const literal = /\bloadPageAdmin\(\s*locale\s*,\s*["']/.test(source);
    if (literal) expect(Object.keys(SECTION_ROLES)).toContain(argument);
    else expect(name).toBe("app/[locale]/[section]/page.tsx");
    // No data call, no repository and no other loader before the gate.
    const before = source.slice(0, gate);
    expect(before).not.toMatch(/\badminRepos\(|\bwithTx\(|\bread(?:As|Tx)\w*\(/);
    const other = /\b(?!loadPageAdmin\b)load[A-Z][A-Za-z]*\(/.exec(source);
    if (other !== null) expect(other.index).toBeGreaterThan(gate);
  });
});

describe("route handlers: the allowlist, then the handler that authorizes first", () => {
  const routes = APP_FILES.filter((f) => f.endsWith("/route.ts"));

  it.each(routes.map((f) => [rel(f), f] as const))("%s", (name, file) => {
    if (ROUTE_EXEMPT[name] !== undefined) return;
    const source = read(file);
    const gate = source.indexOf("adminGate(");
    expect(gate, `${name} does not check the address allowlist`).toBeGreaterThanOrEqual(0);
    const handler = /\bmake[A-Z]\w*\(/.exec(source);
    expect(handler, `${name} does not call a make*() handler`).not.toBeNull();
    expect((handler as RegExpExecArray).index).toBeGreaterThan(gate);
  });

  // The handlers behind the routes: authorize() is their first step, before the limiter and any read.
  it.each([["server/audit-export.ts"], ["server/kyc-documents.ts"]])(
    "%s authorizes first",
    (name) => {
      const source = read(join(ROOT, name));
      const authorize = source.indexOf("deps.authorize(");
      expect(authorize).toBeGreaterThanOrEqual(0);
      for (const later of ["deps.limiter(", "deps.run("]) {
        expect(source.indexOf(later)).toBeGreaterThan(authorize);
      }
    },
  );
});

describe("Server Actions: ensureAdminAuth, then a flow that authorizes first", () => {
  const files = SERVER_FILES.filter((f) => USE_SERVER.test(read(f)));
  const actions = files.flatMap((file) => {
    const source = read(file);
    const heads = [...source.matchAll(/^export async function (\w+)\(/gm)];
    return heads.map((m, i) => {
      const end = heads[i + 1]?.index ?? source.length;
      return {
        id: `${rel(file)}#${m[1]}`,
        body: source.slice(m.index, end),
        file: rel(file),
      };
    });
  });

  it("finds the Server Actions of the admin app", () => {
    expect(files.map(rel).sort()).toEqual([
      "server/actions.ts",
      "server/admins-actions.ts",
      "server/capacity-actions.ts",
      "server/case-actions.ts",
      "server/customer-actions.ts",
      "server/money-actions.ts",
      "server/ops-actions.ts",
      "server/pricing-actions.ts",
    ]);
    expect(actions.length).toBeGreaterThanOrEqual(14);
  });

  it.each(actions.map((a) => [a.id, a] as const))("%s", (id, action) => {
    if (ACTION_EXEMPT[id] !== undefined) return;
    // The pricing actions get ensureAdminAuth() inside pricingFlowDeps() (pricing-runtime.ts).
    const authInside = action.body.includes("pricingFlowDeps()");
    expect(
      action.body.includes("ensureAdminAuth()") || authInside,
      `${id} does not configure the admin session check`,
    ).toBe(true);
    expect(action.body, `${id} does not call a flow`).toMatch(/\bmake[A-Z]\w*\(/);
    // No repository and no database call in the action itself: the flow owns the order of R9.
    expect(action.body).not.toMatch(/\badminRepos\(|\bwithTx\(/);
  });

  it("pricing-runtime configures the admin session check inside pricingFlowDeps", () => {
    expect(read(join(ROOT, "server/pricing-runtime.ts"))).toMatch(
      /export function pricingFlowDeps\(\)[^{]*\{\s*ensureAdminAuth\(\);/,
    );
  });
});

describe("flows: authorize with roles is the first step, before the limiter, the database and the queue", () => {
  const flows = SERVER_FILES.filter((f) => /-flow\.ts$/.test(f));

  it("finds the flows", () => {
    expect(flows.map(rel).sort()).toEqual([
      "server/abuse-flow.ts",
      "server/admins-flow.ts",
      "server/capacity-flow.ts",
      "server/customer-flow.ts",
      "server/money-flow.ts",
      "server/ops-flow.ts",
      "server/pricing-flow.ts",
      "server/reconciliation-flow.ts",
      "server/support-flow.ts",
    ]);
  });

  it.each(flows.map((f) => [rel(f), f] as const))("%s", (name, file) => {
    const source = read(file);
    // Comments out: the notes mention the words too.
    const code = source.replace(/\/\/.*$/gm, "");
    const first = code.search(/\b(?:deps\.)?authorize\(/);
    expect(first, `${name} never calls authorize`).toBeGreaterThanOrEqual(0);
    for (const later of ["deps.limiter(", "deps.run(", "deps.queue", "repos.", "adminRepos("]) {
      const at = code.indexOf(later);
      if (at >= 0) expect(at, `${name}: ${later} before authorize`).toBeGreaterThan(first);
    }
  });

  it("the pricing flow authorizes in each of its four writes", () => {
    const code = read(join(ROOT, "server/pricing-flow.ts")).replace(/\/\/.*$/gm, "");
    expect([...code.matchAll(/await authorize\(/g)].length).toBe(4);
  });
});

describe("runtime wiring: every authorize port is requireAdmin with roles (a session, TOTP and a role)", () => {
  const source = read(join(ROOT, "server/runtime.ts"));
  const wired = [...source.matchAll(/authorize:\s*(\([^)]*\))?\s*=>\s*([^,\n]+)/g)];

  it("finds the ports", () => {
    expect(wired.length).toBeGreaterThanOrEqual(9);
  });

  it.each(wired.map((m) => [m[0].trim(), m[2] as string] as const))("%s", (_text, body) => {
    expect(body).toMatch(/^requireAdmin\(/);
  });
});

describe("data modules: reads run as the admin actor (repository checks the role again) or are named here", () => {
  const modules = SERVER_FILES.filter((f) => /-data\.ts$/.test(f));
  // Reads of the market configuration (markets, rules, rates, flags, catalog), which carry no customer
  // data. The page has the role gate (pages test above) and the loader takes the actor.
  const CONFIG_READS = new Set(["server/pricing-data.ts"]);

  it.each(modules.map((f) => [rel(f), f] as const))("%s", (name, file) => {
    const source = read(file);
    if (CONFIG_READS.has(name)) {
      expect(source).toMatch(/export async function load\w+\(\s*_?admin: AdminActor/);
      return;
    }
    // case-data reaches readAsAdmin through the read() helper of customers-data.
    expect(source).toMatch(/readAsAdmin\(|\bread<|\bread\(|adminRepos\(/);
    // Every loader takes the actor as its first parameter, so it cannot run without one.
    const loaders = [
      ...source.matchAll(/export (?:async function|const) (load\w+)\s*(?:=\s*)?\(([^)]*)\)/g),
    ];
    expect(loaders.length).toBeGreaterThan(0);
    for (const [, loader, params] of loaders) {
      expect(params, `${name}#${loader}`).toMatch(/^\s*_?admin: AdminActor/);
    }
    expect(source).not.toMatch(/\bwithTx\(/);
  });
});
