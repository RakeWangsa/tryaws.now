import { DrizzleQueryError } from "drizzle-orm";

// The one error type that leaves the database layer. It keeps the SQLSTATE and the names of the
// constraint and the table, and nothing else: never the PostgreSQL message, the detail, the query,
// the parameters or a cause, because they echo input values (R14).
export class DbError extends Error {
  override readonly name = "DbError";
  readonly code: string;
  readonly constraint: string | undefined;
  readonly table: string | undefined;

  constructor(code: string, at: { constraint?: string; table?: string } = {}) {
    const where =
      at.constraint !== undefined
        ? ` on constraint ${at.constraint}`
        : at.table !== undefined
          ? ` on table ${at.table}`
          : "";
    super(`database error ${code}${where}`);
    this.code = code;
    this.constraint = at.constraint;
    this.table = at.table;
  }
}

// Serialization failure and deadlock.
export const RETRYABLE_SQLSTATES = ["40001", "40P01"] as const;

// Every class of PostgreSQL 16 Appendix A is two digits or F0, HV, P0, XX; five-letter Node codes
// such as EPIPE do not match.
const SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;

const stringField = (error: object, key: string): string | undefined => {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

const sqlState = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
};

const fromPgError = (error: object, code: string): DbError => {
  const constraint = stringField(error, "constraint");
  const table = stringField(error, "table");
  return new DbError(code, {
    ...(constraint !== undefined ? { constraint } : {}),
    ...(table !== undefined ? { table } : {}),
  });
};

// A DbError for a database error, or null for anything else (the caller rethrows it unchanged).
export function toDbError(error: unknown): DbError | null {
  if (error instanceof DbError) return error;
  if (error instanceof DrizzleQueryError) {
    // Its own message holds the query parameters and must never pass on.
    const cause: unknown = error.cause;
    const code = sqlState(cause);
    return code !== undefined ? fromPgError(cause as object, code) : new DbError("unknown");
  }
  const code = sqlState(error);
  return code !== undefined ? fromPgError(error as object, code) : null;
}

export function isRetryable(error: DbError): boolean {
  return (RETRYABLE_SQLSTATES as readonly string[]).includes(error.code);
}
