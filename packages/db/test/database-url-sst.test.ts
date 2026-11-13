import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseUrl, DATABASE_URL_ERROR } from "../env";
import { sealSstLinks, type SealedSstLinks } from "../testing/sst-links";

// WPU-Z15 (B4): a function deployed by SST 4.17.2 gets its links only in the encrypted link file
// (SST_KEY_FILE, SST_KEY); no SST_RESOURCE_<Name> variable holds them at run time. The SST SDK loads
// its links once per process, so this file holds this one scenario. A fake password (R3).
const PASSWORD = "fake:pw/for#tests?only";
const DEPLOYED = {
  TC_STAGE: "staging",
  DB_HOST: "proxy.example.test",
  DB_PORT: "5432",
  DB_NAME: "ticoncloud",
  DB_USER: "worker_rw",
  DB_PASSWORD_SECRET: "DbPasswordWorkerRw",
};

let sealed: SealedSstLinks;
beforeAll(() => {
  sealed = sealSstLinks({
    App: { name: "ticoncloud", stage: "staging" },
    DbPasswordWorkerRw: { type: "sst.sst.Secret", value: PASSWORD },
  });
  vi.stubEnv("SST_KEY", sealed.env.SST_KEY);
  vi.stubEnv("SST_KEY_FILE", sealed.env.SST_KEY_FILE);
});
afterAll(() => {
  vi.unstubAllEnvs();
  sealed.remove();
});

it("reads the password of the role from the encrypted link file at run time", () => {
  expect(Object.keys(process.env).filter((name) => name.startsWith("SST_RESOURCE_"))).toEqual([]);
  const url = new URL(databaseUrl(DEPLOYED));
  expect(url.username).toBe("worker_rw");
  expect(decodeURIComponent(url.password)).toBe(PASSWORD);
  expect(url.searchParams.get("sslmode")).toBe("verify-full");
});

it("a secret that is not linked to the function fails closed with the fixed message", () => {
  let message = "";
  try {
    databaseUrl({ ...DEPLOYED, DB_USER: "web_rw", DB_PASSWORD_SECRET: "DbPasswordWebRw" });
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toBe(DATABASE_URL_ERROR);
});
