import { Button, Card, CopyField, EmptyState, StatTile, Tabs, formatDate } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { ServerDetail } from "../../../../../server/servers-view.ts";
import { ServerState, useRegionLabel, useSpecLine } from "../ServerParts.tsx";
import { useExtraTabs } from "./ExtrasTabs.tsx";
import type { ExtrasBundle } from "./ExtrasTabs.tsx";

// The content of /servers/[id] (16.10): a header and the tabs Overview, Access and Networking
// (WP4). The other tabs belong to WP5. A server of another customer and a missing one give the same
// answer (R8). Nothing here shows an account id, an ARN or a generated AWS name (U6, R11).

type Numerals = "beng" | "latn";

export function ServerDetailContent({
  locale,
  numerals,
  server,
  extras = null,
  defaultTab,
}: {
  locale: Locale;
  numerals: Numerals;
  server: ServerDetail | null;
  /** The tabs of WP5-T6; null while the flag is off or the data is not loaded. */
  extras?: ExtrasBundle | null;
  defaultTab?: string;
}) {
  const t = useTranslations("Servers");
  const specLine = useSpecLine();
  const regionLabel = useRegionLabel();
  const listHref = localePath(locale, "/servers");
  const extraTabs = useExtraTabs(extras, locale, numerals);

  if (server === null) {
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

  const sshCommand = server.publicIp === null ? null : `ssh <user>@${server.publicIp}`;

  const overview = (
    <div className="row g-3">
      <div className="col-12 col-md-6">
        <StatTile
          value={specLine(server.specs) || t("list.none")}
          description={t("detail.overview.specs")}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile value={regionLabel(server.region)} description={t("detail.overview.location")} />
      </div>
      <div className="col-12 col-md-6">
        {server.publicIp === null ? (
          <StatTile value={t("list.none")} description={t("detail.overview.pendingIp")} />
        ) : (
          <CopyField label={t("detail.overview.publicIp")} value={server.publicIp} />
        )}
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={formatDate(server.createdAt, { locale, numerals })}
          description={t("detail.overview.created")}
        />
      </div>
    </div>
  );

  const access = (
    <>
      {sshCommand === null ? (
        <p className="seccolor">{t("detail.access.pendingIp")}</p>
      ) : (
        <CopyField
          label={t("detail.access.ssh")}
          value={sshCommand}
          hint={t("detail.access.sshHint")}
        />
      )}
      <p className="seccolor mt-3">
        <b>{t("detail.access.keyName")}</b>
        {": "}
        {server.keyName ?? t("detail.access.noKey")}
      </p>
    </>
  );

  const networking = (
    <>
      <div className="alert alert-info text-start" role="note">
        <i className="fas fa-info-circle me-2" aria-hidden="true" />
        {t("detail.networking.note")}
      </div>
      {server.publicIp === null ? null : (
        <CopyField
          label={t("detail.networking.staticIp")}
          value={server.publicIp}
          hint={t("detail.networking.staticIpHint")}
        />
      )}
      <h3 className="mergecolor h4 mt-4">{t("detail.networking.rulesTitle")}</h3>
      <p className="seccolor">{t("detail.networking.rulesSoon")}</p>
    </>
  );

  return (
    <>
      <p className="mb-3">
        <a href={listHref}>
          <i className="fas fa-arrow-left me-1" aria-hidden="true" />
          {t("detail.back")}
        </a>
      </p>
      <Card className="mb-4">
        <h1 className="mergecolor h3 mb-2">{server.name === "" ? t("list.none") : server.name}</h1>
        <div className="d-flex flex-wrap align-items-center gap-3">
          <ServerState state={server.state} />
          <span className="seccolor">{t("detail.header.aws")}</span>
          <span className="seccolor">{regionLabel(server.region)}</span>
        </div>
      </Card>
      <Card>
        <Tabs
          label={t("detail.tabsLabel")}
          tabs={[
            { id: "overview", title: t("detail.tab.overview"), content: overview },
            { id: "access", title: t("detail.tab.access"), content: access },
            { id: "networking", title: t("detail.tab.networking"), content: networking },
            ...extraTabs,
          ]}
          {...(defaultTab !== undefined && ["backups", "storage", "metrics", "billing", "destroy"].includes(defaultTab) && extraTabs.length > 0
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}
