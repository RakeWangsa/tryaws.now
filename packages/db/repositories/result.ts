// What a repository write answers. The shape is the one of Result<T> in packages/core/types.ts:
// @tc/db sits below @tc/core and cannot import it, so packages/core/db-contract.types.ts proves at
// type-check time that every Written<T> is a Result<T> and every RepoErrorCode is an ErrorCode.
//
//   not_found   a missing row, a row of another customer and an id that is not a UUID alike (R8)
//   conflict    the idempotency key or the natural key is taken by a different request (R7)
//   validation  an input the repository checks itself, before any query
export type RepoErrorCode = "not_found" | "conflict" | "validation";

export type Written<T> =
  { ok: true; value: T; replayed: boolean } | { ok: false; error: RepoErrorCode };

// The write happened now.
export function created<T>(value: T): Written<T> {
  return { ok: true, value, replayed: false };
}

// The same request was made before; this is its earlier result.
export function replayed<T>(value: T): Written<T> {
  return { ok: true, value, replayed: true };
}

export function refused(error: RepoErrorCode): { ok: false; error: RepoErrorCode } {
  return { ok: false, error };
}
