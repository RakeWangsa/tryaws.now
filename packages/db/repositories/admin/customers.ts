import { sql } from "drizzle-orm";
import { RISK_TIERS } from "../../schema/identity";
import { refused, type RepoErrorCode, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminRole, AdminScope } from "./index";

// 16.12 /customers and /customers/[id]. Reads are for support, ops and superadmin; the decisions
// (KYC, risk tier, suspend, resume) are for ops and superadmin. The role check here is a second layer
// behind requireAdmin(roles) of the app (R9, R16): a role outside the list is refused with "forbidden"
// before any query. Every write goes through `audited` (R10). The raw email and phone never leave
// this file: the screens get masked text (R14).
const READ_ROLES: readonly AdminRole[] = ["support", "ops", "superadmin"];
const ACT_ROLES: readonly AdminRole[] = ["ops", "superadmin"];

const MAX_QUERY = 100;
const MAX_NOTE = 500;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

export type RiskTier = (typeof RISK_TIERS)[number];
export type KycFilter = "none" | "pending" | "verified" | "rejected";

export interface CustomerSearchInput {
  // An id, an exact email, an exact phone number or the start of a name.
  q?: string;
  kycStatus?: KycFilter;
  limit?: number;
  // The id of the last row of the previous page.
  after?: string;
}

export interface CustomerListRow {
  id: string;
  name: string | null;
  emailMasked: string;
  phoneMasked: string | null;
  kycStatus: string;
  riskTier: string;
  status: string;
  createdAt: Date;
}

export interface CustomerSearchResult {
  rows: CustomerListRow[];
  nextAfter: string | null;
}

export interface KycSubmissionView {
  id: string;
  documentType: string;
  status: string;
  // How many images; the keys stay inside the repository (the viewer asks for one by index).
  documentCount: number;
  reviewedAt: Date | null;
  reviewerId: string | null;
  note: string | null;
  createdAt: Date;
}

