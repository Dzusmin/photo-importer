import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, vi } from "vitest";
import { setAppLanguage } from "../i18n";

Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: vi.fn(() => "blob:test-thumbnail"),
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: vi.fn(),
});

afterEach(async () => {
  cleanup();
  clearMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  await setAppLanguage("en");
});
