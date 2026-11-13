import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateText,
  Field,
  MoneyText,
  SubmitButton,
  type DataTableColumn,
} from "@tc/ui";
import type { CustomerAuditRow, CustomerDetail, AdminKycSubmissionView } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import { customerDecisionAction } from "../../server/customer-actions.ts";

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

function Hidden({
  locale,
  customerId,
  kind,
  id,
}: {
  locale: Locale;
  customerId: string;
  kind: string;
  id: string;
}) {
  return (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
    </>
  );
}

function ReasonField({ suffix }: { suffix: string }) {
  const t = useTranslations("AdminCustomers.reason");
  return (
    <Field
      name="reason"
      id={`reason-${suffix}`}
      label={t("label")}
      hint={t("hint")}
      required
      maxLength={500}
      autoComplete="off"
    />
  );
}

function ProfileCard({ customer, locale }: { customer: CustomerDetail; locale: Locale }) {
  const t = useTranslations("AdminCustomers");
  const typeText =
    customer.type === "individual"
      ? t("detail.typeIndividual")
      : customer.type === "business"
        ? t("detail.typeBusiness")
        : t("detail.typeNone");
  const known = (value: string, group: "kycStatus" | "riskTier" | "status") =>
    t(`${group}.${value}` as "status.active");
  return (
    <Card title={t("detail.profile")}>
      <dl className="mb-0">
        <dt>{t("detail.id")}</dt>
        <dd>{customer.id}</dd>
        <dt>{t("detail.name")}</dt>
        <dd>{customer.name ?? t("table.noName")}</dd>
        <dt>{t("detail.type")}</dt>
        <dd>{typeText}</dd>
        <dt>{t("detail.email")}</dt>
        <dd>{customer.emailMasked}</dd>
        <dt>{t("detail.phone")}</dt>
        <dd>{customer.phoneMasked ?? "-"}</dd>
        <dt>{t("detail.phoneVerified")}</dt>
        <dd>{customer.phoneVerified ? t("detail.yes") : t("detail.no")}</dd>
        <dt>{t("detail.market")}</dt>
        <dd>{customer.market}</dd>
        <dt>{t("detail.locale")}</dt>
        <dd>{customer.locale}</dd>
        <dt>{t("table.kyc")}</dt>
        <dd>
          <Badge tone={customer.kycStatus === "verified" ? "purple" : "grey"}>
            {known(customer.kycStatus, "kycStatus")}
          </Badge>
        </dd>
        <dt>{t("table.tier")}</dt>
        <dd>{known(customer.riskTier, "riskTier")}</dd>
        <dt>{t("table.status")}</dt>
        <dd>{known(customer.status, "status")}</dd>
        <dt>{t("detail.wallet")}</dt>
        <dd>
          {customer.wallet === null ? (
            t("detail.noWallet")
          ) : (
            <>
              <MoneyText minor={customer.wallet.balanceMinor} />{" "}
              <a href={localePath(locale, `/wallets/${customer.id}`)}>{t("detail.walletLink")}</a>
            </>
          )}
        </dd>
        <dt>{t("detail.resources")}</dt>
        <dd>{customer.resourceCount}</dd>
        <dt>{t("table.created")}</dt>
        <dd>
          <DateText value={customer.createdAt} variant="datetime" />
        </dd>
      </dl>
    </Card>
  );
}

