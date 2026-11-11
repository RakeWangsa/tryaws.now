import { describe, expect, it, vi } from "vitest";
import type { CustomerRepos } from "@tc/db";
import { gateCustomer } from "./checks";

// The purchase reads the customer row `for share` (the second proof that a KYC revocation cannot
// slip between the check and the charge). The database half is in packages/db/test/profile.test.ts.
const reposWith = (get: ReturnType<typeof vi.fn>) =>
  ({ profile: { get } }) as unknown as CustomerRepos;
const row = { status: "active", kycStatus: "verified", riskTier: "new", market: "BD" };

describe("gateCustomer", () => {
  it("passes the lock option to the profile read", async () => {
    const get = vi.fn().mockResolvedValue(row);
    await gateCustomer(reposWith(get), { lock: "share" });
    expect(get).toHaveBeenCalledWith({ lock: "share" });
  });

  it("reads without a lock when none is asked for (the draft takes no lock)", async () => {
    const get = vi.fn().mockResolvedValue(row);
    await gateCustomer(reposWith(get));
    expect(get).toHaveBeenCalledWith(undefined);
  });
});
