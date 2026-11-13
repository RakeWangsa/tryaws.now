import { describe, expect, it } from "vitest";
import { AwsError } from "../errors";
import { createRoute53DomainsPort, type DomainsSender } from "../domains-client";

// WPU-B2: the Route 53 Domains client behind DomainsPort. No AWS call is made: a fake sender answers by the
// name of the command. The field names are those of @aws-sdk/client-route-53-domains 3.1166.0 (VERIFY
// against the first real answer in tc-dns, JOURNEY).

type Handler = (input: Record<string, unknown>) => unknown;

function sender(handlers: Record<string, Handler>) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const fake: DomainsSender = {
    async send(command) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`no handler for ${name}`);
      return handler(input);
    },
  };
  return { fake, calls };
}

function awsFailure(name: string, status = 400, message = "secret detail 123456789012") {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

const CONTACT = {
  contactType: "PERSON" as const,
  firstName: "Rahim",
  lastName: "Uddin",
  email: "rahim@example.com",
  phoneNumber: "+880.1712345678",
  addressLine1: "House 1, Road 2",
  city: "Dhaka",
  state: "Dhaka",
  countryCode: "BD",
  zipCode: "1212",
};

describe("checkAvailability", () => {
  // WPU-Z19: the words of the CheckDomainAvailability reference (read 2026-11-14). UNAVAILABLE_PREMIUM is "The domain
  // name is not available"; INVALID_NAME_FOR_TLD is a name the TLD refuses; PENDING asks for a new request. AVAILABLE
  // is decided by the price that comes with it (the next describe).
  const words: [string | undefined, string][] = [
    ["UNAVAILABLE_PREMIUM", "unavailable"],
    ["INVALID_NAME_FOR_TLD", "unavailable"],
    ["PENDING", "unknown"],
    ["UNAVAILABLE", "unavailable"],
    ["RESERVED", "unavailable"],
    ["UNAVAILABLE_RESTRICTED", "unavailable"],
    ["AVAILABLE_RESERVED", "unavailable"],
    ["AVAILABLE_PREORDER", "unavailable"],
    ["DONT_KNOW", "unknown"],
    ["SOMETHING_NEW", "unknown"],
    [undefined, "unknown"],
  ];
  for (const [aws, ours] of words) {
    it(`${String(aws)} is ${ours}`, async () => {
      const { fake, calls } = sender({
        CheckDomainAvailabilityCommand: () => ({ Availability: aws }),
      });
      expect(await createRoute53DomainsPort(fake).checkAvailability("shop.com")).toBe(ours);
      expect(calls[0]?.input).toEqual({ DomainName: "shop.com" });
    });
  }
});

describe("checkAvailability: AVAILABLE and the price type (WPU-Z19)", () => {
  const standard = { Currency: "USD", Price: 15, PriceType: "STANDARD" };
  const premium = { Currency: "USD", Price: 2500, PriceType: "REGISTRY_PREMIUM" };

  it("AVAILABLE at the standard rate is available, without a second call", async () => {
    const { fake, calls } = sender({
      CheckDomainAvailabilityCommand: () => ({ Availability: "AVAILABLE", Price: standard }),
    });
    expect(await createRoute53DomainsPort(fake).checkAvailability("shop.com")).toBe("available");
    expect(calls.map((c) => c.name)).toEqual(["CheckDomainAvailabilityCommand"]);
  });

  it("AVAILABLE with registry premium pricing is premium (refused by the adapter)", async () => {
    const { fake } = sender({
      CheckDomainAvailabilityCommand: () => ({ Availability: "AVAILABLE", Price: premium }),
    });
    expect(await createRoute53DomainsPort(fake).checkAvailability("shop.com")).toBe("premium");
  });

  it("AVAILABLE without a price type asks GetDomainPrices for the name", async () => {
    for (const [price, ours] of [
      [{ RegistrationPrice: standard }, "available"],
      [{ RegistrationPrice: premium }, "premium"],
      [{ RegistrationPrice: { Currency: "USD", Price: 15 } }, "unknown"],
      [{}, "unknown"],
    ] as const) {
      for (const first of [
        { Availability: "AVAILABLE" },
        { Availability: "AVAILABLE", Price: { Price: 15 } },
      ]) {
        const { fake, calls } = sender({
          CheckDomainAvailabilityCommand: () => first,
          GetDomainPricesCommand: () => ({ DomainPrice: { Name: "shop.com", ...price } }),
        });
        expect(await createRoute53DomainsPort(fake).checkAvailability("shop.com")).toBe(ours);
        expect(calls.map((c) => c.name)).toEqual([
          "CheckDomainAvailabilityCommand",
          "GetDomainPricesCommand",
        ]);
        expect(calls[1]?.input).toEqual({ DomainName: "shop.com" });
      }
    }
  });

  it("a GetDomainPrices that fails is thrown, never available (R16); TLDInMaintenance is retryable", async () => {
    const { fake } = sender({
      CheckDomainAvailabilityCommand: () => ({ Availability: "AVAILABLE" }),
      GetDomainPricesCommand: () => {
        throw awsFailure("TLDInMaintenance");
      },
    });
    const error = await createRoute53DomainsPort(fake)
      .checkAvailability("shop.com")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "upstream_unavailable", retryable: true });
    expect(JSON.stringify(error)).not.toContain("123456789012");
    const blocked = sender({
      CheckDomainAvailabilityCommand: () => {
        throw awsFailure("TLDInMaintenance");
      },
    });
    await expect(
      createRoute53DomainsPort(blocked.fake).checkAvailability("shop.com"),
    ).rejects.toMatchObject({ code: "upstream_unavailable", retryable: true });
  });
});

