import { EmptyState } from "@tc/ui";
import { useTranslations } from "next-intl";
import type { DiskRestoreScreen } from "../../../../../server/disk-restore-view.ts";
import { DiskRestoreForm } from "./DiskRestoreForm.tsx";
import type { DiskRestoreAction } from "./DiskRestoreForm.tsx";

// The content of /servers/disk-restore. Synchronous, so it renders in a test without a request. The
// states: flag off (R12), empty (no snapshot to restore from) and ready. Loading and error are the
// loading.tsx and error.tsx of the route (U11).

export function DiskRestoreContent({
  screen,
  action,
}: {
  screen: DiskRestoreScreen;
  action: DiskRestoreAction;
}) {
  const t = useTranslations("DiskRestore");
  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }
  if (screen.options.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  return (
    <>
      <p className="seccolor mb-4">{t("intro")}</p>
      <DiskRestoreForm options={screen.options} action={action} />
    </>
  );
}
