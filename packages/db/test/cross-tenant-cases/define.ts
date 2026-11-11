import type pg from "pg";
import type { CustomerRepos } from "../../repositories/customer/index";
import {
  checkTenantIsolation,
  type TenantCase,
  type TenantFinding,
} from "../../testing/cross-tenant";

// What a case module gets from the proof file: a way to run a repository as one customer, with every
// statement recorded (the proof file owns the recorder).
export interface CaseContext {
  asCustomer<T>(customerId: string, fn: (r: CustomerRepos) => Promise<T>): Promise<T>;
}

// The cross-tenant cases of ONE repository of customerRepos.
export interface CaseSet {
  readonly repo: keyof CustomerRepos & string; // "profile", "sshKeys", ...
  readonly methods: readonly string[]; // "<repo>.<method>" of every case, sorted
  check(pool: pg.Pool, context: CaseContext): Promise<TenantFinding[]>;
}

// The context that reads the keys of `cases`: a case is built but never run with it.
const NO_PROOF: CaseContext = {
  asCustomer: () => {
    throw new Error("a case set is not run without a proof context");
  },
};

export function defineCaseSet<S>(spec: {
  readonly repo: keyof CustomerRepos & string;
  seed(pool: pg.Pool, customerId: string): Promise<S>; // the rows of one customer; returns their ids
  cases(context: CaseContext): Record<string, Omit<TenantCase<S>, "name">>; // keys are "<repo>.<method>"
}): CaseSet {
  const methods = Object.keys(spec.cases(NO_PROOF)).sort();
  for (const method of methods) {
    if (!method.startsWith(`${spec.repo}.`)) {
      throw new TypeError(
        `defineCaseSet: the case "${method}" is not a case of the repository "${spec.repo}"`,
      );
    }
  }
  return {
    repo: spec.repo,
    methods,
    check: (pool, context) =>
      checkTenantIsolation({
        pool,
        seed: spec.seed,
        cases: Object.entries(spec.cases(context)).map(([name, c]) => ({ name, ...c })),
      }),
  };
}
