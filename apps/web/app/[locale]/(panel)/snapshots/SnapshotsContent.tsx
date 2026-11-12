import { Button, Card, DataTable, DateText, EmptyState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { SnapshotsScreen } from "../../../../server/account-view.ts";
import { MAX_MANUAL_BACKUPS } from "../../../../server/extras-actions.ts";
import type { BackupItem } from "../../../../server/extras-view.ts";
import { DestroyButton, RestoreForm } from "../servers/[id]/ExtrasForms.tsx";
import type { ExtrasAction } from "../servers/[id]/ExtrasForms.tsx";
import { ServerState, useRegionLabel } from "../servers/ServerParts.tsx";
import { ServersSubnav } from "../servers/ServersSubnav.tsx";
import { CreateSnapshotForm } from "./SnapshotForms.tsx";

// The content of /snapshots (WPU-G5): every snapshot of the customer's servers, grouped by server,
// with delete (typed name, fresh sign-in, R13 in the action), restore to a new server (the order
// flow, where the price is shown before any money is taken) and a form to take a new one. The Server
// Actions are those of the server page. Nothing here shows an account id, an ARN or an AWS name (U6).

type Numerals = "beng" | "latn";

export interface SnapshotActions {
  createBackup: ExtrasAction;
  deleteBackup: ExtrasAction;
  restoreToNewServer: ExtrasAction;
}

export function SnapshotsContent({
  locale,
  numerals,
  screen,
  actions,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: SnapshotsScreen;
  actions: SnapshotActions;
}) {
  const t = useTranslations("Snapshots");
  const te = useTranslations("Extras");
  const tb = useTranslations("Extras.backups");
  const regionLabel = useRegionLabel();

  if (screen.state === "flag_off") {
    // R12: the flag is off. 16.13: the coming soon state, with words and no action that could buy.
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }

  const head = (
    <>
      <h1 className="h3 mergecolor mb-3">{t("heading")}</h1>
      <ServersSubnav locale={locale} current="snapshots" />
      <p className="seccolor">{t("intro")}</p>
    </>
  );

  if (screen.servers.length === 0 && screen.groups.length === 0) {
    return (
      <>
        {head}
        <EmptyState
          title={t("empty.title")}
          description={t("empty.noServer")}
          action={
            <Button variant="primary" href={localePath(locale, "/servers/new")}>
              {t("empty.create")}
            </Button>
          }
        />
      </>
    );
  }

  const columns = (requestId: string) => [
    {
      key: "name",
      header: tb("name"),
      cell: (row: BackupItem) =>
        row.final ? tb("final") : row.name === "" ? te("none") : row.name,
    },
    {
      key: "kind",
      header: tb("kind"),
      cell: (row: BackupItem) => (row.final ? tb("final") : tb("manual")),
    },
    {
      key: "size",
      header: tb("size"),
      cell: (row: BackupItem) =>
        row.sizeGb === null ? te("none") : tb("gb", { size: row.sizeGb }),
    },
    {
      key: "date",
      header: tb("date"),
      cell: (row: BackupItem) => <DateText value={row.createdAt} numerals={numerals} />,
    },
    {
      key: "state",
      header: tb("state"),
      cell: (row: BackupItem) =>
        te.has(`state.${row.state}`) ? te(`state.${row.state}`) : row.state,
    },
    {
      key: "actions",
      header: "",
      cell: (row: BackupItem) =>
        row.final || row.state !== "active" || row.name === "" ? null : (
          <DestroyButton
            action={actions.deleteBackup}
            fields={{ backupId: row.id, requestId }}
            resourceName={row.name}
            label={tb("delete")}
            title={tb("deleteTitle")}
            description={tb("deleteDescription")}
            size="sm"
          />
        ),
    },
  ];

  return (
    <>
      {head}
      {screen.groups.length === 0 ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : (
        screen.groups.map((group) => (
          <Card key={group.server.id} className="mb-4">
            <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
              <h2 className="mergecolor h4 mb-0">
                {group.server.name === "" ? t("group.unnamed") : group.server.name}
              </h2>
              <ServerState state={group.server.state as "active"} />
              <span className="seccolor">{regionLabel(group.server.region)}</span>
              {group.server.live ? (
                <Button
                  size="sm"
                  variant="default"
                  href={localePath(locale, `/servers/${encodeURIComponent(group.server.id)}`)}
                >
                  {t("group.open")}
                </Button>
              ) : null}
            </div>
            <p className="seccolor">
              {group.server.live
                ? t("group.count", { count: group.manual, max: MAX_MANUAL_BACKUPS })
                : t("group.gone")}
            </p>
            <DataTable
              caption={tb("caption")}
              rows={group.items}
              rowKey={(row) => row.id}
              columns={columns(screen.requestId)}
            />
            <div className="mt-4">
              <RestoreForm
                action={actions.restoreToNewServer}
                region={group.server.region ?? ""}
                backups={group.items
                  .filter((b) => b.state === "active")
                  .map((b) => ({ id: b.id, name: b.name !== "" ? b.name : tb("final") }))}
                plans={group.plans}
                disabled={group.server.region === null}
                idPrefix={`restore-${group.server.id}`}
              />
            </div>
          </Card>
        ))
      )}
      {screen.servers.length > 0 ? (
        <Card className="mb-4">
          <CreateSnapshotForm
            action={actions.createBackup}
            servers={screen.servers}
            requestId={screen.requestId}
          />
        </Card>
      ) : null}
    </>
  );
}
