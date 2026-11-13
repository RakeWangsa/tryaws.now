import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export interface MigrationFileHash {
  /** The `when` of the journal entry; drizzle stores it as created_at of the applied row. */
  readonly folderMillis: number;
  /** sha256 of the file text, exactly the value drizzle stores in the `hash` column. */
  readonly hash: string;
}

/**
 * The hash of every migration file of a folder, in journal order (WPU-D2, audit C.14). drizzle records
 * this hash of each applied migration in drizzle.__drizzle_migrations but never compares it again, so
 * the migrator compares it before it migrates: an applied file that was edited is refused (R15).
 */
export function readMigrationHashes(folder: string = MIGRATIONS_FOLDER): MigrationFileHash[] {
  return readMigrationFiles({ migrationsFolder: folder }).map((m) => ({
    folderMillis: m.folderMillis,
    hash: m.hash,
  }));
}

// `folder` is for a bundled Lambda (the migrator), where the folder is copied next to the code and
// import.meta.url no longer points into packages/db.
export async function runMigrations(
  url: string,
  folder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const { db, pool } = createDatabase(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    // pool.end() resolves before the sockets are closed; if the server drops the connection in that
    // moment (a test database dropped with FORCE), the pool emits "error", and a pool nobody listens
    // to makes Node throw it as an uncaught exception (57P01). The pool is being closed: ignore it.
    pool.on("error", () => undefined);
    await pool.end();
  }
}
