import type { CustomerSession } from "@tc/auth";
import { customerRepos, withTx } from "@tc/db";

// The History tab of a resource (WPU-N1, parity priority 2): the requests (operations rows) made on one
// of the session's customer's resources, newest first. Read through the repositories of the customer
// only (R8): a resource of another customer and a missing one answer alike (null). Only the kind, the
// state and the time leave this file: no step, no attempt count, no error text, no payload (U6, R11).
// A failed read is `{ state: "error" }`, never an empty list that looks like "nothing happened" (R16).

export const HISTORY_LIMIT = 50;

/** The kinds the tab names; any other kind is shown as "other change". */
export const HISTORY_KINDS = [
  "create",
  "suspend",
  "resume",
  "destroy",
  "reboot",
  "stop",
  "start",
  "rename",
  "set_ports",
  "attach_static_ip",
  "detach_static_ip",
  "create_backup",
  "delete_backup",
  "set_auto_backup",
  "attach_disk",
  "detach_disk",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number] | "other";

export const HISTORY_STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "needs_approval",
  "needs_attention",
] as const;
export type HistoryState = (typeof HISTORY_STATES)[number];

export interface HistoryItem {
  id: string;
  kind: HistoryKind;
  state: HistoryState;
  at: Date;
}

export type HistoryScreen = { state: "ready"; items: HistoryItem[] } | { state: "error" };

const kindOf = (kind: string): HistoryKind =>
  (HISTORY_KINDS as readonly string[]).includes(kind) ? (kind as HistoryKind) : "other";
// A state this build does not know is shown as "we are looking at it" rather than guessed (R16).
const stateOf = (state: string): HistoryState =>
  (HISTORY_STATES as readonly string[]).includes(state)
    ? (state as HistoryState)
    : "needs_attention";

/** null: no such resource for this customer (R8). */
export async function loadResourceHistory(
  session: CustomerSession,
  resourceId: string,
): Promise<HistoryScreen | null> {
  try {
    return await withTx(async (tx) => {
      const repos = customerRepos(tx, session.customerId);
      const resource = await repos.resources.get(resourceId);
      if (resource === null) return null;
      const rows = await repos.operations.listForResource(resourceId);
      return {
        state: "ready" as const,
        items: rows.slice(0, HISTORY_LIMIT).map((row) => ({
          id: row.id,
          kind: kindOf(row.kind),
          state: stateOf(row.state),
          at: row.createdAt,
        })),
      };
    });
  } catch {
    return { state: "error" };
  }
}
