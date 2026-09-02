import type { AppSettings, SettingsResponse } from "../shared/settings";
import type {
  ImportSession,
  MediaScanJob,
  SourceScanResponse,
  SourceVolume,
} from "../shared/sources";
import type { BackgroundStatus } from "../shared/background";

export function settingsFixture(): AppSettings {
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

export function settingsResponseFixture(): SettingsResponse {
  return {
    settings: settingsFixture(),
    source: "primaryFile",
    backupAvailable: false,
  };
}

export function sourceFixture(): SourceVolume {
  return {
    fingerprint: "sha256:card",
    markerUuid: null,
    platformVolumeId: null,
    name: "CAMERA",
    mountPath: "E:\\",
    fileSystem: "exFAT",
    totalBytes: 64_000,
    availableBytes: 32_000,
    removable: true,
    readOnly: false,
    containsDcim: true,
    likelyCameraSource: true,
  };
}

export function scanResultFixture(): SourceScanResponse {
  return {
    scan: {
      root: "E:\\",
      items: [],
      supportedFileCount: 0,
      skippedFileCount: 0,
      totalSizeBytes: 0,
      warnings: [],
      timings: { discoveryMs: 0, metadataMs: 0 },
    },
    events: [],
    timestampBasis: "embeddedWithFileFallback",
    eventGapMinutes: 120,
    importMatches: [],
  };
}

export function scanJobFixture(
  patch: Partial<MediaScanJob> = {},
): MediaScanJob {
  return {
    id: "scan-1",
    path: "E:\\",
    status: "running",
    phase: "discovering",
    discoveredFileCount: 0,
    processedFileCount: 0,
    totalSupportedFileCount: null,
    currentPath: null,
    historyBytesRead: 0,
    historyCacheHitCount: 0,
    fullyHashedFileCount: 0,
    timings: {
      discoveryMs: 0,
      metadataMs: 0,
      comparingHistoryMs: 0,
      groupingEventsMs: 0,
    },
    startedAtUnixMs: 1,
    updatedAtUnixMs: 1,
    error: null,
    result: null,
    ...patch,
  };
}

export function backgroundStatusFixture(
  patch: Partial<BackgroundStatus> = {},
): BackgroundStatus {
  return {
    running: true,
    lastCheckedAtUnixMs: 1_725_062_400_000,
    connectedKnownSourceCount: 0,
    activeAutoScanCount: 0,
    startAtLoginEnabled: false,
    lastError: null,
    events: [],
    pendingSources: [],
    ...patch,
  };
}

export function importSessionFixture(
  patch: Partial<ImportSession> = {},
): ImportSession {
  return {
    id: "session-1",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    completedAtUnixMs: null,
    operation: "copy",
    status: "planned",
    libraryRoot: "C:\\Library",
    sourceFingerprint: "sha256:card",
    sourceIdentity: null,
    fileCount: 1,
    completedFileCount: 0,
    itemCount: 1,
    completedItemCount: 0,
    totalSizeBytes: 10,
    completedSizeBytes: 0,
    pauseRequested: false,
    cancelRequested: false,
    moveConfirmed: false,
    lastError: null,
    operations: [],
    ...patch,
  };
}
