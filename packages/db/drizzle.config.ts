import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./env";

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: databaseUrl() },
  strict: true,
  verbose: true,
});
