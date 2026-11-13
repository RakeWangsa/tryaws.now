import { describe, expect, it } from "vitest";
import { recheckRenewal } from "../adapters/domain";
import type { DomainOperationStatus, DomainsPort } from "../adapters/domains-port";
import { AwsError } from "../errors";

// WPU-X3 (b): the fresh registry check of the admin action "registry confirmed not renewed". GetOperationDetail of the
// saved RenewDomain operation first, then GetDomainDetail of the name; the verdict is @tc/core renewalRecheckVerdict.
const BEFORE = "2031-03-04T05:06:07.890Z";
const PAYLOAD = { currentExpiryYear: 2031, currentExpiresAt: BEFORE, maxPriceUsd: "12.5" };

function port(status: DomainOperationStatus, expiresAt: string | null, calls: string[] = []) {
  const refuse = async (): Promise<never> => {
    throw new Error("not used");
  };
  const p: DomainsPort = {
    checkAvailability: refuse,
    listPrices: refuse,
    registerDomain: refuse,
    renewDomain: refuse,
    resendContactReachabilityEmail: refuse,
    updateNameServers: refuse,
    async getOperationDetail(id) {
      calls.push(`op:${id}`);
      return { status };
    },
    async getDomainDetail(name) {
      calls.push(`domain:${name}`);
      return {
        name,
        expiresAt: expiresAt === null ? null : new Date(expiresAt),
        nameServers: [],
        reachability: "done",
      };
    },
  };
  return p;
}

const input = { name: "example.com", renewOperationId: "op-renew-1", payload: PAYLOAD };

describe("recheckRenewal", () => {
  it("reads the saved operation, then the domain, and confirms an ERROR with the exact expiry", async () => {
    const calls: string[] = [];
    expect(await recheckRenewal(port("error", BEFORE, calls), input)).toEqual({
      verdict: "unrenewed",
    });
    expect(calls).toEqual(["op:op-renew-1", "domain:example.com"]);
  });

  it("FAILED with the exact expiry is confirmed too", async () => {
    expect(await recheckRenewal(port("failed", BEFORE), input)).toEqual({ verdict: "unrenewed" });
  });

  it("keeps a renewal that succeeded, is in progress or whose expiry moved", async () => {
    expect(await recheckRenewal(port("successful", BEFORE), input)).toEqual({
      verdict: "kept",
      reason: "registry_renewed",
    });
    expect(await recheckRenewal(port("in_progress", BEFORE), input)).toEqual({
      verdict: "kept",
      reason: "renewal_in_progress",
    });
    expect(await recheckRenewal(port("error", "2031-03-04T05:06:08.890Z"), input)).toEqual({
      verdict: "kept",
      reason: "expiry_changed",
    });
    expect(await recheckRenewal(port("error", "2032-03-04T05:06:07.890Z"), input)).toEqual({
      verdict: "kept",
      reason: "registry_renewed",
    });
    expect(await recheckRenewal(port("error", null), input)).toEqual({
      verdict: "kept",
      reason: "renewal_unreadable",
    });
  });

  it("a domain the account does not hold proves nothing", async () => {
    const p = { ...port("error", BEFORE), getDomainDetail: async () => null };
    expect(await recheckRenewal(p, input)).toEqual({
      verdict: "kept",
      reason: "renewal_unreadable",
    });
  });

  it("a missing operation id or name asks AWS nothing and proves nothing (R16)", async () => {
    for (const bad of [
      { ...input, renewOperationId: null },
      { ...input, renewOperationId: "bad id with spaces" },
      { ...input, name: "" },
      { ...input, name: 5 },
      { ...input, name: "Example.COM" },
    ]) {
      const calls: string[] = [];
      expect(await recheckRenewal(port("error", BEFORE, calls), bad), JSON.stringify(bad)).toEqual({
        verdict: "kept",
        reason: "renewal_unreadable",
      });
      expect(calls).toEqual([]);
    }
  });

  it("an AWS error is thrown to the caller, never read as a verdict", async () => {
    const p = {
      ...port("error", BEFORE),
      getOperationDetail: async () => {
        throw new AwsError({ code: "upstream_unavailable", retryable: true });
      },
    };
    await expect(recheckRenewal(p, input)).rejects.toBeInstanceOf(AwsError);
  });
});