export interface CustomerAuditRow {
  id: string;
  action: string;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface CustomerDetail extends CustomerListRow {
  type: string | null;
  market: string;
  locale: string;
  phoneVerified: boolean;
  wallet: { currency: string; balanceMinor: bigint } | null;
  resourceCount: number;
  kycSubmissions: KycSubmissionView[];
  audit: CustomerAuditRow[];
}

export interface KycQueueRow {
  submissionId: string;
  customerId: string;
  customerName: string | null;
  documentType: string;
  createdAt: Date;
}

export interface KycDecisionInput {
  submissionId: string;
  at: Date;
  // The text the customer may see next to a rejection; the reason of R10 stays internal.
  note?: string;
}

export interface KycDecided {
  submissionId: string;
  customerId: string;
  status: "verified" | "rejected";
}

export interface RiskTierInput {
  customerId: string;
  tier: RiskTier;
}

export interface CustomerStateInput {
  customerId: string;
  at: Date;
}

export interface CustomerChanged {
  customerId: string;
  riskTier: string;
  status: string;
}

export interface KycDocumentInput {
  submissionId: string;
  index: number;
}

export interface KycDocumentRead {
  customerId: string;
  // The object key in the kyc bucket. For the presigner only; never shown (R14).
  key: string;
}

export interface CustomersAdminRepo {
  search(input: CustomerSearchInput): Promise<Written<CustomerSearchResult>>;
  detail(customerId: string): Promise<Written<CustomerDetail>>;
  kycQueue(input?: { limit?: number }): Promise<Written<KycQueueRow[]>>;
  approveKyc(input: KycDecisionInput, reason: string): Promise<Written<KycDecided>>;
  rejectKyc(input: KycDecisionInput, reason: string): Promise<Written<KycDecided>>;
  setRiskTier(input: RiskTierInput, reason: string): Promise<Written<CustomerChanged>>;
  suspend(input: CustomerStateInput, reason: string): Promise<Written<CustomerChanged>>;
  resume(input: CustomerStateInput, reason: string): Promise<Written<CustomerChanged>>;
  // Every view of a document leaves an audit row with the reason the admin gave (R10); the key is
  // returned for the presigner.
  documentRead(input: KycDocumentInput, reason: string): Promise<Written<KycDocumentRead>>;
}

// "abcd@example.com" -> "a***@example.com". Text that is not an address is fully hidden.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

// "+8801712345678" -> "+88017*****78": the start and the last two characters.
export function maskPhone(phone: string): string {
  if (phone.length < 8) return "***";
  return `${phone.slice(0, 5)}${"*".repeat(phone.length - 7)}${phone.slice(-2)}`;
}

// Thrown inside the audited write, so that a refusal writes no audit row.
class Refusal extends Error {
  constructor(readonly code: RepoErrorCode) {
    super("customer action refused");
  }
}

type ListDbRow = {
  id: string;
  name: string | null;
  email: string;
  phone: string | null;
  kyc_status: string;
  risk_tier: string;
  status: string;
  created_at: Date;
};

const toListRow = (r: ListDbRow): CustomerListRow => ({
  id: r.id,
  name: r.name,
  emailMasked: maskEmail(r.email),
  phoneMasked: r.phone === null ? null : maskPhone(r.phone),
  kycStatus: r.kyc_status,
  riskTier: r.risk_tier,
  status: r.status,
  createdAt: r.created_at,
});

function normalizePhone(q: string): string | null {
  const digits = q.replace(/[\s-]/g, "");
  if (!/^\+?[0-9]{7,15}$/.test(digits)) return null;
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("880")) return `+${digits}`;
  if (digits.startsWith("0")) return `+88${digits}`;
  return `+${digits}`;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const isValidDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

function pageSize(limit: number | undefined): number | null {
  if (limit === undefined) return DEFAULT_PAGE;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE ? limit : null;
}

export function customersAdminRepo(scope: AdminScope): CustomersAdminRepo {
  const role = scope.actor.role;
  const canRead = READ_ROLES.includes(role);
  const canAct = ACT_ROLES.includes(role);

  const customerOfSubmission = async (submissionId: string): Promise<string | null> => {
    const { rows } = await scope.tx.execute<{ customer_id: string }>(
      sql`select customer_id from kyc_submissions where id = ${submissionId}`,
    );
    return rows[0]?.customer_id ?? null;
  };

  const decideKyc = async (
    status: "verified" | "rejected",
    input: KycDecisionInput,
    reason: string,
  ): Promise<Written<KycDecided>> => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const { submissionId, at, note } = input;
    if (!canAct) return refused("forbidden");
    if (typeof submissionId !== "string" || !isUuid(submissionId) || !isValidDate(at)) {
      return refused("validation");
    }
    if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE)) {
      return refused("validation");
    }
    if (!(await isActiveAdmin(scope))) return refused("forbidden");
    // The customer is the target of the audit row; the write below reads the submission again under lock.
    const owner = await customerOfSubmission(submissionId);
    if (owner === null) return refused("not_found");
    try {
      return await audited(
        scope,
        {
          action: status === "verified" ? "kyc.approve" : "kyc.reject",
          targetType: "customer",
          targetId: owner,
          reason,
        },
        async () => {
          const { rows } = await scope.tx.execute<{
            customer_id: string;
            status: string;
          }>(
            sql`select customer_id, status from kyc_submissions where id = ${submissionId} for update`,
          );
          const sub = rows[0];
          if (sub === undefined) throw new Refusal("not_found");
          // One lock on the customer serializes two admins who decide at the same time.
          await scope.tx.execute(
            sql`select id from customers where id = ${sub.customer_id} for update`,
          );
          const latest = await scope.tx.execute<{ id: string }>(
            sql`select id from kyc_submissions where customer_id = ${sub.customer_id} order by created_at desc, id desc limit 1`,
          );
          // Only the newest submission of a customer can be decided: the older ones are history.
          if (latest.rows[0]?.id !== submissionId) throw new Refusal("conflict");
          const value: KycDecided = { submissionId, customerId: sub.customer_id, status };
          const meta = { submissionId, customerId: sub.customer_id };
          if (sub.status === status) {
            return {
              value,
              replayed: true,
              before: { ...meta, status },
              after: { ...meta, status },
            };
          }
          if (sub.status !== "pending") throw new Refusal("conflict");
          await scope.tx.execute(
            sql`update kyc_submissions set status = ${status}, reviewer_id = ${scope.actor.adminId}, reviewed_at = ${at}, note = ${note ?? null} where id = ${submissionId}`,
          );
          await scope.tx.execute(
            sql`update customers set kyc_status = ${status} where id = ${sub.customer_id}`,
          );
          return {
            value,
            replayed: false,
            before: { ...meta, status: "pending" },
            after: { ...meta, status },
          };
        },
      );
    } catch (error) {
      if (error instanceof Refusal) return refused(error.code);
      throw error;
    }
  };

  // One lock on the customer row, then the change; the same value again is a replay (R7).
  const changeCustomer = async (
    action: string,
    customerId: string,
    reason: string,
    valid: boolean,
    apply: (current: { risk_tier: string; status: string }) => {
      replay: boolean;
      update: ReturnType<typeof sql>;
      after: Record<string, unknown>;
    },
  ): Promise<Written<CustomerChanged>> => {
    if (!canAct) return refused("forbidden");
    if (typeof customerId !== "string" || !isUuid(customerId) || !valid) {
      return refused("validation");
    }
    try {
      return await audited(
        scope,
        { action, targetType: "customer", targetId: customerId, reason },
        async () => {
          const { rows } = await scope.tx.execute<{ risk_tier: string; status: string }>(
            sql`select risk_tier, status from customers where id = ${customerId} for update`,
          );
          const current = rows[0];
          if (current === undefined) throw new Refusal("not_found");
          const step = apply(current);
          let now = current;
          if (!step.replay) {
            const updated = await scope.tx.execute<{ risk_tier: string; status: string }>(
              sql`${step.update} returning risk_tier, status`,
            );
            now = updated.rows[0] ?? current;
          }
          return {
            value: { customerId, riskTier: now.risk_tier, status: now.status },
            replayed: step.replay,
            before: { riskTier: current.risk_tier, status: current.status },
            after: step.after,
          };
        },
      );
    } catch (error) {
      if (error instanceof Refusal) return refused(error.code);
      throw error;
    }
  };

  return {
    async search(input) {
      if (!canRead || !(await isActiveAdmin(scope))) return refused("forbidden");
      const { q, kycStatus, limit, after } = input;
      const size = pageSize(limit);
      if (
        size === null ||
        (q !== undefined && (typeof q !== "string" || q.length > MAX_QUERY)) ||
        (kycStatus !== undefined &&
          !["none", "pending", "verified", "rejected"].includes(kycStatus)) ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        return refused("validation");
      }
      const term = (q ?? "").trim();
      const conditions = [sql`true`];
      if (term !== "") {
        const phone = normalizePhone(term);
        if (isUuid(term)) conditions.push(sql`id = ${term}`);
        else if (term.includes("@")) conditions.push(sql`lower(email) = ${term.toLowerCase()}`);
        else if (phone !== null) conditions.push(sql`phone = ${phone}`);
        else conditions.push(sql`name ilike ${escapeLike(term) + "%"}`);
      }
      if (kycStatus !== undefined) conditions.push(sql`kyc_status = ${kycStatus}`);
      if (after !== undefined) conditions.push(sql`id < ${after}`);
      const where = sql.join(conditions, sql` and `);
      const result = await scope.tx.execute<ListDbRow>(
        sql`select id, name, email, phone, kyc_status, risk_tier, status, created_at from customers where ${where} order by id desc limit ${size + 1}`,
      );
      const page = result.rows.slice(0, size);
      return {
        ok: true,
        value: {
          rows: page.map(toListRow),
          nextAfter: result.rows.length > size ? (page[page.length - 1]?.id ?? null) : null,
        },
        replayed: false,
      };
    },

    async detail(customerId) {
      if (!canRead || !(await isActiveAdmin(scope))) return refused("forbidden");
      if (typeof customerId !== "string" || !isUuid(customerId)) return refused("not_found");
      const found = await scope.tx.execute<
        ListDbRow & {
          type: string | null;
          market: string;
          locale: string;
          phone_verified_at: Date | null;
        }
      >(
        sql`select id, name, email, phone, kyc_status, risk_tier, status, created_at, type, market, locale, phone_verified_at from customers where id = ${customerId}`,
      );
      const row = found.rows[0];
      if (row === undefined) return refused("not_found");
      const wallet = await scope.tx.execute<{ currency: string; balance_minor: string }>(
        sql`select currency, balance_minor from wallets where customer_id = ${customerId} order by created_at limit 1`,
      );
      const resources = await scope.tx.execute<{ n: string }>(
        sql`select count(*) as n from resources where customer_id = ${customerId} and deleted_at is null`,
      );
      const subs = await scope.tx.execute<{
        id: string;
        document_type: string;
        status: string;
        documents: number;
        reviewed_at: Date | null;
        reviewer_id: string | null;
        note: string | null;
        created_at: Date;
      }>(
        sql`select id, document_type, status, cardinality(s3_keys) as documents, reviewed_at, reviewer_id, note, created_at from kyc_submissions where customer_id = ${customerId} order by created_at desc, id desc limit 20`,
      );
      const audit = await scope.tx.execute<{
        id: string;
        action: string;
        actor_id: string | null;
        reason: string | null;
        created_at: Date;
      }>(
        sql`select id, action, actor_id, metadata->>'reason' as reason, created_at from audit_log where target_type = 'customer' and target_id = ${customerId} order by created_at desc, id desc limit 30`,
      );
      const walletRow = wallet.rows[0];
      return {
        ok: true,
        replayed: false,
        value: {
          ...toListRow(row),
          type: row.type,
          market: row.market,
          locale: row.locale,
          phoneVerified: row.phone_verified_at !== null,
          wallet:
            walletRow === undefined
              ? null
              : { currency: walletRow.currency, balanceMinor: BigInt(walletRow.balance_minor) },
          resourceCount: Number(resources.rows[0]?.n ?? 0),
          kycSubmissions: subs.rows.map((s) => ({
            id: s.id,
            documentType: s.document_type,
            status: s.status,
            documentCount: Number(s.documents),
            reviewedAt: s.reviewed_at,
            reviewerId: s.reviewer_id,
            note: s.note,
            createdAt: s.created_at,
          })),
          audit: audit.rows.map((a) => ({
            id: a.id,
            action: a.action,
            actorId: a.actor_id,
            reason: a.reason,
            createdAt: a.created_at,
          })),
        },
      };
    },

    async kycQueue(input) {
      if (!canRead || !(await isActiveAdmin(scope))) return refused("forbidden");
      const size = pageSize(input?.limit);
      if (size === null) return refused("validation");
      const result = await scope.tx.execute<{
        id: string;
        customer_id: string;
        name: string | null;
        document_type: string;
        created_at: Date;
      }>(
        sql`select s.id, s.customer_id, c.name, s.document_type, s.created_at from kyc_submissions s join customers c on c.id = s.customer_id where s.status = 'pending' order by s.created_at, s.id limit ${size}`,
      );
      return {
        ok: true,
        replayed: false,
        value: result.rows.map((r) => ({
          submissionId: r.id,
          customerId: r.customer_id,
          customerName: r.name,
          documentType: r.document_type,
          createdAt: r.created_at,
        })),
      };
    },

    approveKyc: (input, reason) => decideKyc("verified", input, reason),
    rejectKyc: (input, reason) => decideKyc("rejected", input, reason),

    setRiskTier(input, reason) {
      const { customerId, tier } = input;
      return changeCustomer(
        "customer.set_risk_tier",
        customerId,
        reason,
        (RISK_TIERS as readonly string[]).includes(tier),
        (current) => ({
          replay: current.risk_tier === tier,
          update: sql`update customers set risk_tier = ${tier} where id = ${customerId}`,
          after: { riskTier: tier, status: current.status },
        }),
      );
    },

    suspend(input, reason) {
      const { customerId, at } = input;
      return changeCustomer("customer.suspend", customerId, reason, isValidDate(at), (current) => ({
        replay: current.status === "suspended",
        // The cut-off ends the sessions of the customer (6.1).
        update: sql`update customers set status = 'suspended', sessions_valid_after = ${at} where id = ${customerId}`,
        after: { riskTier: current.risk_tier, status: "suspended" },
      }));
    },

    resume(input, reason) {
      const { customerId, at } = input;
      return changeCustomer("customer.resume", customerId, reason, isValidDate(at), (current) => ({
        replay: current.status === "active",
        update: sql`update customers set status = 'active' where id = ${customerId}`,
        after: { riskTier: current.risk_tier, status: "active" },
      }));
    },

    async documentRead(input, reason) {
      const { submissionId, index } = input;
      if (!canRead) return refused("forbidden");
      if (
        typeof submissionId !== "string" ||
        !isUuid(submissionId) ||
        !Number.isInteger(index) ||
        index < 0
      ) {
        return refused("validation");
      }
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      const owner = await customerOfSubmission(submissionId);
      if (owner === null) return refused("not_found");
      try {
        return await audited(
          scope,
          {
            action: "kyc.document_view",
            targetType: "customer",
            targetId: owner,
            reason,
          },
          async () => {
            const { rows } = await scope.tx.execute<{ customer_id: string; key: string | null }>(
              sql`select customer_id, s3_keys[${index + 1}] as key from kyc_submissions where id = ${submissionId}`,
            );
            const row = rows[0];
            if (row === undefined || row.key === null) throw new Refusal("not_found");
            return {
              value: { customerId: row.customer_id, key: row.key },
              replayed: false,
              before: null,
              after: { submissionId, index },
            };
          },
        );
      } catch (error) {
        if (error instanceof Refusal) return refused(error.code);
        throw error;
      }
    },
  };
}
