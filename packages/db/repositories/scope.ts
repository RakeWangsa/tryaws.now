import type { Tx } from "../client";

// The scope of one request: the transaction, and the customer whose rows it may touch. A customer
// repository is built from this and from nothing else, so no method takes a customer id (R8). The
// customer id comes from the verified session (6.1), never from the request body, query or path.
export interface TenantScope {
  readonly tx: Tx;
  readonly customerId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

// R16: a scope that is not usable stops here, before any query, so no statement runs with a wrong
// customer. The message is fixed text: it never holds the value it refused (R14).
export function tenantScope(tx: Tx, customerId: string): TenantScope {
  if (typeof customerId !== "string" || !isUuid(customerId)) {
    throw new TypeError("customerRepos: the customer id is not a UUID");
  }
  return Object.freeze({ tx, customerId });
}
