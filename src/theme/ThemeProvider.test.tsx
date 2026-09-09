import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  ThemeProvider,
  initializeTheme,
  useTheme,
} from "./ThemeProvider";

function mockSystemTheme(light: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: light,
    media: "(prefers-color-scheme: light)",
    onchange: null,
    addEventListener: vi.fn(
      (_name: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
    ),
    removeEventListener: vi.fn(
      (_name: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    ),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
  return {
    switchToLight() {
      listeners.forEach((listener) =>
        listener({ matches: true } as MediaQueryListEvent),
      );
    },
  };
}

function ThemeProbe() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  return (
    <div>
      <span>{`${preference}:${resolvedTheme}`}</span>
      <button type="button" onClick={() => setPreference("high-contrast")}>
        Use high contrast
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.themePreference;
  });

  it("resolves the system preference and follows system changes", async () => {
    const systemTheme = mockSystemTheme(false);
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByText("system:dark")).toBeInTheDocument();
    systemTheme.switchToLight();
    expect(await screen.findByText("system:light")).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("persists an explicit accessible theme", async () => {
    mockSystemTheme(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Use high contrast" }));

    expect(document.documentElement.dataset.theme).toBe("high-contrast");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(
      "high-contrast",
    );
  });

  it("applies a stored theme before React renders", () => {
    mockSystemTheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    initializeTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
