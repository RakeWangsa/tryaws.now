import { Button, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import { configurePathOf } from "../../../../../server/family-routes.ts";
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
  // The form the draft came from: a CDN, database or load balancer draft goes back to its own form
  // (WP7-T2, WP6-T2, WP6-T3), the rest to /servers/new.
  const configureHref = localePath(
    locale,
    configurePathOf(review.state === "ready" ? review.family : undefined),
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
      idempotencyKey={idempotencyKey}
      configureHref={configureHref}
      action={action}
    />
  );
}
