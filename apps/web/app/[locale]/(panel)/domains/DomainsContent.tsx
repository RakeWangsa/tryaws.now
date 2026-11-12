import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  MoneyText,
  StateBadge,
  formatDate,
} from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type {
  DomainListScreen,
  DomainRowView,
  DomainSearchScreen,
  TldOption,
} from "../../../../server/domain-view.ts";

// The content of /domains (16.10): the search with its answer and the TLD table, then the customer's
// domains. The markup follows domains.html and clientareadomains.tpl through the kit (see
// mockup-anchors.ts). Every price was computed on the server (R4). The search is a GET form: it
// changes nothing.

const BADGE_OF: Record<string, BadgeState> = {
  pending: "creating",
  review: "pending",
  awaiting_verification: "grace",
  registered: "running",
  failed: "problem",
  expired: "stopped",
};

export function DomainState({ state }: { state: string }) {
  const t = useTranslations("Domains.state");
  const known = Object.hasOwn(BADGE_OF, state);
  return (
    <StateBadge
      state={known ? (BADGE_OF[state] as BadgeState) : "problem"}
      label={known ? t(state) : t("failed")}
    />
  );
}

function SearchBox({ query }: { query?: string }) {
  const t = useTranslations("Domains.search");
  return (
    <form method="get" className="mb-4" noValidate>
      <Field
        name="q"
        label={t("label")}
        type="search"
        placeholder={t("placeholder")}
        hint={t("hint")}
        maxLength={253}
        autoComplete="off"
        {...(query !== undefined ? { defaultValue: query } : {})}
      />
      <Button variant="primary" type="submit" icon="fas fa-search">
        {t("submit")}
      </Button>
    </form>
  );
}

function TldTable({ tlds, numerals }: { tlds: TldOption[]; numerals: "beng" | "latn" }) {
  const t = useTranslations("Domains.tlds");
  return (
    <Card>
      <DataTable
        caption={t("caption")}
        columns={[
          { key: "tld", header: t("tld"), cell: (row: TldOption) => `.${row.tld}` },
          {
            key: "price",
            header: t("price"),
            cell: (row: TldOption) => (
              <MoneyText minor={row.priceMinor} mode="exact" numerals={numerals} />
            ),
          },
          {
            key: "note",
            header: t("note"),
            cell: (row: TldOption) => (row.decision === "review" ? t("review") : ""),
          },
        ]}
        rows={tlds}
        rowKey={(row) => row.tld}
      />
    </Card>
  );
}

function Answer({
  locale,
  numerals,
  screen,
}: {
  locale: Locale;
  numerals: "beng" | "latn";
  screen: Exclude<DomainSearchScreen, { state: "flag_off" }>;
}) {
  const t = useTranslations("Domains.search");
  if (screen.state === "invalid") {
    return (
      <p className="tc-field-error mb-3" role="alert">
        {t("invalid")}
      </p>
    );
  }
  if (screen.state === "search_unavailable") {
    return (
      <p className="seccolor mb-3" role="status">
        {t("unavailableService")}
      </p>
    );
  }
  if (screen.state !== "result") return null;
  const { availability, name } = screen;
  return (
    <Card className="mb-4">
      <h2 className="h5 mergecolor">{t(`result.${availability}`, { name })}</h2>
      {availability === "available" ? (
        <>
          <p className="mb-2">
            <MoneyText minor={screen.priceMinor} mode="exact" numerals={numerals} />{" "}
            {t("result.price")}
          </p>
          {screen.decision === "review" ? (
            <p className="seccolor">{t("result.reviewNote")}</p>
          ) : null}
          <Button
            variant="primary"
            href={`${localePath(locale, "/domains/new")}?name=${encodeURIComponent(name)}`}
          >
            {t("result.register")}
          </Button>
        </>
      ) : null}
    </Card>
  );
}

export function DomainsContent({
  locale,
  numerals,
  search,
  list,
  query,
}: {
  locale: Locale;
  numerals: "beng" | "latn";
  search: DomainSearchScreen;
  list: DomainListScreen;
  query?: string;
}) {
  const t = useTranslations("Domains");

  if (search.state === "flag_off" || list.state === "flag_off") {
    // R12: the flag is off. 16.13: the coming soon state, with words and no action that could buy.
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }

  const columns = [
    {
      key: "name",
      header: t("list.name"),
      cell: (row: DomainRowView) => (
        <a href={localePath(locale, `/domains/${encodeURIComponent(row.name)}`)}>{row.name}</a>
      ),
    },
    {
      key: "state",
      header: t("list.state"),
      cell: (row: DomainRowView) => <DomainState state={row.state} />,
    },
    {
      key: "expires",
      header: t("list.expires"),
      cell: (row: DomainRowView) =>
        row.expiresAt === null ? t("list.none") : formatDate(row.expiresAt, { locale, numerals }),
    },
  ];

  return (
    <>
      <p className="seccolor mb-3">{t("awsNote")}</p>
      <SearchBox {...(query !== undefined ? { query } : {})} />
      <Answer locale={locale} numerals={numerals} screen={search} />
      <h2 className="h5 mergecolor mb-3">{t("list.heading")}</h2>
      {list.items.length === 0 ? (
        <EmptyState title={t("list.empty.title")} description={t("list.empty.body")} />
      ) : (
        <Card className="mb-4">
          <DataTable
            caption={t("list.caption")}
            columns={columns}
            rows={list.items}
            rowKey={(row) => row.name}
          />
        </Card>
      )}
      {search.tlds.length > 0 ? <TldTable tlds={search.tlds} numerals={numerals} /> : null}
    </>
  );
}
