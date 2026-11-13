import { Resource } from "sst/resource";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseUrl, DATABASE_URL_ERROR } from "../env";
import { sealSstLinks, type SealedSstLinks } from "../testing/sst-links";

// WPU-Z15: when the SST SDK cannot load the links (here the key does not open the link file, as after
// a key mismatch), every link reads as missing and the database URL fails closed with the fixed
// message, which holds neither the password nor the error of the SDK (R3, R14, R16). The SDK loads its
// links once per process, so this file holds this one scenario. A fake password (R3).
const PASSWORD = "fake-password-never-shown";
const DEPLOYED = {
  TC_STAGE: "production",
  DB_HOST: "proxy.example.test",
  DB_PORT: "5432",
  DB_NAME: "ticoncloud",
  DB_USER: "worker_rw",
  DB_PASSWORD_SECRET: "DbPasswordWorkerRw",
};

let sealed: SealedSstLinks;
beforeAll(() => {
  sealed = sealSstLinks({ DbPasswordWorkerRw: { type: "sst.sst.Secret", value: PASSWORD } });
  vi.stubEnv("SST_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("SST_KEY_FILE", sealed.env.SST_KEY_FILE);
});
afterAll(() => {
  vi.unstubAllEnvs();
  sealed.remove();
});

it("the SDK itself throws on this file, so the refusal below is the reader's own", () => {
  expect(() => "DbPasswordWorkerRw" in (Resource as object)).toThrow();
});

it("a link file that does not open is no link: the fixed message, no value, no cause", () => {
  // Twice: the SDK tries to load again on every read while its links cannot be loaded.
  for (const attempt of [1, 2]) {
    let caught: unknown;
    try {
      databaseUrl(DEPLOYED);
    } catch (error) {
      caught = error;
    }
    expect(caught, String(attempt)).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(DATABASE_URL_ERROR);
    expect((caught as Error).cause).toBeUndefined();
    expect(String((caught as Error).stack)).not.toContain(PASSWORD);
  }
});
