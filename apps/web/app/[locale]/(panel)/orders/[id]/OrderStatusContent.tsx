import { Button, Card, EmptyState, MoneyText, StatusTimeline } from "@tc/ui";
import type { TimelineStep } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { familyScreen, orderNoun } from "../../../../../server/family-screens.ts";
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
  const kind = orderNoun(order?.family);
  const words = { noun: t(`noun.${kind}`), title: t(`title.${kind}`) };

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
    label: t(`step.${id}`, words),
    state: states[index] ?? "pending",
  }));
  // WPU-X23: a delayed order is refreshed too (slowly), so it moves to ready or to failed with its refund by itself.
  const refreshing =
    order.progress === "paid" || order.progress === "creating" || order.progress === "delayed";
  const refreshMs = order.progress === "delayed" ? 20_000 : 5000;

  return (
    <>
      <AutoRefresh active={refreshing} everyMs={refreshMs} />
      <Card className="mb-4">
        <StatusTimeline label={t("label")} steps={steps} />
      </Card>

      {order.progress === "ready" ? (
        <div className="alert alert-info text-start" role="status">
          <i className="fas fa-check-circle me-2" aria-hidden="true" />
          {order.family === "disk" ? t("readyDisk") : t("ready", words)}
          {order.resourceId !== null ? (
            <div className="mt-3">
              {order.family === "disk" ? (
                // A disk has no page of its own: it is attached from the Storage tab of a server.
                <Button variant="primary" href={localePath(locale, "/servers")}>
                  {t("openDisk")}
                </Button>
              ) : own !== undefined ? (
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
          {t("creating", words)}
          {order.slow === true ? <p className="mt-2 mb-0">{t("slow", words)}</p> : null}
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
          {order.refunded === true ? t("failedRefunded", words) : t("failed", words)}
          {order.refunded === true ? (
            // WPU-B3: the reversal is posted: say so with the amount, not only that it will come.
            <p className="mt-2 mb-0">
              {t("refunded")} <MoneyText minor={order.totalMinor} />
            </p>
          ) : null}
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
