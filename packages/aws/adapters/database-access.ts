import { GetRelationalDatabaseMasterUserPasswordCommand } from "@aws-sdk/client-lightsail";
import { awsResourceName } from "@tc/core";
import type { AwsAccess } from "../access";
import { AwsError } from "../errors";
import type { AccountRef, LightsailRegion } from "../roles";
import { MASTER_USERNAME } from "./database";
import { isUuid } from "./shared";

export interface DatabasePasswordInput {
  readonly access: AwsAccess<"access-details">;
  readonly account: AccountRef;
  readonly region: LightsailRegion;
  /** The resource id of the database, already checked against the customer by the caller (R8). */
  readonly resourceId: string;
  /** The `resources.state` the caller read in the same tenant-scoped check. */
  readonly resourceState: string;
}

/** The only place a database password exists. The caller returns it once (U9) and drops it. */
export interface DatabasePassword {
  readonly username: string;
  readonly password: string;
}

/**
 * Reads the CURRENT master password of a database on demand and hands it to the caller. The user name
 * is the one the platform created the database with (a constant, `MASTER_USERNAME`), so the role needs
 * no more than this one read. The password is never stored, logged or put in an error (U9, R14).
 *
 * VERIFY against real Lightsail (tc-pool-dev): the response field `masterUserPassword`, that
 * `passwordVersion: "CURRENT"` is accepted, and that a restored database keeps the source password.
 */
export async function fetchDatabasePassword(
  input: DatabasePasswordInput,
): Promise<DatabasePassword> {
  if (!isUuid(input.resourceId)) throw new AwsError({ code: "validation", retryable: false });
  if (input.resourceState !== "active") throw new AwsError({ code: "conflict", retryable: false });
  const lightsail = input.access.lightsail(input.account, input.region, "TcAccessDetails");
  const got = await lightsail.send(
    new GetRelationalDatabaseMasterUserPasswordCommand({
      relationalDatabaseName: awsResourceName("database", input.resourceId),
      passwordVersion: "CURRENT",
    }),
  );
  const password = got.masterUserPassword;
  if (typeof password !== "string" || password === "") {
    throw new AwsError({ code: "upstream_unavailable", retryable: false });
  }
  return { username: MASTER_USERNAME, password };
}
