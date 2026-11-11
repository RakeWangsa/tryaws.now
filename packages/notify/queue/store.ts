import type { Locale } from "@tc/core";
import { customers, markets, notifications, type Tx } from "@tc/db";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Numerals } from "../sms/otp-text";
import type { PlannedRow } from "./notify";
import type { Channel } from "./types";

// What the delivery loop needs from the database, as a port, so that the loop is tested without
// one. The PostgreSQL implementation runs as worker_rw (SELECT on notifications, UPDATE of status,
// attempts and sent_at only; SELECT of id, email, phone, phone_verified_at, locale and market on
// customers; SELECT of code and numerals on markets, migration 0006).

export const MAX_ATTEMPTS = 5;
// Minutes after the creation of the row at which attempt number n+1 becomes due. `created_at` is
// the only time the table has (no last-attempt column), so the spacing is counted from it.
export const BACKOFF_MINUTES = [0, 1, 5, 15, 60] as const;

export function isDue(attempts: number, createdAt: Date, now: Date): boolean {
  if (attempts < 0 || attempts >= MAX_ATTEMPTS) return false;
  return now.getTime() >= createdAt.getTime() + (BACKOFF_MINUTES[attempts] as number) * 60_000;
}

export interface StoredRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly email: string | null;
  readonly channel: Channel;
  readonly template: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly createdAt: Date;
}

export interface Recipient {
  readonly email: string;
  readonly phone: string | null;
  readonly phoneVerified: boolean;
  readonly locale: Locale;
  readonly numerals: Numerals;
}

export interface NotifierStore {
  // Pending rows that are due, oldest first.
  due(now: Date, limit: number): Promise<StoredRow[]>;
  recipient(customerId: string): Promise<Recipient | null>;
  // Compare-and-set: attempts goes from `attempts` to `attempts + 1` only while the row is still
  // pending at that number. True for exactly one of two runs that race for a row.
  claim(id: string, attempts: number): Promise<boolean>;
  markSent(id: string, now: Date): Promise<void>;
  // Only a pending row becomes failed. The attempts stay as they are.
  markFailed(id: string): Promise<void>;
}

export function createPgStore(run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>): NotifierStore {
  const channelOf = (c: string): Channel => c as Channel;
  return {
    due: (now, limit) =>
      run(async (tx) => {
        const backoff = sql.raw(`array[${BACKOFF_MINUTES.join(",")}]`);
        const rows = await tx
          .select({
            id: notifications.id,
            customerId: notifications.customerId,
            email: notifications.email,
            channel: notifications.channel,
            template: notifications.template,
            payload: notifications.payload,
            attempts: notifications.attempts,
            createdAt: notifications.createdAt,
          })
          .from(notifications)
          .where(
            and(
              eq(notifications.status, "pending"),
              lt(notifications.attempts, MAX_ATTEMPTS),
              sql`${notifications.createdAt} + (${backoff})[${notifications.attempts} + 1] * interval '1 minute' <= ${now.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(asc(notifications.createdAt))
          .limit(limit);
        return rows.map((r) => ({ ...r, channel: channelOf(r.channel) }));
      }),

    recipient: (customerId) =>
      run(async (tx) => {
        const [r] = await tx
          .select({
            email: customers.email,
            phone: customers.phone,
            phoneVerifiedAt: customers.phoneVerifiedAt,
            locale: customers.locale,
            numerals: markets.numerals,
          })
          .from(customers)
          .leftJoin(markets, eq(markets.code, customers.market))
          .where(eq(customers.id, customerId))
          .limit(1);
        if (r === undefined) return null;
        return {
          email: r.email,
          phone: r.phone,
          phoneVerified: r.phoneVerifiedAt !== null,
          locale: r.locale === "en" ? "en" : "bn",
          numerals: r.numerals === "latn" ? "latn" : "beng",
        };
      }),

    claim: (id, attempts) =>
      run(async (tx) => {
        const claimed = await tx
          .update(notifications)
          .set({ attempts: attempts + 1 })
          .where(
            and(
              eq(notifications.id, id),
              eq(notifications.status, "pending"),
              eq(notifications.attempts, attempts),
            ),
          )
          .returning({ id: notifications.id });
        return claimed.length === 1;
      }),

    markSent: (id, now) =>
      run(async (tx) => {
        await tx
          .update(notifications)
          .set({ status: "sent", sentAt: now })
          .where(and(eq(notifications.id, id), eq(notifications.status, "pending")));
      }),

    markFailed: (id) =>
      run(async (tx) => {
        await tx
          .update(notifications)
          .set({ status: "failed" })
          .where(and(eq(notifications.id, id), eq(notifications.status, "pending")));
      }),
  };
}

export interface MemoryRow extends Omit<StoredRow, "attempts"> {
  attempts: number;
  status: "pending" | "sent" | "failed";
  sentAt: Date | null;
  readonly dedupeKey: string;
}

// For tests: the same rules as the PostgreSQL store, in memory. add() keeps the unique key, like the
// table, so a replay adds nothing.
export class InMemoryNotifierStore implements NotifierStore {
  private readonly list: MemoryRow[] = [];
  private readonly recipients = new Map<string, Recipient>();
  private counter = 0;

  setRecipient(customerId: string, r: Recipient): void {
    this.recipients.set(customerId, r);
  }

  add(row: PlannedRow, createdAt: Date): void {
    if (this.list.some((r) => r.dedupeKey === row.dedupeKey)) return;
    this.counter += 1;
    this.list.push({
      id: `row-${this.counter}`,
      customerId: row.customerId,
      email: row.email,
      channel: row.channel,
      template: row.template,
      payload: row.payload,
      dedupeKey: row.dedupeKey,
      attempts: 0,
      createdAt,
      status: "pending",
      sentAt: null,
    });
  }

  rows(): readonly MemoryRow[] {
    return this.list;
  }

  clear(): void {
    this.list.length = 0;
  }

  due(now: Date, limit: number): Promise<StoredRow[]> {
    return Promise.resolve(
      this.list
        .filter((r) => r.status === "pending" && isDue(r.attempts, r.createdAt, now))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    );
  }

  recipient(customerId: string): Promise<Recipient | null> {
    return Promise.resolve(this.recipients.get(customerId) ?? null);
  }

  claim(id: string, attempts: number): Promise<boolean> {
    const row = this.list.find((r) => r.id === id);
    if (row === undefined || row.status !== "pending" || row.attempts !== attempts) {
      return Promise.resolve(false);
    }
    row.attempts = attempts + 1;
    return Promise.resolve(true);
  }

  markSent(id: string, now: Date): Promise<void> {
    const row = this.list.find((r) => r.id === id);
    if (row !== undefined && row.status === "pending") {
      row.status = "sent";
      row.sentAt = now;
    }
    return Promise.resolve();
  }

  markFailed(id: string): Promise<void> {
    const row = this.list.find((r) => r.id === id);
    if (row !== undefined && row.status === "pending") row.status = "failed";
    return Promise.resolve();
  }
}
