import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  FormBlock,
  MoneyText,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import type {
  AdjustmentRow,
  DiscrepancyRow,
  PaymentAdminDetail,
  PaymentListRow,
  PaymentSearchResult,
  WalletAdminDetail,
  WalletLedgerLine,
} from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { moneyAction } from "../../server/money-actions.ts";
import type { PaymentQuery } from "../../server/money-data.ts";

export const RESULT_CODES = [
  "ok",
  "replayed",
  "invalid",
  "denied",
  "not_found",
  "conflict",
  "rate_limited",
  "unavailable",
] as const;
export type ResultCode = (typeof RESULT_CODES)[number];

export function resultCodeOf(value: unknown): ResultCode | null {
  return typeof value === "string" && (RESULT_CODES as readonly string[]).includes(value)
    ? (value as ResultCode)
    : null;
}

const PAYMENT_STATUSES = [
  "pending",
  "initiated",
  "redirected",
  "credited",
  "failed",
  "cancelled",
  "expired",
  "review",
] as const;
const LEDGER_KINDS = [
  "topup",
  "purchase",
  "renewal",
  "metered_charge",
  "reversal",
  "adjustment",
  "refund",
] as const;
const REASON_CODES = [
  "amount_mismatch",
  "currency",
  "id_mismatch",
  "error_code",
  "late_success",
  "gateway_id_reused",
] as const;

function ResultLine({ result }: { result: ResultCode | null }) {
  const t = useTranslations("AdminMoney.result");
  if (result === null) return null;
  return (
    <p role="status" className="mb-3">
      <i
        className={
          result === "ok" || result === "replayed"
            ? "fas fa-check-circle me-1"
            : "fas fa-exclamation-circle me-1"
        }
        aria-hidden="true"
      />
      {t(result)}
    </p>
  );
}

function Hidden({
  locale,
  kind,
  id,
  customerId,
}: {
  locale: Locale;
  kind: string;
  id: string;
  customerId?: string;
}) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      {customerId === undefined ? null : (
        <input type="hidden" name="customerId" value={customerId} />
      )}
    </>
  );
}

function ReasonField({ suffix, hint }: { suffix: string; hint?: string }) {
  const t = useTranslations("AdminMoney.reason");
  return (
    <Field
      name="reason"
      id={`reason-${suffix}`}
      label={t("label")}
      hint={hint ?? t("hint")}
      required
      maxLength={500}
      autoComplete="off"
    />
  );
}

function Select({
  id,
  name,
  label,
  options,
  value,
}: {
  id: string;
  name: string;
  label: string;
  options: { value: string; text: string }[];
  value?: string;
}) {
  return (
    <div className="position-relative mb-3">
      <label className="seccolor" htmlFor={id}>
        {label}
      </label>
      <select id={id} name={name} className="form-control" defaultValue={value ?? ""}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </div>
  );
}

function ShortId({ id }: { id: string }) {
  return <span title={id}>#{id.slice(0, 8)}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("AdminMoney.payments.status");
  const known = (PAYMENT_STATUSES as readonly string[]).includes(status);
  const tone =
    status === "credited"
      ? "purple"
      : status === "review"
        ? "pink"
        : status === "initiated" || status === "redirected"
          ? "dark"
          : "grey";
  return <Badge tone={tone}>{known ? t(status as "review") : status}</Badge>;
}

// ---------------------------------------------------------------------------------------- wallet

