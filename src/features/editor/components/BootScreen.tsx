import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";

export function BootScreen() {
  const { t } = useTranslation();
  return (
    <div className="boot-screen">
      <img
        alt=""
        aria-hidden="true"
        className="brand-mark"
        src="/favicon.png"
      />
      <p>{t("app:starting", { name: t("app:name") })}</p>
    </div>
  );
}

export function BootErrorScreen() {
  const { t } = useTranslation();
  const bootError = useAppStore((state) => state.bootError);
  return (
    <div className="boot-screen">
      <img
        alt=""
        aria-hidden="true"
        className="brand-mark"
        src="/favicon.png"
      />
      <h1>{t("app:bootFailed", { name: t("app:name") })}</h1>
      <p role="alert">{bootError ?? t("app:unknownError")}</p>
      <button onClick={() => void useAppStore.getState().boot()} type="button">
        {t("common:retry")}
      </button>
    </div>
  );
}
