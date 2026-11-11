import { Button, Card, DateText, EmptyState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { KycScreen } from "../../../../server/kyc-view.ts";
import { KycForm } from "./KycForm.tsx";
import type { KycLimits } from "./KycForm.tsx";
import type { StartKycResult, SubmitKycResult } from "../../../../server/kyc-actions.ts";

// The content of /kyc (16.9): the form, or the status view for pending, verified and rejected, or
// the "not open" state. Synchronous, so it renders in a test without a request. The reviewer's note
// is plain text (React escapes it); nothing of the document is shown.

type Numerals = "beng" | "latn";

export function KycContent({
  numerals,
  screen,
  limits,
  startAction,
  submitAction,
  serversHref,
}: {
  numerals: Numerals;
  screen: KycScreen;
  limits: KycLimits;
  startAction: (input: unknown) => Promise<StartKycResult>;
  submitAction: (input: unknown) => Promise<SubmitKycResult>;
  serversHref: string;
}) {
  const t = useTranslations("Kyc");

  if (screen.state === "unavailable") {
    return (
      <EmptyState
        title={t("status.unavailable.title")}
        description={t("status.unavailable.body")}
      />
    );
  }

  if (screen.state === "verified") {
    return (
      <Card>
        <div className="alert alert-info text-start" role="status">
          <i className="fas fa-check-circle me-2" aria-hidden="true" />
          <strong>{t("status.verified.title")}</strong>
          <p className="mb-0">{t("status.verified.body")}</p>
        </div>
        <Button variant="primary" href={serversHref}>
          {t("status.verified.action")}
        </Button>
      </Card>
    );
  }

  if (screen.state === "pending") {
    return (
      <Card>
        <div className="alert alert-info text-start" role="status">
          <i className="fas fa-clock me-2" aria-hidden="true" />
          <strong>{t("status.pending.title")}</strong>
          <p className="mb-1">{t("status.pending.body")}</p>
          <p className="mb-0 seccolor">
            {t("status.pending.submittedOn")}:{" "}
            <DateText value={screen.submission.createdAt} numerals={numerals} />
          </p>
        </div>
      </Card>
    );
  }

  return (
    <>
      <p className="seccolor mb-4">{t("intro")}</p>
      {screen.state === "rejected" ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          <strong>{t("status.rejected.title")}</strong>
          <p className="mb-1">{t("status.rejected.body")}</p>
          {screen.submission.note !== null ? (
            <p className="mb-0">
              {t("status.rejected.note")}: {screen.submission.note}
            </p>
          ) : null}
        </div>
      ) : null}
      {screen.state === "form" || screen.canResubmit ? (
        <Card title={screen.state === "rejected" ? t("status.rejected.again") : undefined}>
          <KycForm
            limits={limits}
            defaultType={screen.customerType}
            startAction={startAction}
            submitAction={submitAction}
          />
        </Card>
      ) : null}
    </>
  );
}
