import {
  CheckDomainAvailabilityCommand,
  GetContactReachabilityStatusCommand,
  GetDomainDetailCommand,
  GetDomainPricesCommand,
  GetOperationDetailCommand,
  ListPricesCommand,
  RegisterDomainCommand,
  RenewDomainCommand,
  ResendContactReachabilityEmailCommand,
  Route53DomainsClient,
  UpdateDomainNameserversCommand,
  type ContactDetail,
} from "@aws-sdk/client-route-53-domains";
import type {
  ContactReachability,
  DomainAvailability,
  DomainDetail,
  DomainOperationStatus,
  DomainsPort,
} from "./adapters/domains-port";
import { parseTldPrices, type TldPrice } from "./tld-prices";
import { AwsError, operationOf, toAwsError } from "./errors";
import { clientSettings } from "./settings";
import type { AwsRequestHandler } from "./types";

// WPU-B2: Amazon Route 53 Domains behind `DomainsPort`. Route 53 Domains has one endpoint, us-east-1, and
// every call is made in the tc-dns account with temporary credentials from STS AssumeRole (TcDnsProvisioner
// for writes, TcDnsReader for reads; R3). This file takes the credentials as an argument and never reads
// the environment; the role wiring is the caller's (functions/provisioner, JOURNEY Needs decision).
// Nothing here logs or returns AWS text (U6, R14): every failure is an `AwsError`.
//
// WPU-Z19, checked against the Route 53 Domains API reference on 2026-11-14 (verify review 2026-11-13): the
// `Availability` words (CheckDomainAvailability) and the `OperationStatus` words; GetDomainDetail answers
// `InvalidInput` for a name this account does not hold (there is no DomainNotFound error); GetContactReachabilityStatus
// takes `domainName` and answers `status` (PENDING, DONE, EXPIRED); a second RegisterDomain gets `DuplicateRequest`;
// RenewDomain needs `CurrentExpiryYear`. A registry premium name answers AVAILABLE with `Price.PriceType`
// REGISTRY_PREMIUM; `Consent` (Currency, MaxPrice) caps what RegisterDomain and RenewDomain may charge. Still open in
// tc-dns (no call was made): what a standard .com answer of CheckDomainAvailability holds, and whether MaxPrice is per
// year or for the whole term (the platform sells one year, so the two are the same today).

export const DOMAINS_REGION = "us-east-1";
const MAX_PRICE_PAGES = 50;
const NAME_SERVER = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

