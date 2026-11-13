import { Button, DataTable, EmptyState } from "@tc/ui";
import type { ReactNode } from "react";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { DiskListItem, DiskListScreen } from "../../../../../server/disk-list-view.ts";
import { AutoRenewSwitch, type AutoRenewAction } from "../../_family/AutoRenewSwitch.tsx";
import { useRegionLabel } from "../ServerParts.tsx";
import { ServersSubnav } from "../ServersSubnav.tsx";
import { DestroyButton, PostButton, type ExtrasAction } from "../[id]/ExtrasForms.tsx";

// The content of /servers/disks (WPU-Y4): every disk of the customer, so a disk that no server holds is never out of
// reach. Synchronous, so it renders in a test without a request. The states: flag off (R12), empty and ready; loading
// and error are the loading.tsx and error.tsx of the route (U11). The actions are the existing disk actions of the
// Storage tab (detach, destroy, the auto-renew switch); attaching is done on the server's own Storage tab. Nothing
// here shows an account id, an ARN, a generated AWS name or an AWS error text (U6, R11).

export interface DiskListActions {
  detachDisk: ExtrasAction;
  destroyDisk: ExtrasAction;
  setDiskAutoRenew: AutoRenewAction;
}

export function DiskListContent({
  locale,
  screen,
  actions,
}: {
  locale: Locale;
  screen: DiskListScreen;
  actions: DiskListActions;
}) {
  const t = useTranslations("DiskList");
  const te = useTranslations("Extras");
  const regionLabel = useRegionLabel();
  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  const subnav = <ServersSubnav locale={locale} current="disks" />;
  if (screen.disks.length === 0) {
    return (
      <>
        {subnav}
        <p className="seccolor mb-4">{t("intro")}</p>
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      </>
    );
  }
  const serverHref = (id: string) =>
    `${localePath(locale, `/servers/${encodeURIComponent(id)}`)}?tab=storage`;
  const serverName = (name: string) => (name === "" ? t("unnamedServer") : name);

  const attachedCell = (row: DiskListItem): ReactNode =>
    row.attachedTo === null ? (
      <span className="seccolor">{t("notAttached")}</span>
    ) : (
      <a href={serverHref(row.attachedTo.id)}>{serverName(row.attachedTo.name)}</a>
    );

  const actionsCell = (row: DiskListItem): ReactNode => {
    const parts: ReactNode[] = [];
    if (row.canDetach) {
      parts.push(
        <PostButton
          key="detach"
          action={actions.detachDisk}
          fields={{ diskId: row.id, requestId: screen.requestId }}
          label={t("detach")}
          icon="fas fa-unlink"
        />,
      );
    } else if (row.attachedTo !== null && row.state === "active") {
      parts.push(
        <p key="stop" className="seccolor small mb-1">
          {t("stopFirst")}
        </p>,
      );
    }
    if (row.canDestroy) {
      parts.push(
        <DestroyButton
          key="destroy"
          action={actions.destroyDisk}
          fields={{ diskId: row.id, requestId: screen.requestId }}
          resourceName={row.name}
          label={t("destroy")}
          title={t("destroyTitle")}
          description={t("destroyDescription")}
          size="sm"
        />,
      );
    }
    if (row.attachedTo === null && row.canDestroy) {
      if (row.attachTargets.length === 0) {
        parts.push(
          <p key="none" className="seccolor small mb-1">
            {t("noTarget")}
          </p>,
        );
      }
      for (const server of row.attachTargets) {
        parts.push(
          <Button key={`attach-${server.id}`} size="sm" href={serverHref(server.id)}>
            {t("attachOn", { server: serverName(server.name) })}
          </Button>,
        );
      }
    }
    return parts.length === 0 ? null : <div className="d-flex flex-wrap gap-2">{parts}</div>;
  };

  return (
    <>
      {subnav}
      <p className="seccolor mb-4">{t("intro")}</p>
      <DataTable
        caption={t("caption")}
        rows={screen.disks}
        rowKey={(row) => row.id}
        columns={[
          { key: "name", header: t("name"), cell: (row) => row.name || te("none") },
          {
            key: "size",
            header: t("size"),
            cell: (row) => (row.sizeGb === null ? te("none") : `${row.sizeGb} GB`),
          },
          { key: "location", header: t("location"), cell: (row) => regionLabel(row.region) },
          {
            key: "state",
            header: t("state"),
            cell: (row) => (te.has(`state.${row.state}`) ? te(`state.${row.state}`) : row.state),
          },
          { key: "attachedTo", header: t("attachedTo"), cell: attachedCell },
          {
            key: "renewal",
            header: t("renewal"),
            cell: (row) =>
              row.subscriptionStatus === null
                ? te("none")
                : t(`renewalValue.${row.subscriptionStatus}`),
          },
          {
            key: "autoRenew",
            header: "",
            cell: (row) =>
              row.autoRenew === null ? null : (
                <AutoRenewSwitch action={actions.setDiskAutoRenew} view={row.autoRenew} compact />
              ),
          },
          { key: "actions", header: "", cell: actionsCell },
        ]}
      />
    </>
  );
}
