import { autoRenewAtPurchase } from "@tc/core";
import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import { familyScreen } from "../../../../../server/family-screens.ts";
import type { ReviewScreen } from "../../../../../server/review-view.ts";
import { PlaceForm } from "./PlaceForm.tsx";

// The content of /orders/review. Synchronous, so it renders in a test without a request. The states
// are invalid, expired, unavailable (no draft secret: nothing can be ordered, R16) and ready.

export function ReviewContent({
  locale,
  review,
  idempotencyKey,
  action,
}: {
  locale: Locale;
  review: ReviewScreen;
  idempotencyKey: string;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Orders.review");
  // The form the draft came from: a family with its own screens (server/family-screens.ts) goes back to
  // its /new, the rest to /servers/new.
  const own = review.state === "ready" ? familyScreen(review.family) : undefined;
  // A disk is added from the Storage tab of a server, so its way back is the list of servers.
  const diskOrder = review.state === "ready" && review.family === "disk";
  const configureHref = localePath(
    locale,
    diskOrder ? "/servers" : own === undefined ? "/servers/new" : `${own.base}/new`,
  );

  if (review.state !== "ready") {
    return (
      <EmptyState
        title={t(`${review.state}.title`)}
        description={t(`${review.state}.body`)}
        action={
          review.state === "unavailable" ? undefined : (
            <Button variant="primary" href={configureHref}>
              {t("back")}
            </Button>
          )
        }
      />
    );
  }
  return (
    <PlaceForm
      locale={locale}
      review={review}
      // WPU-Z2: the line "Auto-renew is on" by the rule the purchase stores; a draft without a family says
      // nothing (R16).
      autoRenew={review.family !== undefined && autoRenewAtPurchase(review.family)}
      idempotencyKey={idempotencyKey}
      configureHref={configureHref}
      action={action}
    />
  );
}
