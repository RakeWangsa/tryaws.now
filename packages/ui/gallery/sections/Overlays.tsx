import { useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { Button } from "../../components/Button.tsx";
import { Modal } from "../../components/Modal.tsx";
import { ConfirmDestroyDemo, ToastDemo } from "../Demos.tsx";
import { DEMO_RESOURCE_NAME } from "../data.ts";
import { Sample } from "../Sample.tsx";

export function Overlays(): ReactElement {
  const t = useTranslations("Gallery.demo");
  return (
    <>
      <Sample name="Modal" titleKey="Gallery.samples.modal">
        <Modal
          trigger={<Button variant="secondary">{t("modal.trigger")}</Button>}
          title={t("modal.title")}
          description={t("modal.description")}
        />
      </Sample>
      <Sample name="ConfirmDestroy" titleKey="Gallery.samples.confirmDestroy">
        <ConfirmDestroyDemo
          trigger={t("confirm.trigger")}
          resourceName={DEMO_RESOURCE_NAME}
          title={t("confirm.title")}
          description={t("confirm.description")}
        />
      </Sample>
      <Sample name="ToastProvider" titleKey="Gallery.samples.toastProvider">
        <ToastDemo
          title={t("toast.title")}
          description={t("toast.description")}
          items={[
            { tone: "success", label: t("toast.success") },
            { tone: "info", label: t("toast.info") },
            { tone: "warning", label: t("toast.warning") },
            { tone: "danger", label: t("toast.danger") },
          ]}
        />
      </Sample>
    </>
  );
}
