import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n/instance";

export type ImportOperation = "copy" | "moveAfterVerification";
export type SourceBehavior = "ask" | "autoPreparePlan" | "ignore";
export type ResumeAfterRestart = "ask" | "automatic";
export type CollisionPolicy = "ask" | "appendSequence";
export type UiLanguage = "en" | "pl";

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
      fileNameTemplate: string;
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
    uiLanguage: UiLanguage;
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
  technicalDetails?: string;
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
        message: localizeCommandErrorCode(candidate.code),
        technicalDetails:
          typeof candidate.technicalDetails === "string"
            ? candidate.technicalDetails
            : candidate.message,
        backupAvailable: candidate.backupAvailable,
      };
    }
  }

  return {
    code: "unknown",
    message: i18n.t("settings.errors.unknown"),
    technicalDetails:
      typeof error === "string" ? error : i18n.t("errors.noDetails"),
  };
}

const LOCALIZED_SETTINGS_ERROR_CODES = new Set([
  "corruptedPrimary",
  "backupNotFound",
  "invalidBackup",
  "validationFailed",
  "settingsIoFailed",
  "serializeFailed",
  "importReadFailed",
  "invalidImport",
  "invalidImportFormat",
  "unsupportedImportVersion",
  "exportWriteFailed",
]);

export function localizeSettingsError(error: unknown): string {
  const normalized = normalizeSettingsError(error);
  return normalized.message;
}

function localizeCommandErrorCode(code: string): string {
  if (LOCALIZED_SETTINGS_ERROR_CODES.has(code)) {
    return i18n.t(`settings.errors.${code}`);
  }
  if (code === "sourceUnavailable" || code === "permissionDenied")
    return i18n.t("commandErrors.sourceUnavailable");
  if (code === "settingsUnavailable")
    return i18n.t("commandErrors.settingsUnavailable");
  if (code.toLocaleLowerCase().includes("state"))
    return i18n.t("commandErrors.stateUnavailable");
  if (code.toLocaleLowerCase().includes("notfound"))
    return i18n.t("commandErrors.notFound");
  if (code.startsWith("scan")) return i18n.t("commandErrors.scanFailed");
  if (code.startsWith("import") || code.startsWith("rollback"))
    return i18n.t("commandErrors.importFailed");
  if (code.startsWith("workflow"))
    return i18n.t("commandErrors.workflowFailed");
  if (code.startsWith("metadata"))
    return i18n.t("commandErrors.metadataFailed");
  if (code.startsWith("thumbnail") || code.startsWith("originalPreview"))
    return i18n.t("commandErrors.thumbnailFailed");
  if (code.startsWith("backup")) return i18n.t("commandErrors.backupFailed");
  return i18n.t("commandErrors.unknown");
}

export function validateSettings(settings: AppSettings): string[] {
  const errors: string[] = [];
  const gap = settings.portable.import.eventGapMinutes;
  if (!Number.isInteger(gap) || gap < 1 || gap > 10_080) {
    errors.push(i18n.t("settings.validation.eventGap"));
  }
  const folderError = validateTemplate(
    settings.portable.naming.folderTemplate,
    new Set([
      "year",
      "month",
      "day",
      "date",
      "event_name",
      "camera_make",
      "camera_model",
      "camera_alias",
      "source_alias",
    ]),
    true,
  );
  if (folderError)
    errors.push(
      i18n.t("settings.validation.folderPrefix", { detail: folderError }),
    );
  const fileNameError = validateTemplate(
    settings.portable.naming.fileNameTemplate,
    new Set([
      "year",
      "month",
      "day",
      "date",
      "event_name",
      "camera_make",
      "camera_model",
      "camera_alias",
      "source_alias",
      "original_name",
    ]),
    false,
  );
  if (fileNameError)
    errors.push(
      i18n.t("settings.validation.filePrefix", { detail: fileNameError }),
    );
  if (
    !Number.isInteger(settings.local.maxConcurrentImports) ||
    settings.local.maxConcurrentImports < 1 ||
    settings.local.maxConcurrentImports > 8
  ) {
    errors.push(i18n.t("settings.validation.concurrency"));
  }
  for (const profile of settings.portable.cameraProfiles) {
    if (!profile.name.trim()) {
      errors.push(i18n.t("settings.validation.profileName"));
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

export function renderFileNamePreview(template: string): string {
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
    original_name: "DSCF0123",
  };
  const stem = template.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const counter = /^counter:0([1-9])$/.exec(key);
    if (counter) return "1".padStart(Number(counter[1]), "0");
    return values[key] ?? match;
  });
  return `${stem}.RAF`;
}

function validateTemplate(
  template: string,
  variables: Set<string>,
  folder: boolean,
): string | null {
  if (!template.trim()) return i18n.t("settings.validation.empty");
  if (!folder && /[\\/]/.test(template))
    return i18n.t("settings.validation.pathSeparator");
  if (folder) {
    const normalized = template.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized))
      return i18n.t("settings.validation.relativePath");
    if (normalized.split("/").some((part) => part === "." || part === ".."))
      return i18n.t("settings.validation.dotSegments");
  }
  let depth = 0;
  for (const character of template) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth < 0 || depth > 1)
      return i18n.t("settings.validation.invalidBraces");
  }
  if (depth !== 0) return i18n.t("settings.validation.unclosedBrace");
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const variable = match[1];
    if (
      !variables.has(variable) &&
      !(!folder && /^counter:0[1-9]$/.test(variable))
    )
      return i18n.t("settings.validation.unknownVariable", {
        variable: `{${variable}}`,
      });
  }
  return null;
}
