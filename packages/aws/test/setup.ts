import { afterAll } from "vitest";
import { installNetworkGuard } from "./network-guard";

// First statement: nothing below may open a connection.
const restoreNetwork = installNetworkGuard();
afterAll(restoreNetwork);

// The SDK's default credential chain reads the environment first, so these fake values are the
// base credentials and no file of the developer is read (R3). Set before any SDK import.
process.env.AWS_ACCESS_KEY_ID = "test-base-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-base-secret";
process.env.AWS_SESSION_TOKEN = "test-base-session";
process.env.AWS_CONFIG_FILE = "/nonexistent/tc-aws-test";
process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/tc-aws-test";
process.env.AWS_EC2_METADATA_DISABLED = "true";
for (const name of [
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
]) {
  delete process.env[name];
}
