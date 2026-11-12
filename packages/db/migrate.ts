import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

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
    await pool.end();
  }
}
