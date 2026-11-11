import type { PaymentRow, StatementLine } from "@tc/db";
import {
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  MoneyText,
  StatTile,
  StateBadge,
  formatMoney,
} from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useFormatter, useTranslations } from "next-intl";
import { publicPaymentState } from "../../../../server/payment-state.ts";
import type { PublicPaymentState } from "../../../../server/payment-state.ts";
import { kindKey } from "../../../../server/wallet-view.ts";
import type { BannerKind, WalletScreen } from "../../../../server/wallet-view.ts";

// The content of /wallet. Synchronous, so it renders in a test without a request. Its markup follows
// the mockup pages named in mockup-anchors.ts.

type Numerals = "beng" | "latn";

const BANNER_LOOK: Record<BannerKind, { alert: string; icon: string; live: "status" | "alert" }> = {
  checking: { alert: "alert alert-info", icon: "fas fa-hourglass-half", live: "status" },
  credited: { alert: "alert alert-info", icon: "fas fa-check-circle", live: "status" },
  failed: { alert: "alert alert-danger", icon: "fas fa-exclamation-triangle", live: "alert" },
  cancelled: { alert: "alert alert-warning", icon: "fas fa-ban", live: "status" },
  expired: { alert: "alert alert-warning", icon: "fas fa-clock", live: "status" },
  unknown: { alert: "alert alert-warning", icon: "fas fa-question-circle", live: "status" },
};

/** complete.tpl and error.tpl: an alert with an icon and words; the colour is never the only sign. */
function Banner({ kind }: { kind: BannerKind }) {
  const t = useTranslations("Wallet.banner");
  const look = BANNER_LOOK[kind];
  return (
    <div className={`${look.alert} text-start`} role={look.live}>
      <i className={`${look.icon} me-2`} aria-hidden="true" />
      {t(kind)}
    </div>
  );
}

const BADGE_OF: Record<PublicPaymentState, BadgeState> = {
  credited: "paid",
  pending: "pending",
  failed: "failed",
  cancelled: "failed",
  expired: "failed",
};

export function WalletContent({
  locale,
  numerals,
  screen,
  banner,
  hasCursor,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: WalletScreen;
  banner: BannerKind | null;
  hasCursor: boolean;
}) {
  const t = useTranslations("Wallet");
  const format = useFormatter();
  const topUpHref = localePath(locale, "/wallet/topup");
  const dash = "—";

  const ledgerColumns = [
    {
      key: "date",
      header: t("ledger.date"),
      cell: (line: StatementLine) => <DateText value={line.createdAt} numerals={numerals} />,
    },
    {
      key: "description",
      header: t("ledger.description"),
      cell: (line: StatementLine) => t(`ledger.kind.${kindKey(line.kind)}`),
    },
    {
      key: "in",
      header: t("ledger.in"),
      cell: (line: StatementLine) =>
        line.direction === "credit" ? (
          <MoneyText minor={line.amountMinor} mode="exact" numerals={numerals} />
        ) : (
          <span aria-label={t("ledger.in")}>{dash}</span>
        ),
    },
    {
      key: "out",
      header: t("ledger.out"),
      cell: (line: StatementLine) =>
        line.direction === "debit" ? (
          <MoneyText minor={line.amountMinor} mode="exact" numerals={numerals} />
        ) : (
          <span aria-label={t("ledger.out")}>{dash}</span>
        ),
    },
    {
      key: "balance",
      header: t("ledger.balance"),
      cell: (line: StatementLine) => (
        <MoneyText minor={line.balanceAfterMinor} mode="exact" numerals={numerals} />
      ),
    },
  ];

  const paymentColumns = [
    {
      key: "date",
      header: t("ledger.date"),
      cell: (row: PaymentRow) => <DateText value={row.createdAt} numerals={numerals} />,
    },
    {
      key: "amount",
      header: t("payments.amount"),
      cell: (row: PaymentRow) => (
        <MoneyText minor={row.amountMinor} mode="exact" numerals={numerals} />
      ),
    },
    {
      key: "state",
      header: t("payments.state"),
      cell: (row: PaymentRow) => {
        const state = publicPaymentState(row.status);
        return <StateBadge state={BADGE_OF[state]} label={t(`state.${state}`)} />;
      },
    },
    {
      key: "view",
      header: t("payments.view"),
      cell: (row: PaymentRow) => (
        <Button
          variant="default"
          size="sm"
          href={localePath(locale, `/wallet/topup/${encodeURIComponent(row.id)}`)}
        >
          {t("payments.view")}
        </Button>
      ),
    },
  ];

  const paged = hasCursor || screen.nextCursor !== null;

  return (
    <div>
      <h1 className="h3 mergecolor mb-4">{t("heading")}</h1>
      {banner !== null ? <Banner kind={banner} /> : null}

      <div className="row g-3 mb-4">
        <div className="col-12 col-md-6">
          <StatTile
            value={formatMoney(screen.balanceMinor, { locale, mode: "exact", numerals })}
            description={t("balance.hint")}
            tag={{ text: t("balance.label"), tone: "purple" }}
          />
        </div>
        <div className="col-12 col-md-6">
          <StatTile
            value={format.number(screen.waitingCount)}
            description={t("open.hint")}
            tag={{ text: t("open.label"), tone: "grey" }}
          />
        </div>
      </div>
      <p className="mb-4">
        <Button variant="primary" href={topUpHref} icon="fas fa-plus">
          {t("topUp")}
        </Button>
      </p>

      <Card as="section" title={t("ledger.title")} className="mb-4">
        {screen.lines.length === 0 && !hasCursor ? (
          <EmptyState
            title={t("ledger.empty.title")}
            description={t("ledger.empty.body")}
            action={
              <Button variant="primary" href={topUpHref}>
                {t("topUp")}
              </Button>
            }
          />
        ) : (
          <DataTable
            caption={t("ledger.caption")}
            columns={ledgerColumns}
            rows={screen.lines}
            rowKey={(line) => line.entryId}
            {...(paged
              ? {
                  prevHref: hasCursor ? localePath(locale, "/wallet") : null,
                  nextHref:
                    screen.nextCursor === null
                      ? null
                      : `${localePath(locale, "/wallet")}?cursor=${screen.nextCursor}`,
                }
              : {})}
          />
        )}
      </Card>

      <Card as="section" title={t("payments.title")} className="mb-4">
        {screen.payments.length === 0 ? (
          <p className="seccolor mb-0">{t("payments.empty")}</p>
        ) : (
          <DataTable
            caption={t("payments.caption")}
            columns={paymentColumns}
            rows={screen.payments}
            rowKey={(row) => row.id}
          />
        )}
      </Card>
    </div>
  );
}
