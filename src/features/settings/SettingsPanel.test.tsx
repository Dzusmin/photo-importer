import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { settingsResponseFixture } from "../../test/fixtures";
import type { AppSettings } from "../../shared/settings";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { SettingsPanel } from "./SettingsPanel";

function renderSettingsPanel() {
  return render(
    <ThemeProvider>
      <SettingsPanel />
    </ThemeProvider>,
  );
}

describe("SettingsPanel", () => {
  it("loads, validates, saves and can discard local edits", async () => {
    const saved = vi.fn();
    mockIPC((command, args) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "save_settings") {
        const value = (args as Record<string, unknown>).settings as AppSettings;
        saved(value);
        return { ...settingsResponseFixture(), settings: value };
      }
    });
    const user = userEvent.setup();
    renderSettingsPanel();
    await screen.findByText("Start a new event after");
    const gap = screen.getAllByRole("spinbutton")[0];

    await user.clear(gap);
    await user.type(gap, "0");
    expect(screen.getByRole("alert")).toHaveTextContent("The event gap");
    expect(
      screen.getByRole("button", { name: "Save settings" }),
    ).toBeDisabled();

    await user.clear(gap);
    await user.type(gap, "90");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved.mock.calls[0][0].portable.import.eventGapMinutes).toBe(90);

    await user.click(screen.getByLabelText("Start at login"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Start at login")).not.toBeChecked(),
    );
  });

  it("adds profiles, validates their names and removes their bindings", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
    });
    const user = userEvent.setup();
    renderSettingsPanel();
    await screen.findByText(
      "No profiles. You can add the first camera manually.",
    );

    await user.click(
      screen.getByRole("button", { name: /Add camera profile/ }),
    );
    const name = screen.getByLabelText("Profile name");
    expect(name).toHaveValue("Camera 1");
    await user.clear(name);
    expect(screen.getByRole("alert")).toHaveTextContent("must have a name");
    await user.click(screen.getByRole("button", { name: "Remove profile" }));
    expect(screen.getByText(/No profiles/)).toBeInTheDocument();
  });

  it("configures background planning, restart behavior and concurrency", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
    });
    const user = userEvent.setup();
    renderSettingsPanel();

    await user.click(
      await screen.findByLabelText(
        "Show the window when an import plan is ready",
      ),
    );
    await user.click(screen.getByLabelText("System notifications"));
    await user.selectOptions(
      screen.getByDisplayValue("Ask before resuming"),
      "automatic",
    );
    const concurrency = screen.getAllByRole("spinbutton")[1];
    await user.clear(concurrency);
    await user.type(concurrency, "3");

    expect(
      screen.getByLabelText("Show the window when an import plan is ready"),
    ).toBeChecked();
    expect(screen.getByLabelText("System notifications")).not.toBeChecked();
    expect(concurrency).toHaveValue(3);
  });

  it("changes the UI language immediately and persists it with settings", async () => {
    const saved = vi.fn();
    mockIPC((command, args) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "save_settings") {
        const value = (args as Record<string, unknown>).settings as AppSettings;
        saved(value);
        return { ...settingsResponseFixture(), settings: value };
      }
    });
    const user = userEvent.setup();
    renderSettingsPanel();

    const language = await screen.findByLabelText("Language");
    await user.selectOptions(language, "pl");

    expect(screen.getByLabelText("Język")).toHaveValue("pl");
    await user.click(screen.getByRole("button", { name: "Zapisz ustawienia" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved.mock.calls[0][0].local.uiLanguage).toBe("pl");
  });

  it("offers backup recovery after a corrupted primary file", async () => {
    mockIPC((command) => {
      if (command === "load_settings") {
        throw {
          code: "corruptedPrimary",
          message: "Plik ustawień jest uszkodzony.",
          backupAvailable: true,
        };
      }
      if (command === "restore_settings_backup")
        return settingsResponseFixture();
    });
    const user = userEvent.setup();
    renderSettingsPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Corrupted settings",
    );
    await user.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(
      await screen.findByText("The previous settings version was restored."),
    ).toBeInTheDocument();
  });

  it("clears the thumbnail cache through IPC", async () => {
    const clear = vi.fn();
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "clear_thumbnail_cache") clear();
    });
    const user = userEvent.setup();
    renderSettingsPanel();

    await user.click(
      await screen.findByRole("button", { name: "Clear thumbnail cache" }),
    );

    expect(clear).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(/thumbnail cache was cleared/),
    ).toBeInTheDocument();
  });

  it("offers every application theme", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
    });
    renderSettingsPanel();

    const theme = await screen.findByLabelText("Theme");
    expect(theme).toHaveDisplayValue("System setting");
    expect(
      [...theme.querySelectorAll("option")].map((option) => option.value),
    ).toEqual(["system", "dark", "light", "high-contrast"]);
  });
});
