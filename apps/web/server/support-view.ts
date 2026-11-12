import type { CustomerSession } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import type { CustomerSupportRequestRow } from "@tc/db";

// What /support/new shows (16.10): the customer's own earlier requests, newest first. The columns
// are the ones web_rw may read; the message text is not loaded for the list.

export type { CustomerSupportRequestRow };

export interface SupportScreen {
  requests: readonly CustomerSupportRequestRow[];
}

export async function loadSupport(session: CustomerSession): Promise<SupportScreen> {
  return withTx(async (tx) => ({
    requests: await customerRepos(tx, session.customerId).support.list(20),
  }));
}
