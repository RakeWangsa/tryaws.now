import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { Button } from "../../components/Button.tsx";
import { EmptyState } from "../../components/EmptyState.tsx";
import { ErrorPage } from "../../components/ErrorPage.tsx";
import { HelpStrip } from "../../components/HelpStrip.tsx";
import { Skeleton } from "../../components/Skeleton.tsx";
import { StatusTimeline } from "../../components/StatusTimeline.tsx";
import { DEMO_REFERENCE_ID, DEMO_TIMELINE_AT } from "../data.ts";
import { Sample } from "../Sample.tsx";

export function States(): ReactElement {
  const t = useTranslations("Gallery.demo");
  return (
    <>
      <Sample name="EmptyState" titleKey="Gallery.samples.emptyState">
        <EmptyState
          title={t("empty.title")}
          description={t("empty.description")}
          action={<Button variant="primary">{t("empty.action")}</Button>}
        />
      </Sample>
      <Sample name="ErrorPage" titleKey="Gallery.samples.errorPage">
        <ErrorPage
          title={t("error.title")}
          message={t("error.message")}
          referenceId={DEMO_REFERENCE_ID}
          retry={<Button variant="primary">{t("error.retry")}</Button>}
          home={
            <Button variant="default" href="/">
              {t("error.home")}
            </Button>
          }
        />
      </Sample>
      <Sample name="HelpStrip" titleKey="Gallery.samples.helpStrip">
        <HelpStrip
          items={[
            {
              href: "#chat",
              title: t("help.chatTitle"),
              description: t("help.chatBody"),
              icon: "fas fa-headset",
            },
            {
              href: "#ticket",
              title: t("help.ticketTitle"),
              description: t("help.ticketBody"),
              icon: "fas fa-ticket",
            },
            {
              href: "#guide",
              title: t("help.guideTitle"),
              description: t("help.guideBody"),
              icon: "fas fa-book",
            },
          ]}
        />
      </Sample>
      <Sample name="StatusTimeline" titleKey="Gallery.samples.statusTimeline">
        <StatusTimeline
          label={t("timeline.label")}
          steps={[
            { id: "placed", label: t("timeline.placed"), state: "done", at: DEMO_TIMELINE_AT },
            { id: "paid", label: t("timeline.paid"), state: "done", at: DEMO_TIMELINE_AT },
            { id: "creating", label: t("timeline.creating"), state: "current" },
            { id: "ready", label: t("timeline.ready"), state: "pending" },
          ]}
        />
      </Sample>
      <Sample name="Skeleton" titleKey="Gallery.samples.skeleton">
        <Skeleton lines={3} />
      </Sample>
    </>
  );
}
