import { Button, Card, EmptyState, formatMoney } from "@tc/ui";
import type { Numerals } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { StaticIpsScreen } from "../../../../server/account-view.ts";
import { StaticIpPanel } from "../servers/[id]/ServerManage.tsx";
import type { ManageActions } from "../servers/[id]/ServerManage.tsx";
import { ServerState, useRegionLabel } from "../servers/ServerParts.tsx";
import { ServersSubnav } from "../servers/ServersSubnav.tsx";

// The content of /static-ips (WPU-G5): the static IP of each of the customer's servers with the
// attach and detach forms of the Networking tab (same Server Actions, same panel). A static IP is
// bound to its server, so the list has one row per server. No account id, ARN or AWS name (U6).

export function StaticIpsContent({
  locale,
  numerals,
  screen,
  actions,
}: {
  locale: Locale;
  numerals: Numerals;
  screen: StaticIpsScreen;
  actions: Pick<ManageActions, "attachIp" | "detachIp">;
}) {
  const t = useTranslations("StaticIps");
  const regionLabel = useRegionLabel();

  if (screen.state === "flag_off") {
    // R12: the flag is off. 16.13: the coming soon state, with words and no action that could buy.
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }

  return (
    <>
      <h1 className="h3 mergecolor mb-3">{t("heading")}</h1>
      <ServersSubnav locale={locale} current="staticIps" />
      <p className="seccolor">{t("intro")}</p>
      {screen.items.length === 0 ? (
        <EmptyState
          title={t("empty.title")}
          description={t("empty.body")}
          action={
            <Button variant="primary" href={localePath(locale, "/servers/new")}>
              {t("empty.create")}
            </Button>
          }
        />
      ) : (
        screen.items.map((item) => (
          <Card key={item.serverId} className="mb-4">
            <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
              <h2 className="mergecolor h4 mb-0">
                <a href={localePath(locale, `/servers/${encodeURIComponent(item.serverId)}`)}>
                  {item.name === "" ? t("unnamed") : item.name}
                </a>
              </h2>
              <ServerState state={item.serverState as "active"} />
              <span className="seccolor">{regionLabel(item.region)}</span>
              <span className="seccolor">· {item.attached ? t("attached") : t("detached")}</span>
            </div>
            {item.busy ? <p className="seccolor">{t("busy")}</p> : null}
            <StaticIpPanel
              attached={item.attached}
              address={item.address}
              fee={item.fee}
              hourText={
                item.fee.hourMinor === null
                  ? null
                  : formatMoney(BigInt(item.fee.hourMinor), { locale, numerals })
              }
              actions={actions}
              ids={{ serverId: item.serverId, requestId: screen.requestId }}
              disabled={item.busy || item.serverState === "suspended"}
              idSuffix={`-${item.serverId}`}
            />
          </Card>
        ))
      )}
    </>
  );
}
