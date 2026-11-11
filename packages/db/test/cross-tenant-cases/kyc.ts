import { v7 as uuidv7 } from "uuid";
import { newAdmin } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

// The submission of customer A. B reads and writes through its own scope, so A's row must neither
// show in B's answers nor change; a submit of B with the id of A's row is a conflict, the same as an
// id that nobody holds is a new row (the ghost case is a fresh id, so both are "self-write").
export const kycCases: CaseSet = defineCaseSet<{ customerId: string; kycSubmissionId: string }>({
  repo: "kyc",
  seed: async (pool, customerId) => ({
    customerId,
    kycSubmissionId: await insertRow(pool, "kyc_submissions", {
      customer_id: customerId,
      document_type: "nid",
      // Rejected, so that A may submit again and its own write changes its rows.
      status: "rejected",
      reviewer_id: await newAdmin(pool),
      reviewed_at: new Date("2026-11-01T00:00:00Z"),
      note: "seed",
      document_number_encrypted: Buffer.from("sealed"),
      s3_keys: [`kyc/${customerId}/seed/0.jpg`],
    }),
  }),
  cases: ({ asCustomer }) => ({
    "kyc.latest": { kind: "read", run: (c) => asCustomer(c, (r) => r.kyc.latest()) },
    "kyc.submit": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.kyc.submit({
            id: uuidv7(),
            documentType: "passport",
            documentNumberEncrypted: Buffer.from("sealed-b"),
            s3Keys: ["kyc/x/y/0.png"],
          }),
        ),
    },
    "kyc.setType": {
      kind: "self-write",
      run: (c) => asCustomer(c, (r) => r.kyc.setType("business")),
    },
  }),
});
