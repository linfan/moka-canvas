import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { create } from "zustand";
import enApp from "./locales/en/app.json";
import enCommon from "./locales/en/common.json";
import enSettings from "./locales/en/settings.json";
import zhApp from "./locales/zh/app.json";
import zhCommon from "./locales/zh/common.json";
import zhSettings from "./locales/zh/settings.json";

/**
 * Which language the interface is drawn in. "system" follows the machine's
 * own language and is the default; a language picked outright outranks it.
 */
export const LOCALE_MODES = ["system", "en", "zh"] as const;
export type LocaleMode = (typeof LOCALE_MODES)[number];
export type Locale = "en" | "zh";

/** The languages the interface carries words for. */
export const LOCALES: Locale[] = ["en", "zh"];

/** Kept on this machine, beside the other choices that are about the reader. */
const STORED_UNDER = "moka-canvas:locale";

function readMode(): LocaleMode {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return "system";
  try {
    const kept = localStorage.getItem(STORED_UNDER);
    return LOCALE_MODES.find((mode) => mode === kept) ?? "system";
  } catch {
    // A store this cannot read is one that has nothing in it.
    return "system";
  }
}

function keepMode(mode: LocaleMode) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORED_UNDER, mode);
  } catch {
    // A store that will not take it costs the remembering, not the choice.
  }
}

/** Every Chinese dialect reads the same Chinese interface; others read English. */
export function systemLocale(language?: string): Locale {
  const tag =
    language ??
    (typeof navigator === "undefined" ? "" : (navigator.language ?? ""));
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLocale(mode: LocaleMode): Locale {
  return mode === "system" ? systemLocale() : mode;
}

const resources = {
  en: { app: enApp, common: enCommon, settings: enSettings },
  zh: { app: zhApp, common: zhCommon, settings: zhSettings },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLocale(readMode()),
  fallbackLng: "en",
  supportedLngs: LOCALES,
  defaultNS: "common",
  // React escapes the text it renders; the catalogues hold it as written.
  interpolation: { escapeValue: false },
  // The catalogues are bundled, so the first render already has its words.
  initAsync: false,
});

/**
 * The name on the window and the browser tab: the product's name in the
 * current language. The desktop shell's title is kept beside the page's so
 * the taskbar reads the same as the window.
 */
function syncNativeChrome() {
  if (typeof document === "undefined") return;
  const name = i18n.t("app:name");
  document.title = name;
  document.documentElement.lang = i18n.resolvedLanguage ?? "en";
  void setDesktopTitle(name);
}

async function setDesktopTitle(title: string) {
  const inShell =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!inShell) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    // A window that refuses the title still has the page's own.
  }
}

i18n.on("languageChanged", syncNativeChrome);
syncNativeChrome();

export interface LocaleState {
  mode: LocaleMode;
  setMode: (mode: LocaleMode) => void;
}

/** The language choice in the shape the settings screen edits it. */
export const useLocale = create<LocaleState>()((set) => ({
  mode: readMode(),
  setMode: (mode) => {
    keepMode(mode);
    set({ mode });
    void i18n.changeLanguage(resolveLocale(mode));
  },
}));

export { i18n };
