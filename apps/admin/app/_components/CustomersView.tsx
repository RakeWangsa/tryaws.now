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
  type DataTableColumn,
} from "@tc/ui";
import type { CustomerListRow, CustomerSearchResult, KycQueueRow } from "@tc/db";
import { localePath, type Locale } from "@tc/ui/runtime";
import type { ListQuery, Loaded } from "../../server/customers-data.ts";

const KYC_FILTERS = ["pending", "verified", "rejected", "none"] as const;

function KycBadge({ status }: { status: string }) {
  const t = useTranslations("AdminCustomers.kycStatus");
  const tone = status === "verified" ? "purple" : status === "pending" ? "dark" : "grey";
  const known = ["none", "pending", "verified", "rejected"].includes(status);
  return <Badge tone={tone}>{known ? t(status as "none") : status}</Badge>;
}

function listHref(locale: Locale, query: ListQuery, after: string | null): string {
  const params = new URLSearchParams();
  if (query.q !== "") params.set("q", query.q);
  if (query.kyc !== null) params.set("kyc", query.kyc);
  if (after !== null) params.set("after", after);
  const text = params.toString();
  return `${localePath(locale, "/customers")}${text === "" ? "" : `?${text}`}`;
}

function SearchForm({ locale, query }: { locale: Locale; query: ListQuery }) {
  const t = useTranslations("AdminCustomers");
  return (
    <form method="get" action={localePath(locale, "/customers")} className="mb-4">
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
        <div className="position-relative mb-3">
          <label className="seccolor" htmlFor="kyc-filter">
            {t("search.kycLabel")}
          </label>
          <select
            id="kyc-filter"
            name="kyc"
            className="form-control"
            defaultValue={query.kyc ?? ""}
          >
            <option value="">{t("search.all")}</option>
            {KYC_FILTERS.map((status) => (
              <option key={status} value={status}>
                {t(`kycStatus.${status}`)}
              </option>
            ))}
          </select>
        </div>
      </FormBlock>
      <Button type="submit" variant="primary" size="sm">
        {t("search.submit")}
      </Button>
    </form>
  );
}

function ListTable({
  locale,
  query,
  result,
}: {
  locale: Locale;
  query: ListQuery;
  result: CustomerSearchResult;
}) {
  const t = useTranslations("AdminCustomers");
  const columns: DataTableColumn<CustomerListRow>[] = [
    {
      key: "name",
      header: t("table.name"),
      cell: (row) => (
        <a href={localePath(locale, `/customers/${row.id}`)}>{row.name ?? t("table.noName")}</a>
      ),
    },
    { key: "email", header: t("table.email"), cell: (row) => row.emailMasked },
    { key: "phone", header: t("table.phone"), cell: (row) => row.phoneMasked ?? "-" },
    { key: "kyc", header: t("table.kyc"), cell: (row) => <KycBadge status={row.kycStatus} /> },
    {
      key: "tier",
      header: t("table.tier"),
      cell: (row) => (row.riskTier === "trusted" ? t("riskTier.trusted") : t("riskTier.new")),
    },
    {
      key: "status",
      header: t("table.status"),
      cell: (row) => (row.status === "suspended" ? t("status.suspended") : t("status.active")),
    },
    {
      key: "created",
      header: t("table.created"),
      cell: (row) => <DateText value={row.createdAt} />,
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

function QueueTable({ locale, rows }: { locale: Locale; rows: KycQueueRow[] }) {
  const t = useTranslations("AdminCustomers");
  if (rows.length === 0) {
    return <EmptyState title={t("queueEmpty.title")} description={t("queueEmpty.body")} />;
  }
  const columns: DataTableColumn<KycQueueRow>[] = [
    {
      key: "name",
      header: t("table.name"),
      cell: (row) => (
        <a href={localePath(locale, `/customers/${row.customerId}`)}>
          {row.customerName ?? t("table.noName")}
        </a>
      ),
    },
    { key: "document", header: t("table.document"), cell: (row) => row.documentType },
    {
      key: "submitted",
      header: t("table.submitted"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
  ];
  return (
    <DataTable
      caption={t("table.queueCaption")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.submissionId}
    />
  );
}

export interface CustomersViewProps {
  locale: Locale;
  query: ListQuery;
  list: Loaded<CustomerSearchResult>;
  // Present when the screen is the queue (kyc=pending and no search words).
  queue: Loaded<KycQueueRow[]> | null;
}

// 16.12 /customers: the search, and the KYC queue as the same screen with the filter "waiting".
export function CustomersView({ locale, query, list, queue }: CustomersViewProps) {
  const t = useTranslations("AdminCustomers");
  const unavailable = (
    <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
  );
  return (
    <>
      <h2 className="h4 mergecolor">{queue === null ? t("title") : t("queueTitle")}</h2>
      <p className="mb-3">
        <a href={localePath(locale, "/customers")} className="me-3">
          {t("title")}
        </a>
        <a href={`${localePath(locale, "/customers")}?kyc=pending`}>{t("queueTitle")}</a>
      </p>
      <Card>
        <SearchForm locale={locale} query={query} />
      </Card>
      {queue !== null ? (
        queue.kind === "ok" ? (
          <QueueTable locale={locale} rows={queue.value} />
        ) : (
          unavailable
        )
      ) : list.kind === "ok" ? (
        <ListTable locale={locale} query={query} result={list.value} />
      ) : (
        unavailable
      )}
    </>
  );
}