describe("listPrices", () => {
  it("follows NextPageMarker to the end and parses every page", async () => {
    const pages = [
      {
        Prices: [
          {
            Name: "com",
            RegistrationPrice: { Price: 15, Currency: "USD" },
            RenewalPrice: { Price: 15, Currency: "USD" },
          },
        ],
        NextPageMarker: "m1",
      },
      { Prices: [{ Name: "net", RegistrationPrice: { Price: 18, Currency: "USD" } }] },
    ];
    let i = 0;
    const { fake, calls } = sender({ ListPricesCommand: () => pages[i++] });
    const prices = await createRoute53DomainsPort(fake).listPrices();
    expect(prices.map((p) => p.tld)).toEqual(["com", "net"]);
    expect(calls.map((c) => c.input["Marker"])).toEqual([undefined, "m1"]);
  });

  it("stops a marker that never ends (R16)", async () => {
    const { fake } = sender({
      ListPricesCommand: () => ({ Prices: [], NextPageMarker: "again" }),
    });
    await expect(createRoute53DomainsPort(fake).listPrices()).rejects.toMatchObject({
      reason: "catalog_pages_exceeded",
    });
  });

  it("refuses an answer that is not a page", async () => {
    const { fake } = sender({ ListPricesCommand: () => ({}) });
    await expect(createRoute53DomainsPort(fake).listPrices()).rejects.toBeInstanceOf(AwsError);
  });
});

