import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isSupportedLocale, normalizeLocale } from "./locale";

describe("locale", () => {
  it("accepts the initially supported languages", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("pl")).toBe(true);
  });

  it("falls back to English for an unsupported locale", () => {
    expect(normalizeLocale("de")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(null)).toBe("en");
  });
});
