import { DrizzleQueryError } from "drizzle-orm";
import { expect, it } from "vitest";
import { DbError, isRetryable, toDbError } from "../errors";

const pgError = (code: string, message: string, more: Record<string, string> = {}) =>
  Object.assign(new Error(message), { code, ...more });
const leaks = (e: unknown, secret: string) =>
  [String(e), (e as Error).message, (e as Error).stack ?? "", JSON.stringify(e)].some((s) =>
    s.includes(secret),
  );

it("a unique violation keeps its code and constraint and drops the row values of detail", () => {
  const e = toDbError(
    pgError(
      "23505",
      'duplicate key value violates unique constraint "ssh_keys_customer_id_fingerprint_unique"',
      {
        constraint: "ssh_keys_customer_id_fingerprint_unique",
        table: "ssh_keys",
        detail: "Key (customer_id, fingerprint)=(x, SHA256:abc) already exists.",
      },
    ),
  );
  expect(e).toBeInstanceOf(DbError);
  expect(e).toMatchObject({
    name: "DbError",
    code: "23505",
    constraint: "ssh_keys_customer_id_fingerprint_unique",
    table: "ssh_keys",
  });
  expect(e!.message).toBe(
    "database error 23505 on constraint ssh_keys_customer_id_fingerprint_unique",
  );
  expect(leaks(e, "SHA256:abc")).toBe(false);
});

it("a failed Drizzle query loses its parameters and the PostgreSQL message that echoes them", () => {
  const cause = pgError("22P02", 'invalid input syntax for type integer: "someone@example.test"');
  const e = toDbError(new DrizzleQueryError("select $1::int", ["someone@example.test"], cause));
  expect(e).toMatchObject({ code: "22P02", constraint: undefined, table: undefined });
  expect(e!.message).toBe("database error 22P02");
  expect(leaks(e, "someone@example.test")).toBe(false);
  expect("cause" in e!).toBe(false);
});

it("a Drizzle query error without a SQLSTATE becomes code unknown, still without parameters", () => {
  const e = toDbError(
    new DrizzleQueryError(
      "select $1",
      ["+8801700000000"],
      new Error("Connection terminated unexpectedly"),
    ),
  );
  expect(e!.message).toBe("database error unknown");
  expect(leaks(e, "+8801700000000")).toBe(false);
});

it("an error with a table and no constraint names the table", () => {
  expect(
    toDbError(pgError("42501", "permission denied for table operations", { table: "operations" }))!
      .message,
  ).toBe("database error 42501 on table operations");
});

it("other errors are not database errors", () => {
  expect(toDbError(new Error("boom"))).toBeNull();
  expect(
    toDbError(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
    ),
  ).toBeNull();
  expect(toDbError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBeNull();
  expect(toDbError("text")).toBeNull();
  const own = new DbError("40P01");
  expect(toDbError(own)).toBe(own);
});

it("only a deadlock and a serialization failure are retryable", () => {
  expect(isRetryable(new DbError("40P01"))).toBe(true);
  expect(isRetryable(new DbError("40001"))).toBe(true);
  expect(isRetryable(new DbError("23505"))).toBe(false);
  expect(isRetryable(new DbError("unknown"))).toBe(false);
});