function LedgerCard({ locale, wallet }: { locale: Locale; wallet: WalletAdminDetail }) {
  const t = useTranslations("AdminMoney.wallet");
  const columns: DataTableColumn<WalletLedgerLine>[] = [
    {
      key: "when",
      header: t("columns.when"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    {
      key: "kind",
      header: t("columns.kind"),
      cell: (row) =>
        (LEDGER_KINDS as readonly string[]).includes(row.kind)
          ? t(`kinds.${row.kind as "topup"}`)
          : row.kind,
    },
    {
      key: "direction",
      header: t("columns.direction"),
      cell: (row) => t(`direction.${row.direction}`),
    },
    {
      key: "amount",
      header: t("columns.amount"),
      cell: (row) => <MoneyText minor={row.amountMinor} />,
    },
    {
      key: "balance",
      header: t("columns.balance"),
      cell: (row) => <MoneyText minor={row.balanceAfterMinor} />,
    },
  ];
  const next =
    wallet.nextCursor === null
      ? null
      : `${localePath(locale, `/wallets/${wallet.customerId}`)}?cursor=${wallet.nextCursor}`;
  return (
    <Card title={t("ledgerTitle")}>
      {wallet.lines.length === 0 ? (
        <p className="mb-0">{t("empty")}</p>
      ) : (
        <DataTable
          caption={t("ledgerCaption")}
          columns={columns}
          rows={wallet.lines}
          rowKey={(row) => row.entryId}
          prevHref={undefined}
          nextHref={next}
        />
      )}
    </Card>
  );
}

function AdjustmentForm({
  locale,
  customerId,
  requestId,
}: {
  locale: Locale;
  customerId: string;
  requestId: string;
}) {
  const t = useTranslations("AdminMoney.adjust");
  const w = useTranslations("AdminMoney.wallet");
  return (
    <Card title={t("title")}>
      <p>{t("intro")}</p>
      <form action={moneyAction}>
        <Hidden locale={locale} kind="createAdjustment" id={requestId} customerId={customerId} />
        <FormBlock>
          <Select
            id="adjust-direction"
            name="direction"
            label={t("direction")}
            options={[
              { value: "credit", text: w("direction.credit") },
              { value: "debit", text: w("direction.debit") },
            ]}
          />
          <Field
            name="amount"
            id="adjust-amount"
            label={t("amount")}
            hint={t("amountHint")}
            required
            inputMode="decimal"
            maxLength={19}
            autoComplete="off"
          />
          <Select
            id="adjust-kind"
            name="adjustmentKind"
            label={t("kind")}
            value="deposit"
            options={(["goodwill", "deposit", "correction"] as const).map((k) => ({
              value: k,
              text: t(`kinds.${k}`),
            }))}
          />
          <Field
            name="evidence"
            id="adjust-evidence"
            label={t("evidence")}
            hint={t("evidenceHint")}
            optional
            maxLength={200}
            autoComplete="off"
          />
          <ReasonField suffix="adjust" />
        </FormBlock>
        <p className="form-text seccolor">{t("splitHint")}</p>
        <SubmitButton variant="primary" size="sm">
          {t("submit")}
        </SubmitButton>
      </form>
    </Card>
  );
}

function AdjustmentTable({
  locale,
  rows,
  caption,
  customerId,
  adminId,
  canDecide,
}: {
  locale: Locale;
  rows: AdjustmentRow[];
  caption: string;
  customerId: string;
  adminId: string;
  canDecide: boolean;
}) {
  const t = useTranslations("AdminMoney.adjust");
  const w = useTranslations("AdminMoney.wallet");
  const columns: DataTableColumn<AdjustmentRow>[] = [
    {
      key: "when",
      header: t("columns.when"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    {
      key: "direction",
      header: t("columns.direction"),
      cell: (row) => w(`direction.${row.direction}`),
    },
    {
      key: "amount",
      header: t("columns.amount"),
      cell: (row) => <MoneyText minor={row.amountMinor} />,
    },
    { key: "kind", header: t("columns.kind"), cell: (row) => t(`kinds.${row.kind}`) },
    { key: "reason", header: t("columns.reason"), cell: (row) => row.reason },
    { key: "evidence", header: t("columns.evidence"), cell: (row) => row.evidenceRef ?? "-" },
    {
      key: "status",
      header: t("columns.status"),
      cell: (row) => (
        <Badge
          tone={row.status === "approved" ? "purple" : row.status === "pending" ? "dark" : "grey"}
        >
          {t(`status.${row.status}`)}
        </Badge>
      ),
    },
    { key: "by", header: t("columns.by"), cell: (row) => <ShortId id={row.requestedBy} /> },
  ];
  if (canDecide) {
    columns.push({
      key: "action",
      header: t("columns.action"),
      cell: (row) => {
        if (row.status !== "pending") return "-";
        if (row.requestedBy === adminId) return t("own");
        return (
          <div>
            <form action={moneyAction} className="mb-2">
              <Hidden
                locale={locale}
                kind="approveAdjustment"
                id={row.id}
                customerId={customerId}
              />
              <ReasonField suffix={`approve-${row.id}`} />
              <SubmitButton variant="primary" size="sm">
                {t("approve")}
              </SubmitButton>
            </form>
            <form action={moneyAction}>
              <Hidden locale={locale} kind="rejectAdjustment" id={row.id} customerId={customerId} />
              <ReasonField suffix={`reject-${row.id}`} />
              <SubmitButton variant="destructive" size="sm">
                {t("reject")}
              </SubmitButton>
            </form>
          </div>
        );
      },
    });
  }
  return <DataTable caption={caption} columns={columns} rows={rows} rowKey={(row) => row.id} />;
}

export interface WalletViewProps {
  locale: Locale;
  wallet: WalletAdminDetail;
  adminId: string;
  // finance creates; finance and superadmin decide.
  canCreate: boolean;
  canDecide: boolean;
  // Made at render time: the request id of the form, so a double submit is one request (R7).
  requestId: string;
  result: ResultCode | null;
}

// 16.12 /wallets/[customerId].
export function WalletView({
  locale,
  wallet,
  adminId,
  canCreate,
  canDecide,
  requestId,
  result,
}: WalletViewProps) {
  const t = useTranslations("AdminMoney");
  return (
    <>
      <h2 className="h4 mergecolor">{t("wallet.title")}</h2>
      <p>
        <Button
          href={localePath(locale, "/payments")}
          variant="tertiary"
          size="sm"
          icon="fas fa-arrow-left"
        >
          {t("wallet.back")}
        </Button>
      </p>
      <ResultLine result={result} />
      <Card>
        <dl className="mb-0">
          <dt>{t("wallet.customer")}</dt>
          <dd>{wallet.customerId}</dd>
          <dt>{t("wallet.balance")}</dt>
          <dd>
            <MoneyText minor={wallet.balanceMinor} />
          </dd>
          <dt>{t("wallet.limit")}</dt>
          <dd>
            {wallet.limitMinor === 0n ? (
              t("wallet.noLimit")
            ) : (
              <MoneyText minor={wallet.limitMinor} />
            )}
          </dd>
        </dl>
        {wallet.consistent ? null : (
          <p role="alert" className="mt-3 mb-0">
            <i className="fas fa-exclamation-circle me-1" aria-hidden="true" />
            {t("wallet.inconsistent")}
          </p>
        )}
      </Card>
      {canCreate ? (
        <AdjustmentForm locale={locale} customerId={wallet.customerId} requestId={requestId} />
      ) : (
        <p className="mb-3">{t("adjust.readOnly")}</p>
      )}
      <Card title={t("adjust.pendingTitle")}>
        {wallet.pending.length === 0 ? (
          <p className="mb-0">{t("adjust.pendingEmpty")}</p>
        ) : (
          <AdjustmentTable
            locale={locale}
            rows={wallet.pending}
            caption={t("adjust.pendingCaption")}
            customerId={wallet.customerId}
            adminId={adminId}
            canDecide={canDecide}
          />
        )}
      </Card>
      <LedgerCard locale={locale} wallet={wallet} />
      <Card title={t("adjust.decidedTitle")}>
        {wallet.decided.length === 0 ? (
          <p className="mb-0">{t("adjust.decidedEmpty")}</p>
        ) : (
          <AdjustmentTable
            locale={locale}
            rows={wallet.decided}
            caption={t("adjust.decidedCaption")}
            customerId={wallet.customerId}
            adminId={adminId}
            canDecide={false}
          />
        )}
      </Card>
    </>
  );
}

// -------------------------------------------------------------------------------------- payments

function listHref(locale: Locale, query: PaymentQuery, after: string | null): string {
  const params = new URLSearchParams();
  if (query.q !== "") params.set("q", query.q);
  if (query.status !== null) params.set("status", query.status);
  if (after !== null) params.set("after", after);
  const text = params.toString();
  return `${localePath(locale, "/payments")}${text === "" ? "" : `?${text}`}`;
}

function SearchForm({ locale, query }: { locale: Locale; query: PaymentQuery }) {
  const t = useTranslations("AdminMoney.payments");
  return (
    <form method="get" action={localePath(locale, "/payments")} className="mb-4">
      <FormBlock>
        <Field
          name="q"
          type="search"
          label={t("search.label")}
          placeholder={t("search.placeholder")}
          hint={t("search.hint")}
          defaultValue={query.q}
          maxLength={100}
          autoComplete="off"
        />
        <Select
          id="status-filter"
          name="status"
          label={t("search.statusLabel")}
          value={query.status ?? ""}
          options={[
            { value: "", text: t("search.all") },
            ...PAYMENT_STATUSES.map((s) => ({ value: s, text: t(`status.${s}`) })),
          ]}
        />
      </FormBlock>
      <Button type="submit" variant="primary" size="sm">
        {t("search.submit")}
      </Button>
    </form>
  );
}

function PaymentTable({
  locale,
  query,
  result,
}: {
  locale: Locale;
  query: PaymentQuery;
  result: PaymentSearchResult;
}) {
  const t = useTranslations("AdminMoney.payments");
  const columns: DataTableColumn<PaymentListRow>[] = [
    {
      key: "merchant",
      header: t("table.merchant"),
      cell: (row) => (
        <a href={localePath(locale, `/payments/${row.id}`)}>{row.merchantTransactionId}</a>
      ),
    },
    {
      key: "customer",
      header: t("table.customer"),
      cell: (row) => (
        <a href={localePath(locale, `/wallets/${row.customerId}`)}>
          <ShortId id={row.customerId} />
        </a>
      ),
    },
    {
      key: "amount",
      header: t("table.amount"),
      cell: (row) => <MoneyText minor={row.amountMinor} />,
    },
    {
      key: "status",
      header: t("table.status"),
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "created",
      header: t("table.created"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    {
      key: "verified",
      header: t("table.verified"),
      cell: (row) =>
        row.verifiedAt === null ? "-" : <DateText value={row.verifiedAt} variant="datetime" />,
    },
  ];
  if (result.rows.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  return (
    <DataTable
      caption={t("table.caption")}
      columns={columns}
      rows={result.rows}
      rowKey={(row) => row.id}
      prevHref={undefined}
      nextHref={result.nextAfter === null ? null : listHref(locale, query, result.nextAfter)}
    />
  );
}

function ReasonText({ code }: { code: string | null }) {
  const t = useTranslations("AdminMoney.discrepancies.reasons");
  if (code === null) return <>-</>;
  return (
    <>{(REASON_CODES as readonly string[]).includes(code) ? t(code as "currency") : t("other")}</>
  );
}

function DiscrepancyTable({
  locale,
  rows,
  canResolve,
}: {
  locale: Locale;
  rows: DiscrepancyRow[];
  canResolve: boolean;
}) {
  const t = useTranslations("AdminMoney.discrepancies");
  const columns: DataTableColumn<DiscrepancyRow>[] = [
    {
      key: "when",
      header: t("columns.when"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    {
      key: "payment",
      header: t("columns.payment"),
      cell: (row) =>
        row.paymentId === null ? (
          "-"
        ) : (
          <a href={localePath(locale, `/payments/${row.paymentId}`)}>
            <ShortId id={row.paymentId} />
          </a>
        ),
    },
    { key: "reason", header: t("columns.reason"), cell: (row) => <ReasonText code={row.reason} /> },
    {
      key: "expected",
      header: t("columns.expected"),
      cell: (row) => (row.expectedMinor === null ? "-" : <MoneyText minor={row.expectedMinor} />),
    },
    {
      key: "got",
      header: t("columns.got"),
      cell: (row) => (row.gotMinor === null ? "-" : <MoneyText minor={row.gotMinor} />),
    },
  ];
  if (canResolve) {
    columns.push({
      key: "action",
      header: t("columns.action"),
      cell: (row) =>
        row.status !== "open" ? (
          "-"
        ) : (
          <form action={moneyAction}>
            <Hidden locale={locale} kind="resolveDiscrepancy" id={row.id} />
            <ReasonField suffix={`resolve-${row.id}`} hint={t("resolveHint")} />
            <SubmitButton variant="primary" size="sm">
              {t("resolve")}
            </SubmitButton>
          </form>
        ),
    });
  }
  return (
    <DataTable caption={t("caption")} columns={columns} rows={rows} rowKey={(row) => row.id} />
  );
}

export interface PaymentsViewProps {
  locale: Locale;
  query: PaymentQuery;
  list: { kind: "ok"; value: PaymentSearchResult } | { kind: "unavailable" | "missing" };
  discrepancies: { kind: "ok"; value: DiscrepancyRow[] } | { kind: "unavailable" | "missing" };
  canResolve: boolean;
  result: ResultCode | null;
}

// 16.12 /payments: search, the states, and the open payment discrepancies with the resolve action.
export function PaymentsView({
  locale,
  query,
  list,
  discrepancies,
  canResolve,
  result,
}: PaymentsViewProps) {
  const t = useTranslations("AdminMoney");
  const unavailable = (
    <EmptyState
      title={t("payments.unavailable.title")}
      description={t("payments.unavailable.body")}
    />
  );
  return (
    <>
      <h2 className="h4 mergecolor">{t("payments.title")}</h2>
      <ResultLine result={result} />
      <p className="form-text seccolor">{t("payments.reviewNote")}</p>
      <Card>
        <SearchForm locale={locale} query={query} />
      </Card>
      {list.kind === "ok" ? (
        <PaymentTable locale={locale} query={query} result={list.value} />
      ) : (
        unavailable
      )}
      <Card title={t("discrepancies.title")}>
        {discrepancies.kind !== "ok" ? (
          unavailable
        ) : discrepancies.value.length === 0 ? (
          <p className="mb-0">{t("discrepancies.empty")}</p>
        ) : (
          <DiscrepancyTable locale={locale} rows={discrepancies.value} canResolve={canResolve} />
        )}
      </Card>
    </>
  );
}

export interface PaymentDetailViewProps {
  locale: Locale;
  payment: PaymentAdminDetail;
  canAct: boolean;
  canResolve: boolean;
  result: ResultCode | null;
}

// 16.12 /payments/[id]: the state and the verify payload, `reverifyPayment`, `recordManualRefund`.
export function PaymentDetailView({
  locale,
  payment,
  canAct,
  canResolve,
  result,
}: PaymentDetailViewProps) {
  const t = useTranslations("AdminMoney");
  const payload = payment.verifyPayload === null ? [] : Object.entries(payment.verifyPayload);
  const canReverify = payment.status === "review" || payment.status === "expired";
  return (
    <>
      <h2 className="h4 mergecolor">{t("payment.title")}</h2>
      <p>
        <Button
          href={localePath(locale, "/payments")}
          variant="tertiary"
          size="sm"
          icon="fas fa-arrow-left"
        >
          {t("payment.back")}
        </Button>
      </p>
      <ResultLine result={result} />
      <Card>
        <dl className="mb-0">
          <dt>{t("payment.id")}</dt>
          <dd>{payment.id}</dd>
          <dt>{t("payment.merchant")}</dt>
          <dd>{payment.merchantTransactionId}</dd>
          <dt>{t("payment.gatewayId")}</dt>
          <dd>{payment.gatewayTransactionId ?? "-"}</dd>
          <dt>{t("payment.customer")}</dt>
          <dd>
            <a href={localePath(locale, `/wallets/${payment.customerId}`)}>
              {t("payment.walletLink")}
            </a>{" "}
            <ShortId id={payment.customerId} />
          </dd>
          <dt>{t("payment.amount")}</dt>
          <dd>
            <MoneyText minor={payment.amountMinor} />
          </dd>
          <dt>{t("payment.status")}</dt>
          <dd>
            <StatusBadge status={payment.status} />
          </dd>
          <dt>{t("payment.created")}</dt>
          <dd>
            <DateText value={payment.createdAt} variant="datetime" />
          </dd>
          <dt>{t("payment.verified")}</dt>
          <dd>
            {payment.verifiedAt === null ? (
              t("payment.notVerified")
            ) : (
              <DateText value={payment.verifiedAt} variant="datetime" />
            )}
          </dd>
          <dt>{t("payment.ledger")}</dt>
          <dd>{payment.ledgerTransactionId ?? "-"}</dd>
        </dl>
        {payment.status === "review" ? (
          <p className="mt-3 mb-0">{t("payments.reviewNote")}</p>
        ) : null}
      </Card>
      <Card title={t("payment.payloadTitle")}>
        <p className="form-text seccolor">{t("payment.payloadHint")}</p>
        {payload.length === 0 ? (
          <p className="mb-0">{t("payment.payloadNone")}</p>
        ) : (
          <dl className="mb-0">
            {payload.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value === null ? "-" : String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
      {payment.discrepancies.length === 0 ? null : (
        <Card title={t("discrepancies.title")}>
          <DiscrepancyTable locale={locale} rows={payment.discrepancies} canResolve={canResolve} />
        </Card>
      )}
      <Card title={t("payment.reverifyTitle")}>
        <p>{t("payment.reverifyHint")}</p>
        {canAct && canReverify ? (
          <form action={moneyAction}>
            <Hidden locale={locale} kind="reverifyPayment" id={payment.id} />
            <ReasonField suffix="reverify" />
            <SubmitButton variant="primary" size="sm">
              {t("payment.reverifySubmit")}
            </SubmitButton>
          </form>
        ) : (
          <p className="form-text seccolor mb-0">
            {canAct ? t("payment.reverifyNotNow") : t("payment.readOnly")}
          </p>
        )}
      </Card>
      <Card title={t("payment.refundTitle")}>
        {payment.refund === null ? (
          <p>{t("payment.refundNone")}</p>
        ) : (
          <p>
            {t("payment.refundDone")}: <MoneyText minor={payment.refund.amountMinor} />{" "}
            <DateText value={payment.refund.createdAt} variant="datetime" />
          </p>
        )}
        <p className="form-text seccolor">{t("payment.refundHint")}</p>
        {canAct && payment.status === "credited" && payment.refund === null ? (
          <form action={moneyAction}>
            <Hidden locale={locale} kind="recordManualRefund" id={payment.id} />
            <Field
              name="amount"
              id="refund-amount"
              label={t("payment.refundAmount")}
              hint={t("adjust.amountHint")}
              required
              inputMode="decimal"
              maxLength={19}
              autoComplete="off"
            />
            <ReasonField suffix="refund" />
            <SubmitButton variant="destructive" size="sm">
              {t("payment.refundSubmit")}
            </SubmitButton>
          </form>
        ) : canAct && payment.status !== "credited" ? (
          <p className="form-text seccolor mb-0">{t("payment.refundOnlyCredited")}</p>
        ) : null}
      </Card>
    </>
  );
}
