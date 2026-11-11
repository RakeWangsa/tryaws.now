import { verifyDraft } from "@tc/core";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { getOrdersRuntime } from "../../../../../server/orders-runtime.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { reviewFromToken } from "../../../../../server/review-view.ts";
import type { ReviewScreen } from "../../../../../server/review-view.ts";
import { PanelFrame } from "../../PanelFrame.tsx";
import { placeOrderAction } from "./actions.ts";
import { ReviewContent } from "./ReviewContent.tsx";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return {
    title: t("Orders.review.meta.title"),
    // The token is in the URL: no referrer and no index (16.11 step 3).
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/** /orders/review?d=<token> (16.11 steps 3 to 5). */
export default async function ReviewPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  const query = await searchParams;
  const token = query["d"];
  const panel = await startPanelPage("/orders/review");

  const runtime = await getOrdersRuntime();
  const review: ReviewScreen =
    runtime === null
      ? { state: "unavailable" }
      : reviewFromToken(
          (text) => verifyDraft(runtime.secrets, text, runtime.now()),
          typeof token === "string" ? token : undefined,
          panel.session.customerId,
          panel.balanceMinor,
        );

  return (
    <PanelFrame locale={locale} path="/orders/review" currentId="cloudServers" panel={panel}>
      <h1 className="h3 mergecolor mb-4">{t("Orders.review.heading")}</h1>
      <ReviewContent
        locale={locale}
        review={review}
        // One key for each view of the page (R7): two clicks of one view buy once.
        idempotencyKey={crypto.randomUUID()}
        action={placeOrderAction}
      />
    </PanelFrame>
  );
}
