import { Button, Card, EmptyState, StatTile, formatDate } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { DomainDetailView } from "../../../../../server/domain-view.ts";
import { DomainState } from "../DomainsContent.tsx";
import { RenewalForm } from "./RenewalForm.tsx";

// The content of /domains/[name] (16.10): state, expiry, the verification state of the owner's e-mail,
// the name servers and the renewal switch. A domain of another customer and a missing one give the same
// answer (R8). There is no delete: a domain expires (R13). Nothing here shows an account id, an ARN, the
// Route 53 operation id, the hosted zone id or the registrant contact (R11, R14).

type Action = (previous: FormState, form: FormData) => Promise<FormState>;
const refuse: Action = async () => ({ error: "unavailable" });

export function DomainDetailContent({
  locale,
  numerals,
  domain,
  requestId,
  renewAction = refuse,
}: {
  locale: Locale;
  numerals: "beng" | "latn";
  domain: DomainDetailView | null;
  requestId: string;
  renewAction?: Action;
}) {
  const t = useTranslations("Domains");
  const listHref = localePath(locale, "/domains");

  if (domain === null) {
    return (
      <EmptyState
        title={t("detail.notFound.title")}
        description={t("detail.notFound.body")}
        action={
          <Button variant="primary" href={listHref}>
            {t("detail.back")}
          </Button>
        }
      />
    );
  }
  const date = (value: Date): string => formatDate(value, { locale, numerals });

  return (
    <>
      <div className="row g-3 mb-4">
        <div className="col-12 col-md-4">
          <StatTile value={t(`state.${domain.state}` as never)} description={t("detail.state")} />
        </div>
        <div className="col-12 col-md-4">
          <StatTile
            value={domain.expiresAt === null ? t("list.none") : date(domain.expiresAt)}
            description={t("detail.expires")}
          />
        </div>
        <div className="col-12 col-md-4">
          <StatTile
            value={domain.periodEnd === null ? t("list.none") : date(domain.periodEnd)}
            description={t("detail.period")}
          />
        </div>
      </div>
      <Card className="mb-4">
        <h2 className="h5 mergecolor">{t("detail.verification.title")}</h2>
        <p className="mb-2">
          <DomainState state={domain.state} />
        </p>
        <p className="mb-0">{t(`detail.verification.${domain.reachability}`)}</p>
      </Card>
      <Card className="mb-4">
        <h2 className="h5 mergecolor">{t("detail.nameServers")}</h2>
        {domain.nameServers.length === 0 ? (
          <p className="seccolor mb-0">{t("detail.noNameServers")}</p>
        ) : (
          <ul className="mb-0">
            {domain.nameServers.map((server) => (
              <li key={server}>{server}</li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="mb-4">
        <h2 className="h5 mergecolor">{t("detail.renewal.title")}</h2>
        <RenewalForm
          name={domain.name}
          autoRenew={domain.autoRenew}
          requestId={requestId}
          action={renewAction}
        />
      </Card>
      <p className="seccolor mb-3">{t("detail.noDelete")}</p>
      <Button variant="tertiary" href={listHref}>
        {t("detail.back")}
      </Button>
    </>
  );
}
