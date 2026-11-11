/** The only AWS variables a test of this package sees. All values are fake (R3). */
export const TEST_AWS_ENV: Readonly<Record<string, string>> = Object.freeze({
  AWS_ACCESS_KEY_ID: "test-base-access-key",
  AWS_SECRET_ACCESS_KEY: "test-base-secret",
  AWS_SESSION_TOKEN: "test-base-session",
  AWS_CONFIG_FILE: "/nonexistent/tc-aws-test",
  AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/tc-aws-test",
  AWS_EC2_METADATA_DISABLED: "true",
});

/**
 * Deletes every variable that starts with `AWS_` (profile, region, endpoint, FIPS, retry settings
 * and whatever a later SDK version reads), then sets the fixed fake ones.
 */
export function resetAwsEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith("AWS_")) delete env[name];
  }
  Object.assign(env, TEST_AWS_ENV);
}
