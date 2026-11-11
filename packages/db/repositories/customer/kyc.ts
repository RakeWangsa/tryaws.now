import { and, desc, eq, sql } from "drizzle-orm";
import { customers, kycSubmissions } from "../../schema/index";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// WP2-T4: the identity check of one customer. The web role reads seven columns of kyc_submissions
// and inserts five (migration 0006): the S3 keys and the encrypted document number go in and never
// come back out. The customer's own status (customers.kyc_status) is written by staff only.

export interface KycSubmissionView {
  id: string;
  documentType: string;
  status: "pending" | "verified" | "rejected";
  reviewedAt: Date | null;
  /** The reviewer's note for a rejection; shown to the customer. */
  note: string | null;
  createdAt: Date;
}

export interface NewKycSubmission {
  /** Made by the server when the upload started; it is the idempotency key (R7) and part of the S3 keys. */
  id: string;
  documentType: string;
  /** The KMS envelope of the document number. */
  documentNumberEncrypted: Uint8Array;
  s3Keys: readonly string[];
}

export interface KycRepo {
  /** The newest submission, or null when the customer never submitted one. */
  latest(): Promise<KycSubmissionView | null>;
  /**
   * conflict: another submission is open, the customer is verified, or the id belongs to a different request.
   * The same request again is a replay.
   */
  submit(input: NewKycSubmission): Promise<Written<KycSubmissionView>>;
  /** The account type chosen in the first step of /kyc. Absolute assignment, so it is idempotent. */
  setType(type: "individual" | "business"): Promise<Written<{ type: "individual" | "business" }>>;
}

const VIEW_COLUMNS = {
  id: kycSubmissions.id,
  documentType: kycSubmissions.documentType,
  status: kycSubmissions.status,
  reviewedAt: kycSubmissions.reviewedAt,
  note: kycSubmissions.note,
  createdAt: kycSubmissions.createdAt,
};

type RawView = {
  id: string;
  documentType: string;
  status: KycSubmissionView["status"];
  reviewedAt: string | null;
  note: string | null;
  createdAt: string;
};

const toView = (row: Record<keyof KycSubmissionView, unknown>): KycSubmissionView =>
  row as unknown as KycSubmissionView;

export function kycRepo(scope: TenantScope): KycRepo {
  const latest = async (): Promise<KycSubmissionView | null> => {
    const [row] = await scope.tx
      .select(VIEW_COLUMNS)
      .from(kycSubmissions)
      .where(eq(kycSubmissions.customerId, scope.customerId))
      .orderBy(desc(kycSubmissions.createdAt), desc(kycSubmissions.id))
      .limit(1);
    return row === undefined ? null : toView(row);
  };

  return {
    latest,

    submit: async (input) => {
      if (
        !isUuid(input.id) ||
        input.s3Keys.length < 1 ||
        input.documentNumberEncrypted.length < 1 ||
        input.documentType === ""
      ) {
        return refused("validation");
      }
      // One open submission per customer. There is no partial unique index, so the customer's
      // submits are serialised with a transaction lock before the check (the lock ends with the
      // transaction). The check and the insert then see the same state.
      await scope.tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"kyc:" + scope.customerId}, 0))`,
      );

      // The same id again by this customer: the earlier result (R7). Another customer's id is a
      // conflict and tells nothing about the row.
      const [same] = await scope.tx
        .select(VIEW_COLUMNS)
        .from(kycSubmissions)
        .where(
          and(eq(kycSubmissions.id, input.id), eq(kycSubmissions.customerId, scope.customerId)),
        );
      if (same !== undefined) return replayed(toView(same));

      const [customer] = await scope.tx
        .select({ kycStatus: customers.kycStatus })
        .from(customers)
        .where(eq(customers.id, scope.customerId));
      if (customer === undefined) return refused("not_found");
      if (customer.kycStatus === "verified") return refused("conflict");
      const open = await latest();
      if (open !== null && open.status === "pending") return refused("conflict");

      // Only the five columns that web_rw may insert; a Drizzle insert() would name created_at too.
      const keys = sql.join(
        input.s3Keys.map((key) => sql`${key}`),
        sql`, `,
      );
      const { rows } = await scope.tx.execute<RawView>(sql`
        insert into kyc_submissions (id, customer_id, document_type, document_number_encrypted, s3_keys)
        values (
          ${input.id}, ${scope.customerId}, ${input.documentType},
          ${Buffer.from(input.documentNumberEncrypted)}, ARRAY[${keys}]::text[]
        )
        on conflict (id) do nothing
        returning id, document_type as "documentType", status, reviewed_at as "reviewedAt",
          note, created_at as "createdAt"
      `);
      const [row] = rows;
      if (row === undefined) return refused("conflict"); // the id belongs to another customer
      return created({
        ...row,
        reviewedAt: row.reviewedAt === null ? null : new Date(row.reviewedAt),
        createdAt: new Date(row.createdAt),
      });
    },

    setType: async (type) => {
      if (type !== "individual" && type !== "business") return refused("validation");
      const [row] = await scope.tx
        .update(customers)
        .set({ type })
        .where(eq(customers.id, scope.customerId))
        .returning({ id: customers.id });
      return row === undefined ? refused("not_found") : created({ type });
    },
  };
}
