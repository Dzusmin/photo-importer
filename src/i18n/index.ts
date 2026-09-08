import { loadSettings } from "../shared/settings";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  type SupportedLocale,
} from "./locale";
import { i18n } from "./instance";

export async function setAppLanguage(locale: SupportedLocale): Promise<void> {
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}

export async function loadStoredLanguage(): Promise<void> {
  try {
    const response = await loadSettings();
    await setAppLanguage(normalizeLocale(response.settings.local.uiLanguage));
  } catch {
    await setAppLanguage(DEFAULT_LOCALE);
  }
}

export { i18n };
export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from "./locale";
export type { SupportedLocale } from "./locale";
