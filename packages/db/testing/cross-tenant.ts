import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { newCustomer } from "../test/fixtures";
import { tenantSnapshot } from "./snapshot";

// The cross-tenant (IDOR) test of R8, for every repository method and every endpoint that takes a
// row of a customer. It seeds two customers, A and B, runs each case as B against the rows of A, and
// compares what B gets with what B gets for a row that does not exist. If a missing row and a row of
// another customer are answered alike and nothing of A changed, nothing leaks: not the data, not
// even the fact that the row exists.
//
// A case has a kind:
//   read        a get, a list, any answer; it may name a target row
//   write       changes or deletes a target row, or inserts a row that refers to a target row (an
//               operation for a resource)
//   self-write  a write that names no existing row and acts only on the actor's own data: an add, an
//               update of the actor's own profile, an audit record
// A case's `run` uses a fresh idempotency key on every call and derives every other value from
// `target` or from fixed text, so that its run on ghostOf(target) is the same request about rows
// that do not exist.
export interface TenantCase<S> {
  readonly name: string; // "<repo>.<method>", or the endpoint's action name
  readonly kind: "read" | "write" | "self-write";
  // Runs the case as customerId against the rows of target.
  run(customerId: string, target: S): Promise<unknown>;
}

export interface TenantIsolationOptions<S> {
  // The owner's pool of the test database: it seeds and takes the snapshots. Never a pool whose
  // connections took a role (tenantSnapshot reads every column).
  readonly pool: pg.Pool;
  // The rows of one customer; returns their ids.
  seed(pool: pg.Pool, customerId: string): Promise<S>;
  readonly cases: readonly TenantCase<S>[];
}

// own-*: the case does not touch the data of its own customer, so it proves nothing.
// cross-*: another customer reads or changes the data of the owner, or learns that it exists.
export type TenantCheck = "own-read" | "cross-read" | "cross-write" | "own-write";

export interface TenantFinding {
  readonly case: string;
  readonly check: TenantCheck;
  readonly detail: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const WHOLE_UUID = new RegExp(`^${UUID}$`, "i");
const ANY_UUID = new RegExp(UUID, "gi");

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * The same structure as `target` (plain objects and arrays, copied deeply), with every string that
 * is a whole UUID, as a value or as a key, replaced by a new v7 id. One id always gets the same
 * replacement within one call. Every other value is kept. A case run on the result is the same
 * request about rows that do not exist.
 */
export function ghostOf<S>(target: S): S {
  const replacements = new Map<string, string>();
  const replace = (id: string): string => {
    const key = id.toLowerCase();
    let ghost = replacements.get(key);
    if (ghost === undefined) {
      ghost = uuidv7();
      replacements.set(key, ghost);
    }
    return ghost;
  };
  const copy = (value: unknown): unknown => {
    if (typeof value === "string") return WHOLE_UUID.test(value) ? replace(value) : value;
    if (Array.isArray(value)) return value.map((item) => copy(item));
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          WHOLE_UUID.test(key) ? replace(key) : key,
          copy(item),
        ]),
      );
    }
    return value;
  };
  return copy(target) as S;
}

// JSON with the keys of every object in code unit order and a bigint as "<n>n", so that two equal
// answers give equal text. The value is wrapped by the callers, because JSON.stringify gives
// undefined (not a string) for a bare undefined.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return `${item}n`;
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      );
    }
    return item;
  });
}

// What a run answered, as canonical text (`raw`), and the same text with every UUID replaced by
// "<id>" (`norm`), so that two answers about different ids compare equal when they say the same.
interface Outcome {
  readonly raw: string;
  readonly norm: string;
}

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  let settled: { returned: unknown } | { threw: { name: string; code: unknown; message: string } };
  try {
    settled = { returned: await run() };
  } catch (error) {
    settled =
      error instanceof Error
        ? {
            threw: {
              name: error.name,
              code: (error as { code?: unknown }).code ?? null,
              message: error.message,
            },
          }
        : { threw: { name: typeof error, code: null, message: String(error) } };
  }
  const raw = canonical(settled);
  return { raw, norm: raw.replace(ANY_UUID, "<id>") };
}

