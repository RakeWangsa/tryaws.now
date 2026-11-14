import { afterEach, expect, it, vi } from "vitest";
import { handler } from "./index";
import { MIGRATOR_ERROR } from "./config";

afterEach(() => vi.unstubAllEnvs());

it("exports the handler that the stack wires", () => {
  expect(typeof handler).toBe("function");
});

it("fails closed when nothing is linked, with the fixed message", async () => {
  vi.stubEnv("SST_RESOURCE_Database", "");
  await expect(handler({ action: "migrate" })).rejects.toThrow(MIGRATOR_ERROR);
});

it("does not take the master user from DATABASE_URL", async () => {
  vi.stubEnv("SST_RESOURCE_Database", "");
  vi.stubEnv("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/postgres");
  await expect(handler({ action: "migrate" })).rejects.toThrow(MIGRATOR_ERROR);
});
