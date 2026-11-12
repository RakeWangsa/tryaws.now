import { describe, expect, it } from "vitest";
import { DOMAIN_STATES } from "./state";
import { planDomainSync } from "./sync";

// WPU-B2: which status and facts the `domains` row gets when an operation of the domain ends. Pure.

const EXPIRY = "2031-01-01T00:00:00.000Z";
const CONFIG = {
  domainStatus: "awaiting_verification",
  expiresAt: EXPIRY,
  hostedZoneId: "Z0123456789",
  route53OperationId: "op-1",
};

describe("create succeeded", () => {
  it("pending -> awaiting_verification with the facts of the adoption", () => {
    expect(planDomainSync("pending", "create", "succeeded", CONFIG)).toEqual({
      to: "awaiting_verification",
      expiresAt: new Date(EXPIRY),
      hostedZoneId: "Z0123456789",
      route53OperationId: "op-1",
    });
  });

  it("goes on to registered when the adapter saw the contact verified", () => {
    const plan = planDomainSync("pending", "create", "succeeded", {
      ...CONFIG,
      domainStatus: "registered",
    });
    expect(plan?.to).toBe("registered");
  });

  it("a review row whose create ran was approved first", () => {
    expect(planDomainSync("review", "create", "succeeded", CONFIG)?.to).toBe(
      "awaiting_verification",
    );
  });

  it("a repeat is not a second move: only awaiting_verification may become registered", () => {
    expect(planDomainSync("registered", "create", "succeeded", CONFIG)).toBeNull();
    expect(planDomainSync("failed", "create", "succeeded", CONFIG)).toBeNull();
    expect(planDomainSync("expired", "create", "succeeded", CONFIG)).toBeNull();
    expect(
      planDomainSync("awaiting_verification", "create", "succeeded", {
        ...CONFIG,
        domainStatus: "registered",
      })?.to,
    ).toBe("registered");
    expect(planDomainSync("awaiting_verification", "create", "succeeded", CONFIG)).toBeNull();
  });

  it("drops a fact that is malformed and keeps the move (R16: no guess)", () => {
    const plan = planDomainSync("pending", "create", "succeeded", {
      domainStatus: "awaiting_verification",
      expiresAt: "tomorrow",
      hostedZoneId: "z; drop",
      route53OperationId: "a b",
    });
    expect(plan).toEqual({ to: "awaiting_verification" });
  });

  it("an unknown word in the config is no verification", () => {
    for (const config of [null, {}, { domainStatus: "failed" }, { domainStatus: 7 }, "x"]) {
      expect(planDomainSync("pending", "create", "succeeded", config)?.to).toBe(
        "awaiting_verification",
      );
    }
  });
});

describe("create failed", () => {
  it("pending and review rows are failed, which gives the name back", () => {
    expect(planDomainSync("pending", "create", "failed", {})).toEqual({ to: "failed" });
    expect(planDomainSync("review", "create", "failed", {})).toEqual({ to: "failed" });
  });

  it("a row that is already past the registration is never downgraded", () => {
    for (const from of ["awaiting_verification", "registered", "expired", "failed"]) {
      expect(planDomainSync(from, "create", "failed", {})).toBeNull();
    }
  });
});

describe("renew_domain", () => {
  it("saves the new expiry and keeps the status; an expired domain is registered again", () => {
    expect(
      planDomainSync("registered", "renew_domain", "succeeded", { expiresAt: EXPIRY }),
    ).toEqual({ to: "registered", expiresAt: new Date(EXPIRY) });
    expect(
      planDomainSync("awaiting_verification", "renew_domain", "succeeded", { expiresAt: EXPIRY }),
    ).toEqual({ to: "awaiting_verification", expiresAt: new Date(EXPIRY) });
    expect(planDomainSync("expired", "renew_domain", "succeeded", { expiresAt: EXPIRY })?.to).toBe(
      "registered",
    );
  });

  it("without a well-formed expiry nothing is written (R16)", () => {
    for (const config of [{}, { expiresAt: "x" }, { expiresAt: 5 }, null]) {
      expect(planDomainSync("registered", "renew_domain", "succeeded", config)).toBeNull();
    }
  });

  it("a renewal does not touch a domain that never got registered", () => {
    for (const from of ["pending", "review", "failed"]) {
      expect(planDomainSync(from, "renew_domain", "succeeded", { expiresAt: EXPIRY })).toBeNull();
    }
  });

  it("a failed renewal changes nothing here (the row still has the old expiry)", () => {
    expect(
      planDomainSync("registered", "renew_domain", "failed", { expiresAt: EXPIRY }),
    ).toBeNull();
  });
});

describe("resend_verification succeeded", () => {
  it("moves awaiting_verification to registered only when the registry says done", () => {
    expect(
      planDomainSync("awaiting_verification", "resend_verification", "succeeded", {
        reachability: "done",
      }),
    ).toEqual({ to: "registered" });
    expect(
      planDomainSync("awaiting_verification", "resend_verification", "succeeded", {
        reachability: "pending",
      }),
    ).toBeNull();
    expect(
      planDomainSync("registered", "resend_verification", "succeeded", { reachability: "done" }),
    ).toBeNull();
  });
});

describe("other kinds and words", () => {
  it("any other kind, and any word outside the closed list, plans nothing", () => {
    expect(planDomainSync("pending", "reboot", "succeeded", CONFIG)).toBeNull();
    expect(planDomainSync("pending", "set_name_servers", "succeeded", CONFIG)).toBeNull();
    expect(planDomainSync("registering", "create", "succeeded", CONFIG)).toBeNull();
    expect(planDomainSync("pending", "create", "maybe" as never, CONFIG)).toBeNull();
  });

  it("every plan names a status of the closed list", () => {
    for (const from of DOMAIN_STATES) {
      for (const kind of ["create", "renew_domain", "resend_verification"]) {
        for (const outcome of ["succeeded", "failed"] as const) {
          const plan = planDomainSync(from, kind, outcome, { ...CONFIG, reachability: "done" });
          if (plan !== null) expect(DOMAIN_STATES as readonly string[]).toContain(plan.to);
        }
      }
    }
  });
});
