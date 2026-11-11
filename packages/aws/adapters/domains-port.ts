import type { RegistrantContact } from "@tc/core";
import type { TldPrice } from "../catalog";

// The part of Amazon Route 53 Domains that the domain adapter needs, as a port (WP7-T4).
//
// Route 53 Domains client not built: `@aws-sdk/client-route-53-domains` is not installed and could not be
// installed offline, and a new dependency needs a recorded reason (R17). The real client (a later task,
// "Needs decision" in JOURNEY) wraps it behind this interface and reaches the tc-dns account through STS
// AssumeRole (TcDnsProvisioner for writes, TcDnsReader for reads; R3) in us-east-1, the only endpoint of
// Route 53 Domains. Until then the adapter is tested against test/fake-domains.ts.
//
// Rules for an implementation (VERIFY each against the current Route 53 Domains API reference):
// - `checkAvailability` is CheckDomainAvailability. `AVAILABLE` is "available"; `UNAVAILABLE_PREMIUM` is
//   "premium" (refused, open item: premium names); every other answer except `AVAILABLE_RESERVED` and
//   `AVAILABLE_PREORDER` (also "unavailable") is "unavailable"; `DONT_KNOW` is "unknown".
// - `listPrices` follows `Marker` / `NextPageMarker` and returns every TLD (USD only; another currency is
//   never converted). The parse is `parseTldPrices` of catalog.ts.
// - `registerDomain` is RegisterDomain with `AutoRenew=false`, `DurationInYears=years`, privacy protection
//   on for the admin, registrant and tech contact where the TLD supports it, and the same contact for
//   the three. RegisterDomain has no client token: a repeat while the first is running fails with
//   `DuplicateRequest`, which an implementation maps to an AwsError with code "conflict".
// - `getOperationDetail` maps Status SUBMITTED / IN_PROGRESS / SUCCESSFUL / ERROR / FAILED. The message
//   of AWS never leaves the implementation (U6).
// - `renewDomain` is RenewDomain with `CurrentExpiryYear` read from GetDomainDetail.
// - `getDomainDetail` is GetDomainDetail plus GetContactReachabilityStatus. A domain that this account
//   does not hold is `null` (DomainNotFound is not an error here).
// - A refused change is an AwsError with code "conflict"; a missing domain on a write is "not_found".

export type DomainAvailability = "available" | "unavailable" | "premium" | "unknown";

export type DomainOperationStatus = "in_progress" | "successful" | "failed";

/** The state of the registrant's e-mail check (ICANN): until it is done the registry may suspend the name. */
export type ContactReachability = "pending" | "done" | "expired" | "unknown";

export interface DomainDetail {
  /** ASCII, lower case, no trailing dot. */
  readonly name: string;
  readonly expiresAt: Date | null;
  readonly nameServers: readonly string[];
  readonly reachability: ContactReachability;
}

export interface DomainsPort {
  checkAvailability(name: string): Promise<DomainAvailability>;
  listPrices(): Promise<readonly TldPrice[]>;
  registerDomain(input: {
    readonly name: string;
    readonly years: number;
    readonly contact: RegistrantContact;
  }): Promise<{ readonly operationId: string }>;
  getOperationDetail(operationId: string): Promise<{ readonly status: DomainOperationStatus }>;
  renewDomain(input: {
    readonly name: string;
    readonly years: number;
    readonly currentExpiryYear: number;
  }): Promise<{ readonly operationId: string }>;
  getDomainDetail(name: string): Promise<DomainDetail | null>;
  resendContactReachabilityEmail(name: string): Promise<void>;
}
