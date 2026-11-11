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
// What it sees, and what it does not:
//   - The rows of A that it compares are those of the tables of TENANT_TABLES. A write outside them
//     (rate_limits, discrepancies, a row that only an e-mail address names) is invisible to the
//     snapshot: a case that touches such a table asserts it in its own test.
//   - It compares what a run answers, returned or thrown, as plain data. An answer it cannot show as
//     plain data (a Map, a class instance) is refused.
//   - The kind of a case is declared by its author and is not checked here: a write labelled
//     self-write drops the comparison with the answer about a missing row. The kind of every
//     repository method is pinned in review, in the case modules of test/cross-tenant-cases/.
//
// A case has a kind:
//   read        a get, a list, any answer; it may name a target row
//   write       changes or deletes a target row, or inserts a row that refers to a target row (an
//               operation for a resource)
//   self-write  a write that names no existing row and acts only on the actor's own data: an add, an
//               update of the actor's own profile, an audit record
//
// The rules of a case author:
//   - `run` uses a fresh idempotency key on every call and derives every other value from `target`
//     or from fixed text, so that its run on the ghost of the target is the same request about rows
//     that do not exist.
//   - `target` identifies the rows by whole UUID strings, as a value or as a key of a plain object or
//     array: ghostOf replaces only those. A name, a fingerprint, a transaction id, or an id inside a
//     longer string ("/servers/<id>") stays real in the ghost. The helper refuses a ghost that still
//     holds an id of customer A; a natural key that holds no UUID can be told apart from a missing
//     row only if the case declares `ghost`.
//   - The answer of a run must not contain the ids it was asked about. Map an error to its kind
//     (not_found), never to a text with the id: the helper reads such a text as a leak.
//   - A run resolves when its effects are committed. Work that a run starts and does not await (a
//     floating promise, a timer, an after() hook) is not seen.
//   - Every run gets its own copy of the target (structuredClone), so a run may change it.
export interface TenantCase<S> {
  readonly name: string; // "<repo>.<method>", or the endpoint's action name
  readonly kind: "read" | "write" | "self-write";
  // Runs the case as customerId against the rows of target.
  run(customerId: string, target: S): Promise<unknown>;
  // Makes the target of the same request about rows that do not exist. Default: ghostOf. A case that
  // finds its row by a natural key says here how to make another one, for example
  // (s) => ({ ...ghostOf(s), fingerprint: "SHA256:" + fresh() }).
  ghost?(target: S): S;
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

// createTempDatabase (test/temp-db.ts) names a database tc_test_<process id>_<8 lower-case hex
// digits>. This literal mirrors its TEST_DATABASE, which that file does not export.
const TEST_DATABASE = /^tc_test_\d+_[0-9a-f]{8}$/;
const KINDS: readonly unknown[] = ["read", "write", "self-write"];

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

const sortedByKey = (item: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

// An Error as plain data, the same for an error that is thrown and for one that is returned: JSON
// shows nothing of an Error, whose name, message and stack are not own enumerable properties. Every
// own enumerable property is part of it (a digest, a status, a code): two errors that differ only
// there are two answers. The stack differs from run to run and says nothing.
function errorRecord(error: Error): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key !== "stack") record[key] = value;
  }
  record.name = error.name;
  record.message = error.message;
  record.code = (error as { code?: unknown }).code ?? null;
  if (Object.hasOwn(error, "cause")) record.cause = error.cause;
  return record;
}

// What a run threw, as plain data. A thrown object that is no Error keeps its content, so that two
// thrown objects that differ are two answers.
function thrownRecord(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return errorRecord(error);
  if (typeof error === "object" && error !== null) {
    return { name: "object", code: null, message: "", value: error };
  }
  return { name: typeof error, code: null, message: String(error) };
}

const constructorOf = (item: object): string => {
  const name = (Object.getPrototypeOf(item) as { constructor?: { name?: unknown } } | null)
    ?.constructor?.name;
  return typeof name === "string" && name !== "" ? name : "object";
};

// JSON with the keys of every object in code unit order and a bigint as "<n>n", so that two equal
// answers give equal text. The value is wrapped by the callers, because JSON.stringify gives
// undefined (not a string) for a bare undefined. A value that JSON cannot show (a Map, a Set, a
// Response, an instance of a class) would give {} and make two different answers equal: it is
// refused (R16). JSON.stringify calls toJSON before the replacer, so a Date has become a string by
// then and what reaches the test below has no toJSON.
function canonical(value: unknown, subject = "an answer"): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return `${item}n`;
    if (item instanceof Error) return sortedByKey(errorRecord(item));
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      if (!isPlainObject(item)) {
        throw new TypeError(`${subject} holds a ${constructorOf(item)}; return plain data`);
      }
      return sortedByKey(item);
    }
    return item;
  });
}

