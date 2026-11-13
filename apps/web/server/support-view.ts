import type { CustomerSession } from "@tc/auth";
import { isUuid } from "@tc/core";
import { customerRepos, withTx } from "@tc/db";
import type { CustomerSupportRequestRow, CustomerSupportThread } from "@tc/db";
import { serverConfigOf } from "./servers-view.ts";

// What /support/new shows (16.10): the customer's own earlier requests, newest first. The columns
// are the ones web_rw may read; the message text is not loaded for the list.

export type { CustomerSupportRequestRow, CustomerSupportThread };

export interface SupportResourceChoice {
  readonly id: string;
  /** The name the customer gave the resource (React escapes it; it is never an AWS name, R11). */
  readonly name: string;
}

export interface SupportScreen {
  requests: readonly CustomerSupportRequestRow[];
  /** The customer's own named resources, for "related resource" (WPU-B6). */
  resources: readonly SupportResourceChoice[];
}

const ENDED = ["destroyed", "failed"];

export async function loadSupport(session: CustomerSession): Promise<SupportScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const [requests, all] = await Promise.all([repos.support.list(20), repos.resources.list()]);
    // Top-level, not ended, with a name the customer chose; at most 100 so the list stays short.
    const resources = all
      .filter(
        (r) => r.parentResourceId === null && !ENDED.includes(r.state) && r.deletedAt === null,
      )
      .map((r) => ({ id: r.id, name: serverConfigOf(r.config).displayName.trim() }))
      .filter((r) => r.name !== "")
      .slice(0, 100);
    return { requests, resources };
  });
}

// WPU-Z6: /support/requests, the customer's requests with the newest activity first. The repository caps the
// list at 100; a database error is thrown to the error state of the page, never answered as empty (R16).
export interface SupportRequestsScreen {
  requests: readonly CustomerSupportRequestRow[];
}

export const SUPPORT_REQUESTS_LIMIT = 100;

export async function loadSupportRequests(
  session: CustomerSession,
): Promise<SupportRequestsScreen> {
  return withTx(async (tx) => ({
    requests: await customerRepos(tx, session.customerId).support.list(SUPPORT_REQUESTS_LIMIT),
  }));
}

/**
 * WPU-Z6: /support/requests/[id], the request and its replies (oldest first, never an admin's name or id).
 * Null for a request of another customer, a missing one and an id that is not a UUID alike (R8): the page
 * shows its not-found state. An id that is not a UUID is not looked up at all.
 */
export async function loadSupportThread(
  session: CustomerSession,
  requestId: string,
): Promise<CustomerSupportThread | null> {
  if (!isUuid(requestId)) return null;
  return withTx(async (tx) => {
    const found = await customerRepos(tx, session.customerId).support.thread(requestId);
    return found.ok ? found.value : null;
  });
}
