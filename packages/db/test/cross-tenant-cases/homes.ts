import { seedPool } from "../../testing/capacity";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

// The pool account is shared infrastructure, not a row of customer A, so it is made once here and kept
// out of the seed: the helper counts every id of the seed as A's and would report B's answer that
// names the pool account. (One proof file uses one temporary database, so the module variable is safe.)
let homePool = "";

export const homesCases: CaseSet = defineCaseSet<{
  customerId: string;
  homeId: string;
  homeRegion: string;
}>({
  repo: "homes",
  seed: async (pool, customerId) => {
    homePool ||= (await seedPool(pool)).poolAccountId;
    const homeId = await insertRow(pool, "customer_homes", {
      customer_id: customerId,
      region: "ap-southeast-1",
      pool_account_id: homePool,
    });
    return { customerId, homeId, homeRegion: "ap-southeast-1" };
  },
  cases: ({ asCustomer }) => ({
    "homes.get": { kind: "read", run: (c, s) => asCustomer(c, (r) => r.homes.get(s.homeRegion)) },
    // a Region where the seed made no home, so the run of customer A on its own rows really changes them,
    // which the helper demands of a self-write
    "homes.assign": {
      kind: "self-write",
      run: (c) => asCustomer(c, (r) => r.homes.assign("ap-south-1", homePool)),
    },
  }),
});
