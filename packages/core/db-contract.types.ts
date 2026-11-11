import type { RepoErrorCode, Written } from "@tc/db";
import type { ErrorCode, Result } from "./types";

type Assert<T extends true> = T;
// @tc/db cannot import @tc/core (lint rule DB_BELOW_CORE); this file keeps its result type inside the contract of F.
export type RepoCodesAreErrorCodes = Assert<RepoErrorCode extends ErrorCode ? true : false>;
export type WrittenIsAResult = Assert<
  Written<{ id: string }> extends Result<{ id: string }> ? true : false
>;
