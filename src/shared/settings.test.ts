import { describe, expect, it } from "vitest";
import {
  importPlanSettingsRevision,
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
  it("fingerprints every setting that can affect an import plan", () => {
    const base = settings();
    base.local.libraryPath = "C:\\Library";
    base.portable.cameraProfiles = [
      {
        id: "camera-1",
        name: "Main camera",
        exifMatchers: [{ make: "Fuji", model: "X-T5", serialNumber: null }],
        defaultTimeOffsetSeconds: 0,
      },
    ];
    base.local.sourceBindings = [
      {
        id: "binding-1",
        sourceIdentity: {
          markerUuid: null,
          platformVolumeId: "volume-1",
          fallbackFingerprint: "fingerprint-1",
        },
        displayName: "Travel card",
        behavior: "ask",
        cameraProfileIds: ["camera-1"],
        lastSeenAtUnixMs: 1,
      },
    ];
    const revision = importPlanSettingsRevision(base);
    const changedRevisions = [
      { ...base, local: { ...base.local, libraryPath: "D:\\Photos" } },
      {
        ...base,
        portable: {
          ...base.portable,
          import: {
            ...base.portable.import,
            defaultOperation: "moveAfterVerification" as const,
          },
        },
      },
      {
        ...base,
        portable: {
          ...base.portable,
          import: { ...base.portable.import, eventGapMinutes: 30 },
        },
      },
      {
        ...base,
        portable: {
          ...base.portable,
          cameraProfiles: [
            { ...base.portable.cameraProfiles[0], name: "Renamed camera" },
          ],
        },
      },
      {
        ...base,
        local: {
          ...base.local,
          sourceBindings: [
            { ...base.local.sourceBindings[0], displayName: "Renamed card" },
          ],
        },
      },
    ].map(importPlanSettingsRevision);

    expect(new Set(changedRevisions)).not.toContain(revision);

    const uiOnlyChange = {
      ...base,
      local: {
        ...base.local,
        uiLanguage: "pl" as const,
        sourceBindings: [
          { ...base.local.sourceBindings[0], lastSeenAtUnixMs: 2 },
        ],
      },
    };
    expect(importPlanSettingsRevision(uiOnlyChange)).toBe(revision);
  });

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
