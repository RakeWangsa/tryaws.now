import type { Database } from "../client";
import { customerRepos, type CustomerRepos } from "../repositories/customer/index";
import { runTransaction } from "../tx";

// Runs fn with the repositories of one customer in one transaction as web_rw, so the column grants
// of migration 0006 apply. Every repository test and every endpoint test that drives customerRepos
// directly uses it. (Not named asCustomer: that is the session stub of WP2-T1.)
export function withCustomerRepos<T>(
  db: Database,
  customerId: string,
  fn: (r: CustomerRepos) => Promise<T>,
): Promise<T> {
  return runTransaction(db, (tx) => fn(customerRepos(tx, customerId)), { role: "web_rw" });
}
