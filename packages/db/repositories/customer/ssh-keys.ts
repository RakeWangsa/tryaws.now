import { and, asc, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { sshKeys } from "../../schema/index";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// A public key of the customer (public keys only: a private key never reaches the platform).
export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  createdAt: Date;
}

// The caller computes the fingerprint from the key (WP4-T7); the repository does not parse keys.
export interface NewSshKey {
  name: string;
  publicKey: string;
  fingerprint: string;
}

export interface SshKeysRepo {
  list(): Promise<SshKey[]>;
  get(id: string): Promise<SshKey | null>;
  add(input: NewSshKey): Promise<Written<SshKey>>;
  remove(id: string): Promise<Written<{ id: string }>>;
}

// Selected and returned by name: customer_id stays inside the repository.
const KEY_COLUMNS = {
  id: sshKeys.id,
  name: sshKeys.name,
  publicKey: sshKeys.publicKey,
  fingerprint: sshKeys.fingerprint,
  createdAt: sshKeys.createdAt,
};

// The row of the raw insert below. A raw tx.execute gives created_at as the text PostgreSQL prints,
// where a Drizzle select gives a Date, so add maps it with new Date (a type alias, not an interface:
// execute wants a Record<string, unknown>).
type RawSshKey = {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
};

export function sshKeysRepo(scope: TenantScope): SshKeysRepo {
  return {
    // async, so that the caller gets a real Promise and not Drizzle's lazy query builder.
    list: async () =>
      scope.tx
        .select(KEY_COLUMNS)
        .from(sshKeys)
        .where(eq(sshKeys.customerId, scope.customerId))
        .orderBy(asc(sshKeys.createdAt), asc(sshKeys.id)),

    // An id that is not a UUID is not found, as a missing row is, and sends no query (22P02 would be
    // a different answer).
    get: async (id) => {
      if (!isUuid(id)) return null;
      const [row] = await scope.tx
        .select(KEY_COLUMNS)
        .from(sshKeys)
        .where(and(eq(sshKeys.id, id), eq(sshKeys.customerId, scope.customerId)));
      return row ?? null;
    },

    // Idempotent by ssh_keys_customer_id_fingerprint_unique (R7): the same key again gives the earlier
    // row as a replay, the same fingerprint with another name or key is a conflict. ON CONFLICT DO
    // NOTHING, never a caught 23505: a unique violation would abort the caller's whole transaction.
    add: async (input) => {
      // The sql template names the five columns that web_rw may insert. A Drizzle insert() names
      // created_at as well (the value default), which web_rw may not insert: 42501.
      const { rows } = await scope.tx.execute<RawSshKey>(sql`
        insert into ssh_keys (id, customer_id, name, public_key, fingerprint)
        values (
          ${uuidv7()}, ${scope.customerId}, ${input.name}, ${input.publicKey}, ${input.fingerprint}
        )
        on conflict (customer_id, fingerprint) do nothing
        returning id, name, public_key as "publicKey", fingerprint, created_at as "createdAt"
      `);
      const [row] = rows;
      if (row !== undefined) return created({ ...row, createdAt: new Date(row.createdAt) });

      const [existing] = await scope.tx
        .select(KEY_COLUMNS)
        .from(sshKeys)
        .where(
          and(eq(sshKeys.customerId, scope.customerId), eq(sshKeys.fingerprint, input.fingerprint)),
        );
      // No existing key: a remove of it slipped in between the two statements. Fail closed (R16);
      // the caller may send the request again.
      if (existing === undefined) return refused("conflict");
      return existing.name === input.name && existing.publicKey === input.publicKey
        ? replayed(existing)
        : refused("conflict");
    },

    // A second remove of the same key finds nothing: not_found, and the state is the same.
    remove: async (id) => {
      if (!isUuid(id)) return refused("not_found");
      const [row] = await scope.tx
        .delete(sshKeys)
        .where(and(eq(sshKeys.id, id), eq(sshKeys.customerId, scope.customerId)))
        .returning({ id: sshKeys.id });
      return row === undefined ? refused("not_found") : created({ id: row.id });
    },
  };
}
