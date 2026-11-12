import { DEFAULT_BLUEPRINT_ID, keyFileName, loginUserOf, sshCommandOf } from "@tc/core";
import { Button, Card, CopyField, EmptyState, StatTile, Tabs, formatDate } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { ServerManage as ManageData } from "../../../../../server/server-manage-view.ts";
import type { ServerDetail } from "../../../../../server/servers-view.ts";
import { ServerState, useRegionLabel, useSpecLine } from "../ServerParts.tsx";
import { useExtraTabs } from "./ExtrasTabs.tsx";
import type { ExtrasBundle } from "./ExtrasTabs.tsx";
import {
  FirewallEditor,
  PowerBar,
  RenameForm,
  StaticIpPanel,
  type ManageActions,
} from "./ServerManage.tsx";
import { WindowsAccess, type RevealResult } from "./WindowsAccess.tsx";

// The content of /servers/[id] (16.10): a header and the tabs Overview, Access and Networking
// (WP4). The other tabs belong to WP5. A server of another customer and a missing one give the same
// answer (R8). Nothing here shows an account id, an ARN or a generated AWS name (U6, R11).

type Numerals = "beng" | "latn";

/** What the header buttons and the Networking tab need (WPU-G2); null while the data is not loaded. */
export interface ManageBundle {
  data: ManageData;
  actions: ManageActions;
}

// Used when no Server Action is passed (the static mockup states): the reveal refuses (R16).
const refuseReveal = async (): Promise<RevealResult> => ({ ok: false, error: "unavailable" });

export function ServerDetailContent({
  locale,
  numerals,
  server,
  extras = null,
  manage = null,
  defaultTab,
  windowsAction = refuseReveal,
}: {
  locale: Locale;
  numerals: Numerals;
  server: ServerDetail | null;
  /** The tabs of WP5-T6; null while the flag is off or the data is not loaded. */
  extras?: ExtrasBundle | null;
  manage?: ManageBundle | null;
  defaultTab?: string;
  /** The Server Action of the Windows password; the page passes `revealWindowsPasswordAction`. */
  windowsAction?: (form: FormData) => Promise<RevealResult>;
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

  const ids = manage === null ? null : { serverId: server.id, requestId: manage.data.requestId };
  // The user of the image every Linux server is launched with; the loaded data may say it is unknown.
  const loginUser =
    manage !== null
      ? manage.data.loginUser
      : server.family === "linux_instance"
        ? loginUserOf(DEFAULT_BLUEPRINT_ID)
        : null;
  const sshCommand =
    server.publicIp === null
      ? null
      : sshCommandOf({ user: loginUser, host: server.publicIp, keyName: server.keyName });
  const controlsOn = manage !== null && manage.data.flagOn;
  const locked = manage === null || manage.data.busy;

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
      {controlsOn && manage !== null && ids !== null ? (
        <div className="col-12">
          <RenameForm
            action={manage.actions.rename}
            ids={ids}
            current={server.name}
            disabled={["creating", "failed", "destroyed"].includes(server.state)}
          />
        </div>
      ) : null}
    </div>
  );

  const access =
    server.family === "windows_instance" ? (
      <>
        {server.publicIp === null ? (
          <p className="seccolor">{t("detail.access.pendingIp")}</p>
        ) : (
          <CopyField
            label={t("detail.access.rdp")}
            value={server.publicIp}
            hint={t("detail.access.rdpHint")}
          />
        )}
        <div className="mt-3">
          <WindowsAccess
            resourceId={server.id}
            running={server.state === "active"}
            action={windowsAction}
          />
        </div>
      </>
    ) : (
      <>
        {server.publicIp === null ? (
          <p className="seccolor">{t("detail.access.pendingIp")}</p>
        ) : sshCommand === null ? (
          <>
            <CopyField label={t("detail.overview.publicIp")} value={server.publicIp} />
            <p className="seccolor mt-3 mb-1">{t("detail.access.userUnknown")}</p>
          </>
        ) : (
          <>
            <CopyField
              label={t("detail.access.ssh")}
              value={sshCommand}
              hint={t("detail.access.sshHint")}
            />
            <p className="seccolor mt-3 mb-1">
              <b>{t("detail.access.user")}</b>
              {": "}
              <code>{loginUser}</code>
            </p>
          </>
        )}
        <p className="seccolor mb-1">
          <b>{t("detail.access.keyName")}</b>
          {": "}
          {server.keyName ?? t("detail.access.noKey")}
        </p>
        {server.keyName === null ? null : (
          <p className="seccolor small">
            <b>{t("detail.access.keyFile")}</b>
            {": "}
            {t("detail.access.keyFileHint", { file: keyFileName(server.keyName) })}
          </p>
        )}
      </>
    );

  const networking = (
    <>
      <div className="alert alert-info text-start" role="note">
        <i className="fas fa-info-circle me-2" aria-hidden="true" />
        {t("detail.networking.note")}
      </div>
      {controlsOn && manage !== null && ids !== null ? (
        <>
          {manage.data.busy ? (
            <div className="alert alert-info text-start" role="status">
              <i className="fas fa-spinner me-2" aria-hidden="true" />
              {t("detail.manage.busy")}
            </div>
          ) : null}
          <h3 className="mergecolor h4 mt-4">{t("detail.manage.staticIp.title")}</h3>
          <StaticIpPanel
            attached={manage.data.staticIpAttached}
            address={server.publicIp}
            actions={manage.actions}
            ids={ids}
            disabled={locked || !["active", "stopped"].includes(server.state)}
          />
          <h3 className="mergecolor h4 mt-4">{t("detail.networking.rulesTitle")}</h3>
          <p className="seccolor">{t("detail.networking.rulesIntro")}</p>
          <FirewallEditor
            rules={manage.data.rules}
            sshOpenToWorld={manage.data.sshOpenToWorld}
            actions={manage.actions}
            ids={ids}
            windows={server.family === "windows_instance"}
            disabled={locked || !["active", "stopped"].includes(server.state)}
          />
        </>
      ) : (
        <>
          {server.publicIp === null ? null : (
            <CopyField
              label={t("detail.networking.staticIp")}
              value={server.publicIp}
              hint={t("detail.networking.staticIpHint")}
            />
          )}
          <h3 className="mergecolor h4 mt-4">{t("detail.networking.rulesTitle")}</h3>
          <p className="seccolor">{t("detail.manage.flagOff")}</p>
        </>
      )}
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
        {controlsOn && manage !== null && ids !== null ? (
          <PowerBar actions={manage.actions} ids={ids} state={server.state} busy={locked} />
        ) : null}
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
          {...(defaultTab !== undefined &&
          (defaultTab === "networking" ||
            (["backups", "storage", "metrics", "billing", "destroy"].includes(defaultTab) &&
              extraTabs.length > 0))
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}
