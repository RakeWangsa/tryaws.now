import type { RegistrantContact } from "@tc/core";
import type { TldPrice } from "../catalog";

// The part of Amazon Route 53 Domains that the domain adapter needs, as a port (WP7-T4).
//
// WPU-B2: the real client is `createRoute53DomainsPort` of ../domains-client.ts (dependency
// `@aws-sdk/client-route-53-domains`, reason in JOURNEY, R17). It reaches the tc-dns account through STS
// AssumeRole (TcDnsProvisioner for writes, TcDnsReader for reads; R3) in us-east-1, the only endpoint of
// Route 53 Domains; the credentials come from the caller. The adapter is tested against test/fake-domains.ts.
//
// Rules for an implementation (WPU-Z19: checked against the Route 53 Domains API reference on 2026-11-14):
// - `checkAvailability` is CheckDomainAvailability. A registry premium name answers `AVAILABLE` with
//   `Price.PriceType` REGISTRY_PREMIUM: that is "premium" (refused). `AVAILABLE` with PriceType STANDARD is
//   "available"; `AVAILABLE` without a price type is decided by GetDomainPrices of the name (RegistrationPrice
//   PriceType), and is "unknown" when that is still unclear (R16). `UNAVAILABLE_PREMIUM` ("The domain name is not
//   available"), `INVALID_NAME_FOR_TLD`, `AVAILABLE_RESERVED`, `AVAILABLE_PREORDER` and the other refusals are
//   "unavailable"; `DONT_KNOW` and `PENDING` (resubmit) are "unknown". TLDInMaintenance is a retryable failure.
// - `listPrices` follows `Marker` / `NextPageMarker` and returns every TLD (USD only; another currency is
//   never converted). ListPrices gives the standard rates only, never registry premium prices. The parse is
//   `parseTldPrices` of catalog.ts.
// - `registerDomain` is RegisterDomain with `AutoRenew=false` (the default is true), `DurationInYears=years`, the
//   same contact for admin, registrant, tech and billing, privacy protection on for all four ("the same privacy
//   setting for the administrative, billing, registrant, and technical contacts"), and `Consent` { Currency "USD",
//   MaxPrice `maxPriceUsd` }: the USD price the order charged, so the registration fails instead of costing more.
//   RegisterDomain has no client token: a repeat while the first is running fails with `DuplicateRequest`,
//   which an implementation maps to an AwsError with code "conflict".
// - `getOperationDetail` maps Status SUBMITTED / IN_PROGRESS / SUCCESSFUL / ERROR / FAILED. The message
//   of AWS never leaves the implementation (U6).
// - `updateNameServers` is UpdateDomainNameservers; it answers an operation that `getOperationDetail` follows.
// - `renewDomain` is RenewDomain with `CurrentExpiryYear` read from GetDomainDetail and the same `Consent`.
// - `getDomainDetail` is GetDomainDetail plus GetContactReachabilityStatus. A domain that this account
//   does not hold answers `InvalidInput` (there is no DomainNotFound error) and is `null` here.
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
    /** The USD price the order charged, as decimal text (Consent.MaxPrice). */
    readonly maxPriceUsd: string;
  }): Promise<{ readonly operationId: string }>;
  getOperationDetail(operationId: string): Promise<{ readonly status: DomainOperationStatus }>;
  renewDomain(input: {
    readonly name: string;
    readonly years: number;
    readonly currentExpiryYear: number;
    /** The USD price the renewal charged, as decimal text (Consent.MaxPrice). */
    readonly maxPriceUsd: string;
  }): Promise<{ readonly operationId: string }>;
  getDomainDetail(name: string): Promise<DomainDetail | null>;
  resendContactReachabilityEmail(name: string): Promise<void>;
  /** UpdateDomainNameservers: the servers are plain host names, lower case, no trailing dot. */
  updateNameServers(
    name: string,
    servers: readonly string[],
  ): Promise<{ readonly operationId: string }>;
}
