import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE } from "./locale";
import en from "./resources/en.json";
import pl from "./resources/pl.json";

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    pl: { translation: pl },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: ["en", "pl"],
  interpolation: { escapeValue: false },
  initAsync: false,
});

export { i18n };
