import { expect, it } from "vitest";
import { TEST_AWS_ENV, resetAwsEnvironment } from "./aws-env";

it("removes every AWS variable of the shell and sets the six fake ones", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    AWS_PROFILE: "prod",
    AWS_ACCESS_KEY_ID: "real-looking-key",
    AWS_ENDPOINT_URL: "http://127.0.0.1:9",
    AWS_ENDPOINT_URL_STS: "http://127.0.0.1:9",
    AWS_USE_FIPS_ENDPOINT: "true",
    AWS_USE_DUALSTACK_ENDPOINT: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_RETRY_MODE: "adaptive",
    AWS_REGION: "eu-west-1",
    AWS_SOMETHING_NEW: "x",
  };
  resetAwsEnvironment(env);
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", ...TEST_AWS_ENV });
  expect(Object.keys(TEST_AWS_ENV).sort()).toEqual([
    "AWS_ACCESS_KEY_ID",
    "AWS_CONFIG_FILE",
    "AWS_EC2_METADATA_DISABLED",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SHARED_CREDENTIALS_FILE",
  ]);
  expect(TEST_AWS_ENV.AWS_ACCESS_KEY_ID).toBe("test-base-access-key");
  expect(Object.isFrozen(TEST_AWS_ENV)).toBe(true);
});

it("the process of this test run holds no AWS variable but the six", () => {
  const names = Object.keys(process.env).filter((name) => name.startsWith("AWS_"));
  expect(names.sort()).toEqual(Object.keys(TEST_AWS_ENV).sort());
});
