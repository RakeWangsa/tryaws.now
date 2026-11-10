import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const { db, pool } = createDatabase(url);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
