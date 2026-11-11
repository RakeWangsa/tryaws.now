import { GetInstanceAccessDetailsCommand } from "@aws-sdk/client-lightsail";
import { awsResourceName } from "@tc/core";
import type { AwsAccess } from "../access";
import { AwsError } from "../errors";
import type { AccountRef, LightsailRegion } from "../roles";
import { isUuid } from "./shared";

export interface WindowsPasswordInput {
  readonly access: AwsAccess<"access-details">;
  readonly account: AccountRef;
  readonly region: LightsailRegion;
  /** The resource id of the Windows instance, already checked against the customer by the caller (R8). */
  readonly resourceId: string;
  /** The `resources.state` the caller read in the same tenant-scoped check. */
  readonly resourceState: string;
}

/** The only place a Windows password exists. The caller returns it once (U9) and drops it. */
export interface WindowsPassword {
  readonly username: string;
  readonly password: string;
}

/**
 * Fetches the RDP user and password of a Windows instance on demand and hands them to the caller:
 * Lightsail decrypts the password for the pool's default key pair, so the platform holds no private
 * key (`DownloadDefaultKeyPair` is denied to every role). The password is never stored, logged or
 * put in an error (U9, R14).
 *
 * The caller (the access-details function) does the tenant check, the rate limit and the audit row.
 * The role's policy allows this call only on instances tagged `tc:os` = `windows` (6.3): for a Linux
 * instance the same call returns a temporary SSH key.
 *
 * VERIFY against real Lightsail (tc-pool-dev): that `password` comes back in clear for the default
 * key pair, and how long after launch it is available.
 */
export async function fetchWindowsPassword(input: WindowsPasswordInput): Promise<WindowsPassword> {
  if (!isUuid(input.resourceId)) throw new AwsError({ code: "validation", retryable: false });
  // A stopped, suspended or unfinished instance gets no password (R16).
  if (input.resourceState !== "active") {
    throw new AwsError({ code: "conflict", retryable: false });
  }
  const instanceName = awsResourceName("instance", input.resourceId);
  const lightsail = input.access.lightsail(input.account, input.region, "TcAccessDetails");
  const got = await lightsail.send(
    new GetInstanceAccessDetailsCommand({ instanceName, protocol: "rdp" }),
  );
  const details = got.accessDetails;
  const username = details?.username;
  const password = details?.password;
  // Encrypted password data means a key pair that is not the default one: nothing here can read it.
  if (
    typeof username !== "string" ||
    username === "" ||
    typeof password !== "string" ||
    password === ""
  ) {
    throw new AwsError({ code: "upstream_unavailable", retryable: false });
  }
  return { username, password };
}
