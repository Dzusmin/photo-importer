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

/** Translate small, component-local UI copy that is not part of a reusable catalog. */
export function localize(english: string, polish: string): string {
  return i18n.resolvedLanguage === "pl" ? polish : english;
}

export function activeIntlLocale(): "en-US" | "pl-PL" {
  return i18n.resolvedLanguage === "pl" ? "pl-PL" : "en-US";
}

export { i18n };
export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from "./locale";
export type { SupportedLocale } from "./locale";