/** The one method of the SDK client that this file uses; tests pass a fake. */
export interface DomainsSender {
  send(command: unknown): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(operation: string): AwsError {
  return new AwsError({
    code: "upstream_unavailable",
    retryable: true,
    operation,
    reason: "catalog_response_invalid",
  });
}

function errorName(error: unknown): string | null {
  return isRecord(error) && typeof error["name"] === "string" ? error["name"] : null;
}

/**
 * The refusals of Route 53 Domains that the general table does not know, by operation. WPU-X10: also the mapper of
 * the error middleware of `route53Domains()` (access.ts), so the meaning is the same whichever layer maps first.
 */
export function mapDomainsError(error: unknown, operation: string | null): AwsError {
  if (error instanceof AwsError) return error;
  const name = errorName(error);
  const plain = (code: "conflict" | "validation" | "not_found", retryable: boolean) =>
    new AwsError({ code, retryable, awsErrorName: name, operation, mayHaveActed: false });
  switch (name) {
    // A second RegisterDomain while the first runs: the caller looks again before it goes on.
    case "DuplicateRequest":
      return plain("conflict", true);
    // WPU-Z13: too many operations running in the account passes. A renewal that ends failed gives the customer's
    // money back and lets the name lapse, so on RenewDomain it is retried (10.1: an admin decides after the fifth).
    case "OperationLimitExceeded":
      return plain("conflict", operation === "RenewDomain");
    case "DomainLimitExceeded":
    case "TLDRulesViolation":
      return plain("conflict", false);
    case "UnsupportedTLD":
      return plain("validation", false);
    // WPU-Z19: "The top-level domain is currently undergoing maintenance and the request cannot be processed. Try
    // again later." Nothing was done: retried.
    case "TLDInMaintenance":
      return new AwsError({
        code: "upstream_unavailable",
        retryable: true,
        awsErrorName: name,
        operation,
        mayHaveActed: false,
      });
    case "InvalidInput":
      // On a change of a domain, "invalid input" is how Route 53 Domains says that the name is not in this account
      // (the reference: "it might not be a valid domain name or belong to the requester account"; there is no
      // DomainNotFound); on the others it is a bad argument.
      return operation === "ResendContactReachabilityEmail" || operation === "RenewDomain"
        ? plain("not_found", false)
        : plain("validation", false);
    default:
      return toAwsError(error, operation);
  }
}

/**
 * The word of CheckDomainAvailability. AVAILABLE is "available" only together with its price type (see
 * `priceTypeOf`); here it is "check_price". UNAVAILABLE_PREMIUM means "The domain name is not available" (the
 * reference); a registry premium name answers AVAILABLE with PriceType REGISTRY_PREMIUM. PENDING ("You can resubmit
 * the request immediately") and DONT_KNOW are "unknown"; INVALID_NAME_FOR_TLD is "unavailable".
 */
function availabilityOf(value: unknown): DomainAvailability | "check_price" {
  switch (value) {
    case "AVAILABLE":
      return "check_price";
    case "DONT_KNOW":
    case "PENDING":
      return "unknown";
    case "UNAVAILABLE":
    case "UNAVAILABLE_PREMIUM":
    case "RESERVED":
    case "UNAVAILABLE_RESTRICTED":
    case "AVAILABLE_RESERVED":
    case "AVAILABLE_PREORDER":
    case "INVALID_NAME_FOR_TLD":
      return "unavailable";
    default:
      // A word that is new to us is not "available" (R16).
      return "unknown";
  }
}

/** STANDARD is "available", REGISTRY_PREMIUM is "premium"; a missing or new type is not known (null). */
function priceTypeOf(price: unknown): "available" | "premium" | null {
  const type = isRecord(price) ? price["PriceType"] : undefined;
  if (type === "STANDARD") return "available";
  if (type === "REGISTRY_PREMIUM") return "premium";
  return null;
}

// The USD price the order charged, as the decimal text of the order (R4: no money math here). It becomes the
// Double of Consent.MaxPrice only at the SDK boundary.
const USD_TEXT = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/;

function consentOf(maxPriceUsd: unknown, operation: string) {
  if (
    typeof maxPriceUsd !== "string" ||
    !USD_TEXT.test(maxPriceUsd) ||
    !/[1-9]/.test(maxPriceUsd)
  ) {
    throw new AwsError({ code: "validation", retryable: false, operation, mayHaveActed: false });
  }
  return { Currency: "USD", MaxPrice: Number(maxPriceUsd) };
}

function operationStatusOf(value: unknown, operation: string): DomainOperationStatus {
  switch (value) {
    case "SUBMITTED":
    case "IN_PROGRESS":
      return "in_progress";
    case "SUCCESSFUL":
      return "successful";
    // WPU-Y2 fix round 1: the API reference lists both words without defining them; only FAILED is final.
    case "ERROR":
      return "error";
    case "FAILED":
      return "failed";
    default:
      throw new AwsError({
        code: "upstream_unavailable",
        retryable: true,
        operation,
        reason: "catalog_response_invalid",
      });
  }
}

function reachabilityOf(value: unknown): ContactReachability {
  switch (value) {
    case "PENDING":
      return "pending";
    case "DONE":
      return "done";
    case "EXPIRED":
      return "expired";
    default:
      return "unknown";
  }
}

function contactDetail(contact: {
  readonly contactType: "PERSON" | "COMPANY";
  readonly firstName: string;
  readonly lastName: string;
  readonly organizationName?: string;
  readonly email: string;
  readonly phoneNumber: string;
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly state: string;
  readonly countryCode: string;
  readonly zipCode: string;
}): ContactDetail {
  return {
    ContactType: contact.contactType,
    FirstName: contact.firstName,
    LastName: contact.lastName,
    ...(contact.organizationName === undefined
      ? {}
      : { OrganizationName: contact.organizationName }),
    Email: contact.email,
    PhoneNumber: contact.phoneNumber,
    AddressLine1: contact.addressLine1,
    ...(contact.addressLine2 === undefined ? {} : { AddressLine2: contact.addressLine2 }),
    City: contact.city,
    State: contact.state,
    CountryCode: contact.countryCode as ContactDetail["CountryCode"],
    ZipCode: contact.zipCode,
  };
}

function operationIdOf(response: unknown, operation: string): { readonly operationId: string } {
  const id = isRecord(response) ? response["OperationId"] : undefined;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(id)) throw invalid(operation);
  return { operationId: id };
}

