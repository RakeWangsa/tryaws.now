import type { CustomerSession } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";
import type { CustomerSupportRequestRow } from "@tc/db";
import { serverConfigOf } from "./servers-view.ts";

// What /support/new shows (16.10): the customer's own earlier requests, newest first. The columns
// are the ones web_rw may read; the message text is not loaded for the list.

export type { CustomerSupportRequestRow };

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
