import { sql } from "drizzle-orm";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// A phone challenge of the customer, without the code hash: only claimAttempt hands the hash out,
// and only to the service that compares it (WP2-T3).
export interface OtpChallenge {
  id: string;
  phone: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

// The caller derives `id` from the customer and the idempotency key (R7: the primary key is the
// unique key) and hashes the code; a plain code never reaches this repository (codeHash is v1.<hex>).
export interface NewOtpChallenge {
  id: string;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  now: Date;
}

// latestExpiry is now + ttl + the clock skew that is allowed: a challenge that expires later was
// issued by a clock further ahead than the verifier's clock may be behind.
export interface OtpClaim {
  now: Date;
  latestExpiry: Date;
  maxAttempts: number;
}

export interface ClaimedOtp {
  id: string;
  phone: string;
  codeHash: string;
  attempts: number;
}

export interface OtpRepo {
  issue(input: NewOtpChallenge): Promise<Written<OtpChallenge>>;
  claimAttempt(input: OtpClaim): Promise<Written<ClaimedOtp>>;
  close(id: string, at: Date): Promise<Written<{ id: string }>>;
  latest(): Promise<OtpChallenge | null>;
}

const CODE_HASH = /^v1\.[0-9a-f]{64}$/;
const PHONE = /^\+880[0-9]{10}$/;

// A raw statement returns the SQL column names and text for timestamps: every column is aliased and
// every timestamp mapped with new Date.
type RawChallenge = {
  id: string;
  phone: string;
  attempts: number;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

const CHALLENGE_COLUMNS = sql`o.id, o.phone, o.attempts, o.expires_at as "expiresAt",
  o.consumed_at as "consumedAt", o.created_at as "createdAt"`;

const toChallenge = (row: RawChallenge): OtpChallenge => ({
  id: row.id,
  phone: row.phone,
  attempts: row.attempts,
  expiresAt: new Date(row.expiresAt),
  consumedAt: row.consumedAt === null ? null : new Date(row.consumedAt),
  createdAt: new Date(row.createdAt),
});

export function otpRepo(scope: TenantScope): OtpRepo {
  return {
    // Idempotent by the primary key (R7). ON CONFLICT DO NOTHING, never a caught 23505. web_rw may
    // insert only (id, customer_id, phone, code_hash, expires_at), so the statement names exactly
    // those columns.
    issue: async (input) => {
      if (!isUuid(input.id) || !CODE_HASH.test(input.codeHash) || !PHONE.test(input.phone)) {
        return refused("validation");
      }
      const { rows } = await scope.tx.execute<RawChallenge>(sql`
        insert into otp_challenges as o (id, customer_id, phone, code_hash, expires_at)
        values (
          ${input.id}, ${scope.customerId}, ${input.phone}, ${input.codeHash},
          ${input.expiresAt.toISOString()}::timestamptz
        )
        on conflict (id) do nothing
        returning ${CHALLENGE_COLUMNS}
      `);
      const [row] = rows;
      if (row !== undefined) {
        // Only the challenges that began before this transaction (created_at is now(), its start):
        // a send that began first but commits last must not close the newer challenge.
        await scope.tx.execute(sql`
          update otp_challenges o set consumed_at = ${input.now.toISOString()}::timestamptz
          where o.customer_id = ${scope.customerId}::uuid and o.id <> ${input.id}::uuid
            and o.consumed_at is null and o.created_at < now()
        `);
        return created(toChallenge(row));
      }
      const existing = await scope.tx.execute<RawChallenge>(sql`
        select ${CHALLENGE_COLUMNS} from otp_challenges o
        where o.id = ${input.id}::uuid and o.customer_id = ${scope.customerId}::uuid
      `);
      const [found] = existing.rows;
      // No row: the id belongs to another customer. The answer is the same as for another number.
      if (found === undefined || found.phone !== input.phone) return refused("conflict");
      return replayed(toChallenge(found));
    },

    // Only the newest challenge of the customer is a candidate, and only while it is open, inside
    // the window and with attempts left. Under READ COMMITTED concurrent claims queue on the row lock
    // and each re-checks the condition on the latest version, so at most maxAttempts succeed.
    claimAttempt: async (input) => {
      if (
        !Number.isInteger(input.maxAttempts) ||
        input.maxAttempts < 1 ||
        input.maxAttempts > 100
      ) {
        throw new TypeError("otp.claimAttempt: maxAttempts must be an integer from 1 to 100");
      }
      const { rows } = await scope.tx.execute<{
        id: string;
        phone: string;
        codeHash: string;
        attempts: number;
      }>(sql`
        update otp_challenges o set attempts = o.attempts + 1
        where o.id = (
            select c.id from otp_challenges c
            where c.customer_id = ${scope.customerId}::uuid
            order by c.created_at desc, c.id desc limit 1
          )
          and o.customer_id = ${scope.customerId}::uuid and o.consumed_at is null
          and o.expires_at > ${input.now.toISOString()}::timestamptz
          and o.expires_at <= ${input.latestExpiry.toISOString()}::timestamptz
          and o.attempts < ${input.maxAttempts}::int
        returning o.id, o.phone, o.code_hash as "codeHash", o.attempts
      `);
      const [row] = rows;
      return row === undefined ? refused("not_found") : created(row);
    },

    // Closed already, someone else's, or missing: one answer.
    close: async (id, at) => {
      if (!isUuid(id)) return refused("not_found");
      const { rows } = await scope.tx.execute<{ id: string }>(sql`
        update otp_challenges o set consumed_at = ${at.toISOString()}::timestamptz
        where o.id = ${id}::uuid and o.customer_id = ${scope.customerId}::uuid
          and o.consumed_at is null
        returning o.id
      `);
      const [row] = rows;
      return row === undefined ? refused("not_found") : created({ id: row.id });
    },

    latest: async () => {
      const { rows } = await scope.tx.execute<RawChallenge>(sql`
        select ${CHALLENGE_COLUMNS} from otp_challenges o
        where o.customer_id = ${scope.customerId}::uuid
        order by o.created_at desc, o.id desc limit 1
      `);
      const [row] = rows;
      return row === undefined ? null : toChallenge(row);
    },
  };
}