export function createRoute53DomainsPort(client: DomainsSender): DomainsPort {
  async function call(command: object): Promise<unknown> {
    const operation = operationOf((command as { constructor: { name: string } }).constructor.name);
    try {
      return await client.send(command);
    } catch (error) {
      throw mapDomainsError(error, operation);
    }
  }

  return {
    async checkAvailability(name) {
      const response = await call(new CheckDomainAvailabilityCommand({ DomainName: name }));
      const word = availabilityOf(isRecord(response) ? response["Availability"] : undefined);
      if (word !== "check_price") return word;
      const priced = priceTypeOf(isRecord(response) ? response["Price"] : undefined);
      if (priced !== null) return priced;
      // AVAILABLE without a price type (PriceType is optional): GetDomainPrices of the name decides. Still unclear
      // is "unknown", which refuses this name now and never every name (R16).
      const prices = await call(new GetDomainPricesCommand({ DomainName: name }));
      const domainPrice = isRecord(prices) ? prices["DomainPrice"] : undefined;
      return (
        priceTypeOf(isRecord(domainPrice) ? domainPrice["RegistrationPrice"] : undefined) ??
        "unknown"
      );
    },

    async listPrices() {
      const out: TldPrice[] = [];
      let marker: string | undefined;
      for (let page = 0; page < MAX_PRICE_PAGES; page += 1) {
        const response = await call(
          new ListPricesCommand(marker === undefined ? {} : { Marker: marker }),
        );
        let parsed: ReturnType<typeof parseTldPrices>;
        try {
          parsed = parseTldPrices(response);
        } catch {
          throw invalid("ListPrices");
        }
        out.push(...parsed.prices);
        if (parsed.next === undefined || parsed.next === "") return out;
        marker = parsed.next;
      }
      // A marker that never ends must not loop (R16).
      throw new AwsError({
        code: "internal",
        retryable: true,
        reason: "catalog_pages_exceeded",
        operation: "ListPrices",
      });
    },

    async registerDomain(input) {
      const consent = consentOf(input.maxPriceUsd, "RegisterDomain");
      const contact = contactDetail(input.contact);
      // "You must specify the same privacy setting for the administrative, billing, registrant, and technical
      // contacts": the billing contact is the same contact with privacy on, like the other three.
      const response = await call(
        new RegisterDomainCommand({
          DomainName: input.name,
          DurationInYears: input.years,
          AutoRenew: false,
          AdminContact: contact,
          RegistrantContact: contact,
          TechContact: contact,
          BillingContact: contact,
          PrivacyProtectAdminContact: true,
          PrivacyProtectRegistrantContact: true,
          PrivacyProtectTechContact: true,
          PrivacyProtectBillingContact: true,
          Consent: consent,
        }),
      );
      return operationIdOf(response, "RegisterDomain");
    },

    async getOperationDetail(operationId) {
      const response = await call(new GetOperationDetailCommand({ OperationId: operationId }));
      // The message of AWS is read by nobody: only the status leaves (U6).
      return {
        status: operationStatusOf(
          isRecord(response) ? response["Status"] : undefined,
          "GetOperationDetail",
        ),
      };
    },

    async renewDomain(input) {
      const consent = consentOf(input.maxPriceUsd, "RenewDomain");
      const response = await call(
        new RenewDomainCommand({
          DomainName: input.name,
          DurationInYears: input.years,
          CurrentExpiryYear: input.currentExpiryYear,
          Consent: consent,
        }),
      );
      return operationIdOf(response, "RenewDomain");
    },

    async getDomainDetail(name): Promise<DomainDetail | null> {
      let response: unknown;
      try {
        response = await call(new GetDomainDetailCommand({ DomainName: name }));
      } catch (error) {
        // "Not in this account" is an answer, not an error: Route 53 Domains has no DomainNotFound; InvalidInput "For a
        // domain name, it might not be a valid domain name or belong to the requester account" (reference).
        if (error instanceof AwsError && error.awsErrorName === "InvalidInput") return null;
        throw error;
      }
      if (!isRecord(response)) throw invalid("GetDomainDetail");
      const servers = response["Nameservers"];
      if (!Array.isArray(servers)) throw invalid("GetDomainDetail");
      const nameServers = servers.map((item) => {
        const raw = isRecord(item) ? item["Name"] : undefined;
        const host = typeof raw === "string" ? raw.toLowerCase().replace(/\.$/, "") : "";
        if (!NAME_SERVER.test(host)) throw invalid("GetDomainDetail");
        return host;
      });
      const expiry = response["ExpirationDate"];
      if (expiry !== undefined && (!(expiry instanceof Date) || Number.isNaN(expiry.getTime()))) {
        throw invalid("GetDomainDetail");
      }
      // The e-mail check is a second call. If it fails the state is unknown, never "done" (R16).
      const reachability: ContactReachability = await call(
        new GetContactReachabilityStatusCommand({ domainName: name }),
      ).then(
        (status) => reachabilityOf(isRecord(status) ? status["status"] : undefined),
        () => "unknown" as const,
      );
      return {
        name: name.toLowerCase(),
        expiresAt: expiry instanceof Date ? expiry : null,
        nameServers,
        reachability,
      };
    },

    async resendContactReachabilityEmail(name) {
      await call(new ResendContactReachabilityEmailCommand({ domainName: name }));
    },

    async updateNameServers(name, servers) {
      const response = await call(
        new UpdateDomainNameserversCommand({
          DomainName: name,
          Nameservers: servers.map((server) => ({ Name: server })),
        }),
      );
      return operationIdOf(response, "UpdateDomainNameservers");
    },
  };
}

type Credentials = NonNullable<
  ConstructorParameters<typeof Route53DomainsClient>[0]
>["credentials"];

export interface DomainsClientOptions {
  /** Temporary credentials of the tc-dns account (STS AssumeRole). The caller owns the cache. */
  readonly credentials: Credentials;
  /** For tests only. */
  readonly requestHandler?: AwsRequestHandler;
}

/**
 * The SDK client for Route 53 Domains in us-east-1. `role` decides the retry kind (a mutating role repeats a
 * throttled call only). No `logger`: the SDK's logger would write the raw AWS error text (R14).
 */
export function createRoute53DomainsClient(
  role: "TcDnsProvisioner" | "TcDnsReader",
  options: DomainsClientOptions,
): Route53DomainsClient {
  const settings = clientSettings(role);
  return new Route53DomainsClient({
    region: DOMAINS_REGION,
    credentials: options.credentials,
    ...settings,
    ...(options.requestHandler ? { requestHandler: options.requestHandler } : {}),
  } as NonNullable<ConstructorParameters<typeof Route53DomainsClient>[0]>);
}
