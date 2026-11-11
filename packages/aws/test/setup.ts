import { afterAll } from "vitest";
import { resetAwsEnvironment } from "./aws-env";
import { blockedConnections, installNetworkGuard } from "./network-guard";

// First statement: nothing below may open a connection.
const restoreNetwork = installNetworkGuard();
afterAll(restoreNetwork);
blockedConnections.length = 0;

// The SDK's default credential chain reads the environment first, so the fake values are the
// base credentials and no file or setting of the developer is read (R3). Set before any SDK import.
resetAwsEnvironment(process.env);
