import { describe, expect, it } from "vitest";
import { isDevUiEnabled } from "./dev-ui.ts";

describe("isDevUiEnabled", () => {
  it.each([
    [{ NODE_ENV: "development" }, true],
    [{ NODE_ENV: "test" }, true],
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production", TC_DEV_UI: "on" }, true],
    [{ NODE_ENV: "production", TC_DEV_UI: "on", TC_STAGE: "production" }, false],
    [{}, false],
    [{ TC_DEV_UI: "yes" }, false],
    [{ NODE_ENV: "development", TC_STAGE: "production" }, false],
    [{ TC_DEV_UI: "on" }, true],
    [{ NODE_ENV: "production", TC_STAGE: "staging" }, false],
  ] as const)("%j gives %s", (env, expected) => {
    expect(isDevUiEnabled(env)).toBe(expected);
  });
});
