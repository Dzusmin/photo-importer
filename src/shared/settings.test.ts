import { describe, expect, it } from "vitest";
import {
  normalizeSettingsError,
  renderFolderPreview,
  validateSettings,
  type AppSettings,
} from "./settings";

function settings(): AppSettings {
  return {
    schemaVersion: 2,
    portable: {
      import: {
        defaultOperation: "copy",
        defaultSourceBehavior: "ask",
        eventGapMinutes: 120,
      },
      naming: {
        folderTemplate: "{year}/{date}-{event_name}",
        collisionPolicy: "ask",
      },
      cameraProfiles: [],
    },
    local: {
      libraryPath: null,
      startAtLogin: false,
      minimizeToTray: true,
      sourceBindings: [],
      maxConcurrentImports: 2,
      resumeAfterRestart: "ask",
      showWindowWhenPlanReady: false,
      notificationsEnabled: true,
    },
  };
}

describe("settings helpers", () => {
  it("validates event gap and folder template", () => {
    const value = settings();
    value.portable.import.eventGapMinutes = 0;
    value.portable.naming.folderTemplate = "  ";

    expect(validateSettings(value)).toHaveLength(2);
  });

  it("renders a deterministic folder preview", () => {
    expect(renderFolderPreview("{year}/{date}-{event_name}")).toBe(
      "2026/2026-08-31-urodziny-ani",
    );
  });

  it("keeps structured backend errors", () => {
    expect(
      normalizeSettingsError({
        code: "corruptedPrimary",
        message: "Uszkodzony plik",
        backupAvailable: true,
      }),
    ).toEqual({
      code: "corruptedPrimary",
      message: "Uszkodzony plik",
      backupAvailable: true,
    });
  });
});