describe("registerDomain", () => {
  it("sends the same contact three times, privacy on, no auto renew, and returns the operation id", async () => {
    const { fake, calls } = sender({ RegisterDomainCommand: () => ({ OperationId: "op-123" }) });
    const result = await createRoute53DomainsPort(fake).registerDomain({
      name: "shop.com",
      years: 1,
      contact: CONTACT,
      maxPriceUsd: "15.0000",
    });
    expect(result).toEqual({ operationId: "op-123" });
    const input = calls[0]?.input ?? {};
    expect(input).toMatchObject({
      DomainName: "shop.com",
      DurationInYears: 1,
      AutoRenew: false,
      PrivacyProtectAdminContact: true,
      PrivacyProtectRegistrantContact: true,
      PrivacyProtectTechContact: true,
      // WPU-Z19: the billing contact too ("the same privacy setting for the administrative, billing, registrant,
      // and technical contacts"), and Consent: the USD price the order charged, so AWS never charges more.
      PrivacyProtectBillingContact: true,
      Consent: { Currency: "USD", MaxPrice: 15 },
    });
    expect(input["AdminContact"]).toEqual(input["RegistrantContact"]);
    expect(input["TechContact"]).toEqual(input["RegistrantContact"]);
    expect(input["BillingContact"]).toEqual(input["RegistrantContact"]);
    expect(input["RegistrantContact"]).toMatchObject({
      ContactType: "PERSON",
      FirstName: "Rahim",
      Email: "rahim@example.com",
      PhoneNumber: "+880.1712345678",
      CountryCode: "BD",
    });
  });

  it("maps DuplicateRequest to a conflict that carries no AWS text", async () => {
    const { fake } = sender({
      RegisterDomainCommand: () => {
        throw awsFailure("DuplicateRequest");
      },
    });
    const error = await createRoute53DomainsPort(fake)
      .registerDomain({ name: "shop.com", years: 1, contact: CONTACT, maxPriceUsd: "15" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsError);
    expect(error).toMatchObject({ code: "conflict", operation: "RegisterDomain" });
    expect(JSON.stringify(error)).not.toContain("secret detail");
    expect((error as Error).message).not.toContain("secret detail");
  });

  it("refuses an answer without an operation id", async () => {
    const { fake } = sender({ RegisterDomainCommand: () => ({}) });
    await expect(
      createRoute53DomainsPort(fake).registerDomain({
        name: "shop.com",
        years: 1,
        contact: CONTACT,
        maxPriceUsd: "15",
      }),
    ).rejects.toBeInstanceOf(AwsError);
  });
});

describe("getOperationDetail", () => {
  const words: [string, string][] = [
    ["SUBMITTED", "in_progress"],
    ["IN_PROGRESS", "in_progress"],
    ["SUCCESSFUL", "successful"],
    ["ERROR", "failed"],
    ["FAILED", "failed"],
  ];
  for (const [aws, ours] of words) {
    it(`${aws} is ${ours}, and the message of AWS is dropped`, async () => {
      const { fake } = sender({
        GetOperationDetailCommand: () => ({ Status: aws, Message: "private text" }),
      });
      const detail = await createRoute53DomainsPort(fake).getOperationDetail("op-1");
      expect(detail).toEqual({ status: ours });
    });
  }

  it("an unknown or missing status fails closed", async () => {
    for (const body of [{ Status: "NEW_WORD" }, {}]) {
      const { fake } = sender({ GetOperationDetailCommand: () => body });
      await expect(createRoute53DomainsPort(fake).getOperationDetail("op-1")).rejects.toMatchObject(
        {
          code: "upstream_unavailable",
        },
      );
    }
  });
});

describe("renewDomain", () => {
  it("sends the expiry year the caller read, so a repeat after a success is refused by Route 53", async () => {
    const { fake, calls } = sender({ RenewDomainCommand: () => ({ OperationId: "op-9" }) });
    expect(
      await createRoute53DomainsPort(fake).renewDomain({
        name: "shop.com",
        years: 1,
        currentExpiryYear: 2031,
        maxPriceUsd: "13.5000",
      }),
    ).toEqual({ operationId: "op-9" });
    expect(calls[0]?.input).toEqual({
      DomainName: "shop.com",
      DurationInYears: 1,
      CurrentExpiryYear: 2031,
      Consent: { Currency: "USD", MaxPrice: 13.5 },
    });
  });

  it("WPU-Z19: a USD price that is not a plain positive decimal is refused before any call (R16)", async () => {
    for (const maxPriceUsd of ["", "0", "0.0000", "-1", "1e3", "15.123456", "abc", " 15"]) {
      const { fake, calls } = sender({
        RenewDomainCommand: () => ({ OperationId: "op-9" }),
        RegisterDomainCommand: () => ({ OperationId: "op-1" }),
      });
      const port = createRoute53DomainsPort(fake);
      await expect(
        port.renewDomain({ name: "shop.com", years: 1, currentExpiryYear: 2031, maxPriceUsd }),
      ).rejects.toMatchObject({ code: "validation", retryable: false });
      await expect(
        port.registerDomain({ name: "shop.com", years: 1, contact: CONTACT, maxPriceUsd }),
      ).rejects.toMatchObject({ code: "validation", retryable: false });
      expect(calls).toEqual([]);
    }
  });

  // WPU-Z13: a renewal that ends failed gives the customer's money back, so only a real refusal may be final. Too
  // many operations running in the account passes (Route 53 Domains API reference, RenewDomain errors): retried.
  it("a limit of running operations is retried; a refusal of the registry is final", async () => {
    const renew = (name: string) =>
      createRoute53DomainsPort(
        sender({
          RenewDomainCommand: () => {
            throw awsFailure(name);
          },
        }).fake,
      ).renewDomain({ name: "shop.com", years: 1, currentExpiryYear: 2031, maxPriceUsd: "15" });
    await expect(renew("OperationLimitExceeded")).rejects.toMatchObject({
      code: "conflict",
      retryable: true,
      awsErrorName: "OperationLimitExceeded",
    });
    await expect(renew("TLDRulesViolation")).rejects.toMatchObject({
      code: "conflict",
      retryable: false,
    });
    await expect(renew("UnsupportedTLD")).rejects.toMatchObject({
      code: "validation",
      retryable: false,
    });
    await expect(renew("InvalidInput")).rejects.toMatchObject({
      code: "not_found",
      retryable: false,
    });
    await expect(renew("DuplicateRequest")).rejects.toMatchObject({
      code: "conflict",
      retryable: true,
    });
    // RegisterDomain keeps its mapping (a create that cannot start is refunded as before).
    const register = createRoute53DomainsPort(
      sender({
        RegisterDomainCommand: () => {
          throw awsFailure("OperationLimitExceeded");
        },
      }).fake,
    ).registerDomain({ name: "shop.com", years: 1, contact: CONTACT, maxPriceUsd: "15" });
    await expect(register).rejects.toMatchObject({ code: "conflict", retryable: false });
  });
});

describe("getDomainDetail", () => {
  const detail = {
    DomainName: "Shop.com",
    ExpirationDate: new Date("2031-01-01T00:00:00.000Z"),
    Nameservers: [{ Name: "NS-1.awsdns-01.org." }, { Name: "ns-2.awsdns-02.net" }],
  };

  it("joins GetDomainDetail and GetContactReachabilityStatus, in plain form", async () => {
    const { fake, calls } = sender({
      GetDomainDetailCommand: () => detail,
      GetContactReachabilityStatusCommand: () => ({ status: "PENDING" }),
    });
    expect(await createRoute53DomainsPort(fake).getDomainDetail("shop.com")).toEqual({
      name: "shop.com",
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
      nameServers: ["ns-1.awsdns-01.org", "ns-2.awsdns-02.net"],
      reachability: "pending",
    });
    expect(calls.map((c) => c.name)).toEqual([
      "GetDomainDetailCommand",
      "GetContactReachabilityStatusCommand",
    ]);
  });

  it("maps DONE, EXPIRED and everything else", async () => {
    for (const [aws, ours] of [
      ["DONE", "done"],
      ["EXPIRED", "expired"],
      ["WHAT", "unknown"],
    ] as const) {
      const { fake } = sender({
        GetDomainDetailCommand: () => detail,
        GetContactReachabilityStatusCommand: () => ({ status: aws }),
      });
      expect((await createRoute53DomainsPort(fake).getDomainDetail("shop.com"))?.reachability).toBe(
        ours,
      );
    }
  });

  it("a status call that fails leaves the reachability unknown, never done (R16)", async () => {
    const { fake } = sender({
      GetDomainDetailCommand: () => detail,
      GetContactReachabilityStatusCommand: () => {
        throw awsFailure("InvalidInput");
      },
    });
    expect((await createRoute53DomainsPort(fake).getDomainDetail("shop.com"))?.reachability).toBe(
      "unknown",
    );
  });

  it("a domain that this account does not hold is null (InvalidInput), another failure is thrown", async () => {
    const missing = sender({
      GetDomainDetailCommand: () => {
        throw awsFailure("InvalidInput");
      },
    });
    expect(await createRoute53DomainsPort(missing.fake).getDomainDetail("none.com")).toBeNull();
    const down = sender({
      GetDomainDetailCommand: () => {
        throw awsFailure("ServiceUnavailable", 503);
      },
    });
    await expect(
      createRoute53DomainsPort(down.fake).getDomainDetail("none.com"),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("an answer without name servers or with a malformed one is refused", async () => {
    for (const bad of [
      { ...detail, Nameservers: [{ Name: "bad host" }] },
      { ...detail, Nameservers: undefined },
      { ...detail, ExpirationDate: "tomorrow" },
    ]) {
      const { fake } = sender({
        GetDomainDetailCommand: () => bad,
        GetContactReachabilityStatusCommand: () => ({ status: "DONE" }),
      });
      await expect(
        createRoute53DomainsPort(fake).getDomainDetail("shop.com"),
      ).rejects.toBeInstanceOf(AwsError);
    }
  });
});

describe("resendContactReachabilityEmail and updateNameServers", () => {
  it("resends for the name", async () => {
    const { fake, calls } = sender({ ResendContactReachabilityEmailCommand: () => ({}) });
    await createRoute53DomainsPort(fake).resendContactReachabilityEmail("shop.com");
    expect(calls[0]?.input).toEqual({ domainName: "shop.com" });
  });

  it("sends the name servers as {Name} and returns the operation id", async () => {
    const { fake, calls } = sender({
      UpdateDomainNameserversCommand: () => ({ OperationId: "op-5" }),
    });
    expect(
      await createRoute53DomainsPort(fake).updateNameServers("shop.com", [
        "ns1.example.net",
        "ns2.example.net",
      ]),
    ).toEqual({ operationId: "op-5" });
    expect(calls[0]?.input).toEqual({
      DomainName: "shop.com",
      Nameservers: [{ Name: "ns1.example.net" }, { Name: "ns2.example.net" }],
    });
  });

  it("maps a refused change to a conflict and a domain that is not ours to not_found", async () => {
    const conflict = sender({
      UpdateDomainNameserversCommand: () => {
        throw awsFailure("OperationLimitExceeded");
      },
    });
    await expect(
      createRoute53DomainsPort(conflict.fake).updateNameServers("shop.com", ["a.example.net"]),
    ).rejects.toMatchObject({ code: "conflict" });
    const gone = sender({
      ResendContactReachabilityEmailCommand: () => {
        throw awsFailure("InvalidInput");
      },
    });
    await expect(
      createRoute53DomainsPort(gone.fake).resendContactReachabilityEmail("shop.com"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
