import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { settingsResponseFixture } from "../test/fixtures";
import type { AppSettings } from "./settings";
import { SettingsProvider, useSettingsStore } from "./SettingsStore";

describe("SettingsStore", () => {
  it("serializes changes and applies every updater to the latest settings", async () => {
    const saved = vi.fn();
    mockIPC((command, args) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "save_settings") {
        const settings = (args as { settings: AppSettings }).settings;
        saved(settings);
        return { ...settingsResponseFixture(), settings };
      }
    });
    const user = userEvent.setup();
    render(
      <SettingsProvider>
        <SettingsStoreHarness />
      </SettingsProvider>,
    );

    await screen.findByText("120 / 0");
    await user.click(screen.getByRole("button", { name: "Change gap" }));
    await user.click(screen.getByRole("button", { name: "Add profile" }));

    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
    expect(saved.mock.calls[1][0].portable.import.eventGapMinutes).toBe(90);
    expect(saved.mock.calls[1][0].portable.cameraProfiles).toHaveLength(1);
    expect(await screen.findByText("90 / 1")).toBeInTheDocument();
  });
});

function SettingsStoreHarness() {
  const store = useSettingsStore();
  if (!store?.settings) return <span>Loading</span>;
  return (
    <>
      <span>
        {store.settings.portable.import.eventGapMinutes} /{" "}
        {store.settings.portable.cameraProfiles.length}
      </span>
      <button
        type="button"
        onClick={() =>
          void store.updateSettings((current) => ({
            ...current,
            portable: {
              ...current.portable,
              import: {
                ...current.portable.import,
                eventGapMinutes: 90,
              },
            },
          }))
        }
      >
        Change gap
      </button>
      <button
        type="button"
        onClick={() =>
          void store.updateSettings((current) => ({
            ...current,
            portable: {
              ...current.portable,
              cameraProfiles: [
                ...current.portable.cameraProfiles,
                {
                  id: "camera-1",
                  name: "Camera",
                  exifMatchers: [],
                  defaultTimeOffsetSeconds: 0,
                },
              ],
            },
          }))
        }
      >
        Add profile
      </button>
    </>
  );
}