function SubmissionCard({
  customer,
  submission,
  locale,
  canAct,
  latest,
}: {
  customer: CustomerDetail;
  submission: AdminKycSubmissionView;
  locale: Locale;
  canAct: boolean;
  latest: boolean;
}) {
  const t = useTranslations("AdminCustomers");
  const images = Array.from({ length: submission.documentCount }, (_, i) => i);
  return (
    <div className="mb-4">
      <dl className="mb-2">
        <dt>{t("kyc.documentType")}</dt>
        <dd>{submission.documentType}</dd>
        <dt>{t("kyc.status")}</dt>
        <dd>
          <Badge tone={submission.status === "verified" ? "purple" : "grey"}>
            {t(`kycStatus.${submission.status as "pending"}`)}
          </Badge>
        </dd>
        <dt>{t("kyc.submitted")}</dt>
        <dd>
          <DateText value={submission.createdAt} variant="datetime" />
        </dd>
        {submission.reviewedAt !== null ? (
          <>
            <dt>{t("kyc.reviewed")}</dt>
            <dd>
              <DateText value={submission.reviewedAt} variant="datetime" />
            </dd>
          </>
        ) : null}
        {submission.note !== null ? (
          <>
            <dt>{t("kyc.note")}</dt>
            <dd>{submission.note}</dd>
          </>
        ) : null}
      </dl>
      <p className="mb-1">{t("kyc.documents")}</p>
      <form
        method="get"
        action={`/api/kyc-document/${submission.id}/0`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Field
          name="reason"
          id={`kyc-view-reason-${submission.id}`}
          label={t("kyc.viewReasonLabel")}
          hint={t("kyc.viewReasonHint")}
          required
          maxLength={500}
          autoComplete="off"
        />
        <ul className="list-unstyled mb-2">
          {images.map((index) => (
            <li key={index}>
              <Button
                type="submit"
                variant="tertiary"
                size="sm"
                formAction={`/api/kyc-document/${submission.id}/${index}`}
                formTarget="_blank"
              >
                {t("kyc.view", { n: index + 1 })}
              </Button>
            </li>
          ))}
        </ul>
      </form>
      <p className="form-text seccolor">{t("kyc.viewHint")}</p>
      {submission.status === "pending" && canAct && latest ? (
        <div className="row">
          <div className="col-md-6">
            <form action={customerDecisionAction}>
              <Hidden
                locale={locale}
                customerId={customer.id}
                kind="approveKyc"
                id={submission.id}
              />
              <h3 className="h5 mergecolor">{t("approve.title")}</h3>
              <ReasonField suffix={`approve-${submission.id}`} />
              <SubmitButton variant="primary" size="sm">
                {t("approve.submit")}
              </SubmitButton>
            </form>
          </div>
          <div className="col-md-6">
            <form action={customerDecisionAction}>
              <Hidden
                locale={locale}
                customerId={customer.id}
                kind="rejectKyc"
                id={submission.id}
              />
              <h3 className="h5 mergecolor">{t("reject.title")}</h3>
              <ReasonField suffix={`reject-${submission.id}`} />
              <Field
                name="note"
                id={`note-${submission.id}`}
                label={t("reject.noteLabel")}
                hint={t("reject.noteHint")}
                optional
                multiline
                rows={2}
                maxLength={500}
              />
              <SubmitButton variant="destructive" size="sm">
                {t("reject.submit")}
              </SubmitButton>
            </form>
          </div>
        </div>
      ) : null}
      {submission.status === "pending" && canAct && !latest ? (
        <p className="form-text seccolor">{t("kyc.onlyLatest")}</p>
      ) : null}
    </div>
  );
}

function KycCard({
  customer,
  locale,
  canAct,
}: {
  customer: CustomerDetail;
  locale: Locale;
  canAct: boolean;
}) {
  const t = useTranslations("AdminCustomers");
  return (
    <Card title={t("kyc.title")}>
      {customer.kycSubmissions.length === 0 ? (
        <p className="mb-0">{t("kyc.none")}</p>
      ) : (
        customer.kycSubmissions.map((submission, index) => (
          <SubmissionCard
            key={submission.id}
            customer={customer}
            submission={submission}
            locale={locale}
            canAct={canAct}
            latest={index === 0}
          />
        ))
      )}
    </Card>
  );
}

function DecisionCards({ customer, locale }: { customer: CustomerDetail; locale: Locale }) {
  const t = useTranslations("AdminCustomers");
  const suspended = customer.status === "suspended";
  return (
    <div className="row">
      <div className="col-lg-6">
        <Card title={t("tier.title")}>
          <form action={customerDecisionAction}>
            <Hidden locale={locale} customerId={customer.id} kind="setRiskTier" id={customer.id} />
            <div className="position-relative mb-3">
              <label className="seccolor" htmlFor="tier-select">
                {t("tier.label")}
              </label>
              <select
                id="tier-select"
                name="tier"
                className="form-control"
                defaultValue={customer.riskTier}
              >
                <option value="new">{t("riskTier.new")}</option>
                <option value="trusted">{t("riskTier.trusted")}</option>
              </select>
            </div>
            <ReasonField suffix="tier" />
            <SubmitButton variant="primary" size="sm">
              {t("tier.submit")}
            </SubmitButton>
          </form>
        </Card>
      </div>
      <div className="col-lg-6">
        <Card title={t("account.title")}>
          <form action={customerDecisionAction}>
            <Hidden
              locale={locale}
              customerId={customer.id}
              kind={suspended ? "resume" : "suspend"}
              id={customer.id}
            />
            <ReasonField suffix="account" />
            {suspended ? null : <p className="form-text seccolor">{t("account.suspendHint")}</p>}
            <SubmitButton variant={suspended ? "primary" : "destructive"} size="sm">
              {suspended ? t("account.resume") : t("account.suspend")}
            </SubmitButton>
          </form>
        </Card>
      </div>
    </div>
  );
}

function AuditCard({ rows }: { rows: CustomerAuditRow[] }) {
  const t = useTranslations("AdminCustomers");
  const columns: DataTableColumn<CustomerAuditRow>[] = [
    { key: "action", header: t("audit.action"), cell: (row) => row.action },
    {
      key: "actor",
      header: t("audit.actor"),
      cell: (row) => (row.actorId === null ? "-" : `#${row.actorId.slice(0, 8)}`),
    },
    { key: "reason", header: t("audit.reason"), cell: (row) => row.reason ?? "-" },
    {
      key: "when",
      header: t("audit.when"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
  ];
  return (
    <Card title={t("audit.title")}>
      {rows.length === 0 ? (
        <p className="mb-0">{t("audit.empty")}</p>
      ) : (
        <DataTable
          caption={t("audit.caption")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
      )}
    </Card>
  );
}

export interface CustomerDetailViewProps {
  locale: Locale;
  customer: CustomerDetail;
  // ops and superadmin decide; support only reads.
  canAct: boolean;
  result: ResultCode | null;
}

// 16.12 /customers/[id].
export function CustomerDetailView({ locale, customer, canAct, result }: CustomerDetailViewProps) {
  const t = useTranslations("AdminCustomers");
  return (
    <>
      <h2 className="h4 mergecolor">{customer.name ?? t("table.noName")}</h2>
      <p>
        <Button
          href={localePath(locale, "/customers")}
          variant="tertiary"
          size="sm"
          icon="fas fa-arrow-left"
        >
          {t("detail.back")}
        </Button>
      </p>
      {result !== null ? (
        <p role="status" className="mb-3">
          <i
            className={
              result === "ok" || result === "replayed"
                ? "fas fa-check-circle me-1"
                : "fas fa-exclamation-circle me-1"
            }
            aria-hidden="true"
          />
          {t(`result.${result}`)}
        </p>
      ) : null}
      {canAct ? null : <p className="mb-3">{t("detail.readOnly")}</p>}
      <ProfileCard customer={customer} locale={locale} />
      <KycCard customer={customer} locale={locale} canAct={canAct} />
      {canAct ? <DecisionCards customer={customer} locale={locale} /> : null}
      <AuditCard rows={customer.audit} />
    </>
  );
}
