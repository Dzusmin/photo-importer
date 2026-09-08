import { describe, expect, it } from "vitest";
import {
  normalizeSettingsError,
  renderFileNamePreview,
  renderFolderPreview,
  validateSettings,
  type AppSettings,
} from "./settings";

function settings(): AppSettings {
  return {
    schemaVersion: 4,
    portable: {
      import: {
        defaultOperation: "copy",
        defaultSourceBehavior: "ask",
        eventGapMinutes: 120,
      },
      naming: {
        folderTemplate: "{year}/{date}-{event_name}",
        fileNameTemplate: "{original_name}",
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
      uiLanguage: "en",
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

  it("validates and previews file name templates", () => {
    const value = settings();
    value.portable.naming.fileNameTemplate =
      "{date}_{counter:04}_{original_name}";
    expect(validateSettings(value)).toEqual([]);
    expect(renderFileNamePreview(value.portable.naming.fileNameTemplate)).toBe(
      "2026-08-31_0001_DSCF0123.RAF",
    );

    value.portable.naming.fileNameTemplate = "../{counter}";
    expect(validateSettings(value)).toEqual([
      "File name template: cannot contain directory separators.",
    ]);
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
      message: "The settings file is corrupted.",
      technicalDetails: "Uszkodzony plik",
      backupAvailable: true,
    });
  });
});
