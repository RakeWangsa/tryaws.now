import type { PaymentRow } from "@tc/db";
import { Button, Card, DataTable, DateText, EmptyState, HelpStrip, MoneyText } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { TopUpScreen } from "../../../../../server/topup-view.ts";
import { EpsBadge } from "../../../_components/EpsBadge.tsx";
import { TopUpForm } from "./TopUpForm.tsx";

// The content of /wallet/topup. Synchronous, so it renders in a test without a request. Its markup
// follows checkout.html (Payment Details), configurator.html (option groups) and payments.html
// (the "how you pay" card); see mockup-anchors.ts.

type Numerals = "beng" | "latn";

export function TopUpContent({
  locale,
  numerals,
  screen,
  eps,
  initialKey,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: TopUpScreen;
  /** false = the gateway is not configured (R16): the page says "not open yet". */
  eps: boolean;
  initialKey: string;
}) {
  const t = useTranslations("Wallet.topup");
  const status = useTranslations("Wallet.status");
  const publicT = useTranslations("Public");
  const walletHref = localePath(locale, "/wallet");
  const open = eps && screen.market !== null;

  if (!open) {
    return (
      <div>
        <h1 className="h3 mergecolor mb-4">{t("heading")}</h1>
        <Card>
          <EmptyState
            title={t("closed.title")}
            description={t("closed.body")}
            action={
              <Button variant="primary" href={walletHref}>
                {status("backToWallet")}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const waitingColumns = [
    {
      key: "date",
      header: status("date"),
      cell: (row: PaymentRow) => <DateText value={row.createdAt} numerals={numerals} />,
    },
    {
      key: "amount",
      header: status("amount"),
      cell: (row: PaymentRow) => (
        <MoneyText minor={row.amountMinor} mode="exact" numerals={numerals} />
      ),
    },
    {
      key: "view",
      header: t("open.view"),
      cell: (row: PaymentRow) => (
        <Button
          variant="default"
          size="sm"
          href={localePath(locale, `/wallet/topup/${encodeURIComponent(row.id)}`)}
        >
          {t("open.view")}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <h1 className="h3 mergecolor mb-4">{t("heading")}</h1>

      <div className="mb-4">
        <EpsBadge alt={publicT("epsBadge.alt")} />
        <p className="small seccolor mt-2 mb-0">{t("badgeCaption")}</p>
      </div>

      <Card as="section" className="mb-4">
        <TopUpForm
          locale={locale}
          numerals={numerals}
          range={screen.range}
          quick={screen.quick}
          initialKey={initialKey}
        />
      </Card>

      <div className="sec-main sec-bg1 pay bg-seccolorstyle noshadow mb-4">
        <div className="plans badge feat bg-purple">{t("how.badge")}</div>
        <h2 className="section-heading mt-3 mergecolor">{t("how.title")}</h2>
        {(["p1", "p2", "p3"] as const).map((key) => (
          <p key={key} className="seccolor">
            <span className="c-pink" aria-hidden="true">
              ●
            </span>{" "}
            {t(`how.${key}`)}
          </p>
        ))}
      </div>

      {screen.open.length > 0 ? (
        <Card as="section" title={t("open.title")} className="mb-4">
          <DataTable
            caption={t("open.title")}
            columns={waitingColumns}
            rows={screen.open}
            rowKey={(row) => row.id}
          />
        </Card>
      ) : null}

      <HelpStrip
        items={[
          {
            href: localePath(locale, "/support"),
            title: t("help.support"),
            description: t("help.supportBody"),
            icon: "fas fa-headset",
          },
          {
            href: localePath(locale, "/help"),
            title: t("help.faq"),
            description: t("help.faqBody"),
            icon: "fas fa-question-circle",
          },
        ]}
      />
    </div>
  );
}
