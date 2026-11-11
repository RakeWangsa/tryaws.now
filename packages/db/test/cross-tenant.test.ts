import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import type { Database, Tx } from "../client";
import * as schema from "../schema/index";
import { customerRepos, type CustomerRepos } from "../repositories/customer/index";
import { checkTenantIsolation, type TenantCase } from "../testing/cross-tenant";
import { withCustomerRepos } from "../testing/repos";
import {
  type RecordedStatement,
  statementsWithInlinedIds,
  unscopedStatements,
} from "../testing/sql-audit";
import { runTransaction } from "../tx";
import { newCustomer } from "./fixtures";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const statements: RecordedStatement[] = [];
let actor: string | null = null;
let recording: Database | undefined;
const db = () =>
  (recording ??= drizzle(t.pool, {
    schema,
    logger: { logQuery: (sql, params) => statements.push({ sql, params, actor }) },
  }));

// Every case runs as web_rw (withCustomerRepos), so the column grants of migration 0006 apply; every statement is recorded with its actor.
async function asCustomer<T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>): Promise<T> {
  actor = customerId;
  try {
    return await withCustomerRepos(db(), customerId, fn);
  } finally {
    actor = null;
  }
}

type Seed = { customerId: string };
const seed = async (_pool: typeof t.pool, customerId: string): Promise<Seed> => ({ customerId });

const CASES: Record<string, Omit<TenantCase<Seed>, "name">> = {
  "profile.get": { kind: "read", run: (c) => asCustomer(c, (r) => r.profile.get()) },
  "profile.update": {
    kind: "self-write",
    run: (c) => asCustomer(c, (r) => r.profile.update({ name: "Rahim" })),
  },
};

it("every method of customerRepos has a cross-tenant case (data.md)", () => {
  const repos = customerRepos({} as Tx, uuidv7());
  const methods = Object.entries(repos).flatMap(([name, repo]) =>
    Object.keys(repo).map((m) => `${name}.${m}`),
  );
  expect(Object.keys(CASES).sort()).toEqual(methods.sort());
});

it("customer A cannot read or write the rows of customer B, and every statement about a tenant table binds the customer id (R8)", async () => {
  statements.length = 0;
  const findings = await checkTenantIsolation({
    pool: t.pool,
    seed,
    cases: Object.entries(CASES).map(([name, c]) => ({ name, ...c })),
  });
  const ran = statements.filter((s) => s.actor !== null);
  expect(ran.length).toBeGreaterThan(0);
  // One list, no duplicates: a statement that is in both audits is named once.
  const unscoped = [...new Set([...unscopedStatements(ran), ...statementsWithInlinedIds(ran)])];
  expect({
    findings: findings.map((f) => `${f.case} ${f.check}: ${f.detail}`),
    unscoped: unscoped.map((s) => s.sql),
  }).toEqual({ findings: [], unscoped: [] });
}, 120_000);

// The audit above reads what the Drizzle logger saw. The logger sees every statement, also one that
// arrives as a plain string or as sql.raw, which no lint rule on the repositories can see.
it("the recorder sees a statement given as a plain string or with an id in its text, and the audit reports both (R8)", async () => {
  statements.length = 0;
  const id = await newCustomer(t.pool);
  const other = uuidv7();
  actor = id;
  try {
    await runTransaction(
      db(),
      async (tx) => {
        await tx.execute("select 1 from ssh_keys");
        await tx.execute(
          sql`select 1 from ssh_keys where customer_id = ${id} and id <> ${sql.raw(`'${other}'`)}`,
        );
      },
      { role: "web_rw" },
    );
  } finally {
    actor = null;
  }
  const ran = statements.filter((s) => s.actor !== null);
  // The plain string arrives with no parameter at all.
  expect(unscopedStatements(ran).map((s) => s.sql)).toEqual(["select 1 from ssh_keys"]);
  // The second statement binds the actor, so only the check for an id in the text finds it.
  expect(statementsWithInlinedIds(ran).map((s) => s.sql)).toEqual([
    `select 1 from ssh_keys where customer_id = $1 and id <> '${other}'`,
  ]);
});
