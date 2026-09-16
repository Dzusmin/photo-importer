import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsResponseFixture } from "../../test/fixtures";
import type { AppSettings } from "../../shared/settings";
import { ThemeProvider } from "../../theme/ThemeProvider";
import { enablesNewAutoImportScope, SettingsPanel } from "./SettingsPanel";

const { openDialog } = vi.hoisted(() => ({
  openDialog: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialog,
  save: vi.fn(),
}));

function renderSettingsPanel(
  onDirtyChange?: (dirty: boolean) => void,
  focusSection?: "library" | null,
) {
  return render(
    <ThemeProvider>
      <SettingsPanel
        onDirtyChange={onDirtyChange}
        focusSection={focusSection}
      />
    </ThemeProvider>,
  );
}

describe("SettingsPanel", () => {
  beforeEach(() => openDialog.mockReset());

  it("focuses the library chooser when opened from onboarding", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
    });

    renderSettingsPanel(undefined, "library");

    expect(await screen.findByRole("button", { name: "Choose" })).toHaveFocus();
  });

  it("reports when the local settings draft becomes dirty and clean again", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
    });
    const onDirtyChange = vi.fn();
    const user = userEvent.setup();
    renderSettingsPanel(onDirtyChange);

    await user.click(await screen.findByLabelText("Start at login"));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("detects newly enabled auto-import independently in every scope", () => {
    const previous = settingsResponseFixture().settings;
    previous.portable.import.defaultSourceBehavior = "autoImport";
    previous.portable.cameraProfiles = [
      {
        id: "camera-1",
        name: "Camera 1",
        exifMatchers: [],
        defaultTimeOffsetSeconds: 0,
        sourceBehavior: "ask",
      },
    ];
    previous.local.sourceBindings = [
      {
        id: "card-1",
        sourceIdentity: {
          markerUuid: null,
          platformVolumeId: null,
          fallbackFingerprint: "card-1",
        },
        displayName: "Card 1",
        behavior: "ask",
        cameraProfileIds: [],
        lastSeenAtUnixMs: null,
      },
    ];

    const cameraEnabled = structuredClone(previous);
    cameraEnabled.portable.cameraProfiles[0].sourceBehavior = "autoImport";
    expect(enablesNewAutoImportScope(previous, cameraEnabled)).toBe(true);

    const cardEnabled = structuredClone(previous);
    cardEnabled.local.sourceBindings[0].behavior = "autoImport";
    expect(enablesNewAutoImportScope(previous, cardEnabled)).toBe(true);

    const globalPreviouslyDisabled = structuredClone(previous);
    globalPreviouslyDisabled.portable.import.defaultSourceBehavior = "ask";
    expect(enablesNewAutoImportScope(globalPreviouslyDisabled, previous)).toBe(
      true,
    );

    expect(enablesNewAutoImportScope(previous, structuredClone(previous))).toBe(
      false,
    );
  });

  it("asks for confirmation when auto-import is extended to another card", async () => {
    const loaded = settingsResponseFixture();
    loaded.settings.portable.import.defaultSourceBehavior = "autoImport";
    loaded.settings.local.sourceBindings = [
      {
        id: "card-1",
        sourceIdentity: {
          markerUuid: null,
          platformVolumeId: null,
          fallbackFingerprint: "card-1",
        },
        displayName: "Card 1",
        behavior: "ask",
        cameraProfileIds: [],
        lastSeenAtUnixMs: null,
      },
    ];
    const saved = vi.fn();
    mockIPC((command) => {
      if (command === "load_settings") return loaded;
      if (command === "save_settings") saved();
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderSettingsPanel();

    await user.selectOptions(
      await screen.findByDisplayValue("Show a notification and ask"),
      "autoImport",
    );
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(saved).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

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

  it("explains a library change and requires choosing new or moved semantics", async () => {
    const loaded = settingsResponseFixture();
    loaded.settings.local.libraryPath = "C:\\Old library";
    openDialog.mockResolvedValue("D:\\Selected library");
    mockIPC((command) => {
      if (command === "load_settings") return loaded;
    });
    const user = userEvent.setup();
    renderSettingsPanel();

    await user.click(await screen.findByRole("button", { name: "Choose" }));

    const dialog = screen.getByRole("dialog", {
      name: "What does this change mean?",
    });
    expect(dialog).toHaveTextContent("history and backups");
    expect(dialog).toHaveTextContent("marked for recalculation");
    expect(dialog).toHaveTextContent("C:\\Old library");
    expect(dialog).toHaveTextContent("D:\\Selected library");
    expect(screen.getByDisplayValue("C:\\Old library")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Use a moved library/ }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByDisplayValue("D:\\Selected library"),
    ).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
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

  it("applies the UI language only after saving and can discard it", async () => {
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

    expect(screen.getByLabelText("Language")).toHaveValue("pl");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Language")).toHaveValue("en"),
    );
    expect(saved).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText("Language"), "pl");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved.mock.calls[0][0].local.uiLanguage).toBe("pl");
    expect(await screen.findByLabelText("Język")).toHaveValue("pl");
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
    vi.spyOn(window, "confirm").mockReturnValue(true);
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

  it("resolves an unsaved draft before opening an import file", async () => {
    const imported = vi.fn();
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "import_portable_settings") imported();
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderSettingsPanel();

    await user.click(await screen.findByLabelText("Start at login"));
    await user.click(screen.getByRole("button", { name: "Import JSON" }));

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("unsaved settings draft"),
    );
    expect(openDialog).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Start at login")).toBeChecked();
  });

  it("shows the replacement scope and requires final import confirmation", async () => {
    const imported = vi.fn();
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "import_portable_settings") {
        imported();
        return settingsResponseFixture();
      }
    });
    openDialog.mockResolvedValue("C:\\settings.json");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderSettingsPanel();

    await user.click(
      await screen.findByRole("button", { name: "Import JSON" }),
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/import defaults.*naming rules.*camera profiles/i),
    );
    expect(imported).not.toHaveBeenCalled();
  });

  it("resolves a draft and shows the full backup replacement scope", async () => {
    const restored = vi.fn();
    const loaded = settingsResponseFixture();
    loaded.backupAvailable = true;
    mockIPC((command) => {
      if (command === "load_settings") return loaded;
      if (command === "restore_settings_backup") restored();
    });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const user = userEvent.setup();
    renderSettingsPanel();

    await user.click(await screen.findByLabelText("Start at login"));
    await user.click(
      screen.getByRole("button", { name: "Restore previous version" }),
    );

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0][0]).toContain("unsaved settings draft");
    expect(confirm.mock.calls[1][0]).toMatch(
      /replace all current settings.*library path.*media associations/i,
    );
    expect(restored).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Start at login")).toBeChecked();
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