// The ids that belong to customer A: the customer itself and every UUID inside its seed.
function idsOwnedBy(customerId: string, seeded: unknown): string[] {
  const inSeed = canonical({ seeded }).match(ANY_UUID) ?? [];
  return [...new Set([customerId, ...inSeed].map((id) => id.toLowerCase()))];
}

const names = (answer: Outcome, ids: readonly string[]): boolean => {
  const raw = answer.raw.toLowerCase();
  return ids.some((id) => raw.includes(id));
};

type Snapshot = Record<string, string[]>;

// The tables, sorted, in which the rows of the two snapshots differ.
function changedTables(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((table) => JSON.stringify(before[table] ?? []) !== JSON.stringify(after[table] ?? []))
    .sort();
}

const NAMES_A = "the answer to customer B names a row of customer A";
const differs = (cross: Outcome, crossGhost: Outcome): string =>
  `customer B gets another answer for a row of customer A than for a missing row: ${cross.norm} | ${crossGhost.norm}`;

/**
 * Runs every case, one after another (never in parallel, so that a statement a case sends can be
 * tied to one customer), with two fresh customers per case, and returns what it found. No finding
 * means the case is tenant-scoped and also touched the data it claims to protect.
 */
export async function checkTenantIsolation<S>(
  options: TenantIsolationOptions<S>,
): Promise<TenantFinding[]> {
  const { pool } = options;
  const findings: TenantFinding[] = [];
  for (const c of options.cases) {
    const found = (check: TenantCheck, detail: string): void => {
      findings.push({ case: c.name, check, detail });
    };
    const run = (customerId: string, target: S): Promise<Outcome> =>
      outcome(() => c.run(customerId, target));

    const a = await newCustomer(pool);
    const b = await newCustomer(pool);
    const seededA = await options.seed(pool, a);
    await options.seed(pool, b);
    const idsA = idsOwnedBy(a, seededA);
    const ghost = ghostOf(seededA);

    if (c.kind === "read") {
      const own = await run(a, seededA);
      const ownGhost = await run(a, ghost);
      if (!(names(own, idsA) || own.norm !== ownGhost.norm)) {
        found("own-read", "customer A does not find its own rows; the case proves nothing");
      }
      const cross = await run(b, seededA);
      const crossGhost = await run(b, ghost);
      if (names(cross, idsA)) found("cross-read", NAMES_A);
      else if (cross.norm !== crossGhost.norm) found("cross-read", differs(cross, crossGhost));
      continue;
    }

    // B goes first: if B's run is allowed to change the rows of A, A's own run below would
    // otherwise hide it by changing them first.
    const before = await tenantSnapshot(pool, a);
    const cross = await run(b, seededA);
    const after = await tenantSnapshot(pool, a);
    const changed = changedTables(before, after);
    if (changed.length > 0) {
      found(
        "cross-write",
        `a write of customer B changed rows of customer A in: ${changed.join(", ")}`,
      );
    }
    if (names(cross, idsA)) found("cross-write", NAMES_A);
    if (c.kind === "write") {
      const crossGhost = await run(b, ghost);
      if (cross.norm !== crossGhost.norm) found("cross-write", differs(cross, crossGhost));
    }
    const ownBefore = await tenantSnapshot(pool, a);
    await run(a, seededA); // its answer or error is ignored; only the effect on the rows counts
    const ownAfter = await tenantSnapshot(pool, a);
    if (changedTables(ownBefore, ownAfter).length === 0) {
      found(
        "own-write",
        "the write of customer A on its own rows changed nothing; the case proves nothing",
      );
    }
  }
  return findings;
}

/** Throws when checkTenantIsolation finds anything; the message lists every finding. */
export async function expectTenantIsolation<S>(options: TenantIsolationOptions<S>): Promise<void> {
  const findings = await checkTenantIsolation(options);
  if (findings.length > 0) {
    throw new Error(
      "tenant isolation failed:\n" +
        findings.map((f) => `${f.case} ${f.check}: ${f.detail}`).join("\n"),
    );
  }
}
