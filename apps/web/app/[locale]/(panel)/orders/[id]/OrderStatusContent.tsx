import { Button, Card, EmptyState, MoneyText, StatusTimeline } from "@tc/ui";
import type { TimelineStep } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { familyScreen } from "../../../../../server/family-screens.ts";
import type { OrderProgress, OrderScreen } from "../../../../../server/servers-view.ts";
import { AutoRefresh } from "./AutoRefresh.tsx";

// The content of /orders/[id] (16.10, 16.11 step 6): the steps paid, creating, ready, or the failure
// with the automatic refund. While the operation is needs_attention the page says the order is
// delayed and that support is on it. It never shows an operation id, an AWS state or an error text.

const STEPS: Record<OrderProgress, readonly TimelineStep["state"][]> = {
  paid: ["done", "pending", "pending"],
  creating: ["done", "current", "pending"],
  delayed: ["done", "current", "pending"],
  ready: ["done", "done", "done"],
  failed: ["done", "failed", "pending"],
};

export function OrderStatusContent({
  locale,
  order,
}: {
  locale: Locale;
  order: OrderScreen | null;
}) {
  const t = useTranslations("Orders.status");
  const root = useTranslations();
  const own = familyScreen(order?.family);

  if (order === null) {
    return (
      <EmptyState
        title={t("notFound.title")}
        description={t("notFound.body")}
        action={
          <Button variant="primary" href={localePath(locale, "/servers")}>
            {t("notFound.action")}
          </Button>
        }
      />
    );
  }

  const states = STEPS[order.progress];
  const steps: TimelineStep[] = (["paid", "creating", "ready"] as const).map((id, index) => ({
    id,
    label: t(`step.${id}`),
    state: states[index] ?? "pending",
  }));
  const refreshing = order.progress === "paid" || order.progress === "creating";

  return (
    <>
      <AutoRefresh active={refreshing} />
      <Card className="mb-4">
        <StatusTimeline label={t("label")} steps={steps} />
      </Card>

      {order.progress === "ready" ? (
        <div className="alert alert-info text-start" role="status">
          <i className="fas fa-check-circle me-2" aria-hidden="true" />
          {t("ready")}
          {order.resourceId !== null ? (
            <div className="mt-3">
              {own !== undefined ? (
                <Button
                  variant="primary"
                  href={localePath(locale, `${own.base}/${order.resourceId}`)}
                >
                  {root(`${own.ns}.order.open`)}
                </Button>
              ) : (
                <Button variant="primary" href={localePath(locale, `/servers/${order.resourceId}`)}>
                  {t("openServer")}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {order.progress === "creating" || order.progress === "paid" ? (
        <div className="alert alert-info text-start" role="status">
          <i className="fas fa-hourglass-half me-2" aria-hidden="true" />
          {t("creating")}
        </div>
      ) : null}
      {order.progress === "delayed" ? (
        <div className="alert alert-warning text-start" role="status">
          <i className="fas fa-clock me-2" aria-hidden="true" />
          {t("delayed")}
        </div>
      ) : null}
      {order.progress === "failed" ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t("failed")}
          <div className="mt-3">
            <Button variant="primary" href={localePath(locale, "/wallet")}>
              {t("wallet")}
            </Button>
          </div>
        </div>
      ) : null}

      <p className="seccolor">
        {t("total")}: <MoneyText minor={order.totalMinor} />
      </p>
    </>
  );
}