// What a run answered, as canonical text (`raw`), and the same text with every UUID replaced by
// "<id>" (`norm`), so that two answers about different ids compare equal when they say the same.
// `threw` tells whether the run ended in an error.
interface Outcome {
  readonly raw: string;
  readonly norm: string;
  readonly threw: boolean;
}

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  let settled: { returned: unknown } | { threw: Record<string, unknown> };
  try {
    settled = { returned: await run() };
  } catch (error) {
    settled = { threw: thrownRecord(error) };
  }
  const raw = canonical(settled);
  return { raw, norm: raw.replace(ANY_UUID, "<id>"), threw: "threw" in settled };
}

// The ids that belong to customer A: the customer itself and every UUID inside its seed.
function idsOwnedBy(customerId: string, seeded: unknown): string[] {
  const inSeed = canonical({ seeded }, "the seed").match(ANY_UUID) ?? [];
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

// A case writes to the rows of two customers, some of them on purpose against their scope: fail
// closed unless the pool is the throwaway database of a test.
async function assertThrowawayDatabase(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ current_database: string }>("select current_database()");
  const name = rows[0]?.current_database;
  if (typeof name !== "string" || !TEST_DATABASE.test(name)) {
    throw new Error(
      `tenant isolation: the pool is not a throwaway test database (found ${JSON.stringify(name)}, ` +
        "expected tc_test_<pid>_<hex>); the cases write to it",
    );
  }
}

const BLIND_A = "customer A does not find its own rows; the case proves nothing";
const THREW_A =
  "the read of customer A on its own rows threw an error, which is no proof that it finds them; the case proves nothing";
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
  // Everything is refused before the first write: no case, a case of an unknown kind, a pool that
  // is not a throwaway test database.
  if (options.cases.length === 0) throw new Error("tenant isolation: no case given");
  for (const c of options.cases) {
    if (!KINDS.includes(c.kind)) {
      throw new TypeError(
        `tenant isolation: the case ${c.name} has the kind ${JSON.stringify(c.kind)}; ` +
          "use read, write or self-write",
      );
    }
  }
  await assertThrowawayDatabase(pool);
  const findings: TenantFinding[] = [];
  for (const c of options.cases) {
    const found = (check: TenantCheck, detail: string): void => {
      findings.push({ case: c.name, check, detail });
    };
    const run = (customerId: string, target: S): Promise<Outcome> => {
      // Its own copy, made outside the try of outcome(): a target that cannot be copied fails the
      // check, it is not an answer. A run that changes its target changes nothing for the next run.
      const copy = structuredClone(target);
      return outcome(() => c.run(customerId, copy));
    };

    const a = await newCustomer(pool);
    const b = await newCustomer(pool);
    const seededA = await options.seed(pool, a);
    await options.seed(pool, b);
    const idsA = idsOwnedBy(a, seededA);
    const ghost = c.ghost === undefined ? ghostOf(seededA) : c.ghost(seededA);
    // A ghost that still holds an id of customer A is not a request about a missing row: its runs
    // would be the real request, and an existence leak would compare equal to itself.
    const ghostText = canonical({ ghost }, "the ghost").toLowerCase();
    if (idsA.some((id) => ghostText.includes(id))) {
      throw new Error(
        `tenant isolation: the ghost of case ${c.name} still holds an id of customer A; ghostOf ` +
          "replaces whole UUID strings only. Identify the rows by whole UUIDs in the target, or " +
          "give the case a ghost that makes the request about a row that does not exist",
      );
    }

    // B goes first in every branch, between two snapshots of A: if A's own run came first it could
    // apply a change that B's run would then repeat, and B's run would show no change.
    if (c.kind === "read") {
      const beforeRead = await tenantSnapshot(pool, a);
      const cross = await run(b, seededA);
      const readChanged = changedTables(beforeRead, await tenantSnapshot(pool, a));
      const crossGhost = await run(b, ghost);
      const own = await run(a, seededA);
      const ownGhost = await run(a, ghost);
      // A finds its rows when its answer names an id of its seed or differs from the answer about
      // a missing row. An error proves nothing. The customer id of A is no proof when the seed holds
      // other ids: an answer that only echoes the actor would satisfy it.
      const seedIds = idsA.filter((id) => id !== a.toLowerCase());
      const ownIds = seedIds.length > 0 ? seedIds : idsA;
      if (own.threw) found("own-read", THREW_A);
      else if (!(names(own, ownIds) || own.norm !== ownGhost.norm)) found("own-read", BLIND_A);
      if (readChanged.length > 0) {
        found(
          "cross-read",
          `a read of customer B changed rows of customer A in: ${readChanged.join(", ")}`,
        );
      }
      if (names(cross, idsA)) found("cross-read", NAMES_A);
      else if (cross.norm !== crossGhost.norm) found("cross-read", differs(cross, crossGhost));
      continue;
    }

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
