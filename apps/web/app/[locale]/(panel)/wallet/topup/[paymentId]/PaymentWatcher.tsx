"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { recheckPaymentAction } from "./actions.ts";
import { startWatcher } from "./watcher-core.ts";
import type { WatcherPhase } from "./watcher-core.ts";

/**
 * Only for a pending payment. Asks the server every 8 s (at most 15 times, only while the tab is
 * visible) and refreshes the route when the state changed. The words are in a polite live region.
 * The timing rules are in watcher-core.ts.
 */
export function PaymentWatcher({ paymentId }: { paymentId: string }) {
  const t = useTranslations("Wallet.status");
  const router = useRouter();
  const [phase, setPhase] = useState<WatcherPhase>({ kind: "checking" });

  useEffect(
    () =>
      startWatcher({
        recheck: () => recheckPaymentAction(paymentId),
        refresh: () => router.refresh(),
        visible: () => document.visibilityState === "visible",
        onPhase: setPhase,
      }),
    [paymentId, router],
  );

  const text =
    phase.kind === "stopped"
      ? t("pending.stopped")
      : phase.kind === "waiting"
        ? t("retryWait", { seconds: phase.seconds })
        : t("pending.checking");

  return (
    <p className="seccolor" role="status" aria-live="polite">
      {phase.kind === "checking" ? (
        <i className="fas fa-spinner fa-spin me-2" aria-hidden="true" />
      ) : null}
      {text}
    </p>
  );
}
