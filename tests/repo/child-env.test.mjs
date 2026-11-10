import { afterEach, expect, it, vi } from "vitest";
import { GIT_REPO_VARS, childEnv } from "./child-env.mjs";

afterEach(() => vi.unstubAllEnvs());

it("names the five variables with which git finds a repository", () => {
  expect(GIT_REPO_VARS).toEqual([
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
  ]);
});
it("drops git's repository variables and keeps the rest", () => {
  for (const name of GIT_REPO_VARS) vi.stubEnv(name, "/somewhere/else");
  vi.stubEnv("TC_KEEP_ME", "1");
  const env = childEnv({ EXTRA: "2" });
  for (const name of GIT_REPO_VARS) expect(env, name).not.toHaveProperty(name);
  expect(env.TC_KEEP_ME).toBe("1");
  expect(env.EXTRA).toBe("2");
  expect(env.PATH).toBe(process.env.PATH);
});
it("an explicit value never brings a repository variable back", () => {
  expect(childEnv({ GIT_DIR: "/x" })).not.toHaveProperty("GIT_DIR");
});
