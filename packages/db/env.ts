// A local development value, not a secret (the password belongs to docker-compose.yml).
export const LOCAL_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/ticoncloud";

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  return url !== undefined && url !== "" ? url : LOCAL_DATABASE_URL;
}
