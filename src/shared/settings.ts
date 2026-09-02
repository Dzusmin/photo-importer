import { invoke } from "@tauri-apps/api/core";

export type ImportOperation = "copy" | "moveAfterVerification";
export type SourceBehavior = "ask" | "autoPreparePlan" | "ignore";
export type ResumeAfterRestart = "ask" | "automatic";
export type CollisionPolicy = "ask" | "appendSequence";

export interface AppSettings {
  schemaVersion: number;
  portable: {
    import: {
      defaultOperation: ImportOperation;
      defaultSourceBehavior: SourceBehavior;
      eventGapMinutes: number;
    };
    naming: {
      folderTemplate: string;
      collisionPolicy: CollisionPolicy;
    };
    cameraProfiles: CameraProfile[];
  };
  local: {
    libraryPath: string | null;
    startAtLogin: boolean;
    minimizeToTray: boolean;
    sourceBindings: SourceBinding[];
    maxConcurrentImports: number;
    resumeAfterRestart: ResumeAfterRestart;
    showWindowWhenPlanReady: boolean;
    notificationsEnabled: boolean;
  };
}

export interface CameraProfile {
  id: string;
  name: string;
  exifMatchers: ExifCameraMatcher[];
  defaultTimeOffsetSeconds: number;
}

export interface ExifCameraMatcher {
  make: string | null;
  model: string | null;
  serialNumber: string | null;
}

export interface SourceBinding {
  id: string;
  sourceIdentity: {
    markerUuid: string | null;
    platformVolumeId: string | null;
    fallbackFingerprint: string;
  };
  displayName: string;
  behavior: SourceBehavior;
  cameraProfileIds: string[];
  markerState?: "unknown" | "written" | "readOnly" | "writeFailed";
  lastSeenAtUnixMs: number | null;
}

export interface SettingsResponse {
  settings: AppSettings;
  source: "defaults" | "primaryFile";
  backupAvailable: boolean;
}

export interface SettingsCommandError {
  code: string;
  message: string;
  backupAvailable?: boolean | null;
}

export function loadSettings(): Promise<SettingsResponse> {
  return invoke<SettingsResponse>("load_settings");
}

export function saveSettings(settings: AppSettings): Promise<SettingsResponse> {
  return invoke<SettingsResponse>("save_settings", { settings });
}

export function restoreSettingsBackup(): Promise<SettingsResponse> {
  return invoke<SettingsResponse>("restore_settings_backup");
}

export function exportPortableSettings(path: string): Promise<void> {
  return invoke<void>("export_portable_settings", { path });
}

export function importPortableSettings(
  path: string,
): Promise<SettingsResponse> {
  return invoke<SettingsResponse>("import_portable_settings", { path });
}

export function normalizeSettingsError(error: unknown): SettingsCommandError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<SettingsCommandError>;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return {
        code: candidate.code,
        message: candidate.message,
        backupAvailable: candidate.backupAvailable,
      };
    }
  }

  return {
    code: "unknown",
    message:
      typeof error === "string" ? error : "Wystąpił nieznany błąd ustawień.",
  };
}

export function validateSettings(settings: AppSettings): string[] {
  const errors: string[] = [];
  const gap = settings.portable.import.eventGapMinutes;
  if (!Number.isInteger(gap) || gap < 1 || gap > 10_080) {
    errors.push(
      "Przerwa między wydarzeniami musi wynosić od 1 do 10080 minut.",
    );
  }
  if (!settings.portable.naming.folderTemplate.trim()) {
    errors.push("Szablon folderu nie może być pusty.");
  }
  if (
    !Number.isInteger(settings.local.maxConcurrentImports) ||
    settings.local.maxConcurrentImports < 1 ||
    settings.local.maxConcurrentImports > 8
  ) {
    errors.push("Liczba równoległych importów musi wynosić od 1 do 8.");
  }
  for (const profile of settings.portable.cameraProfiles) {
    if (!profile.name.trim()) {
      errors.push("Każdy profil aparatu musi mieć nazwę.");
    }
  }
  return errors;
}

export function renderFolderPreview(template: string): string {
  const values: Record<string, string> = {
    year: "2026",
    month: "08",
    day: "31",
    date: "2026-08-31",
    event_name: "urodziny-ani",
    camera_make: "Fujifilm",
    camera_model: "X-T5",
    camera_alias: "aparat-glowny",
    source_alias: "karta-a",
  };
  return template.replace(
    /\{([^{}]+)\}/g,
    (match, key: string) => values[key] ?? match,
  );
}
