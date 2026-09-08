import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n/instance";

export interface BackupTarget {
  id: string;
  label: string;
  lastKnownRoot: string;
  createdAtUnixMs: number;
  lastSeenAtUnixMs: number;
}

export interface BackupOperation {
  relativePath: string;
  sourcePath: string;
  destinationPath: string;
  kind: "new" | "changed" | "repair";
  sizeBytes: number;
  sourceSha256: string;
  previousSha256: string | null;
}

export interface BackupPlan {
  targetId: string;
  sourceRoot: string;
  operations: BackupOperation[];
  unchangedFileCount: number;
  totalCopyBytes: number;
}

export interface BackupCommandError {
  code: string;
  message: string;
  technicalDetails?: string;
}

export type BackupJobStatus =
  "running" | "paused" | "completed" | "failed" | "cancelled";

export type BackupPhase =
  "scanningLibrary" | "hashing" | "copying" | "verifying" | "finalizing";

export interface BackupReport {
  copiedFileCount: number;
  unchangedFileCount: number;
  versionedFileCount: number;
  copiedBytes: number;
}

export interface BackupJob {
  id: string;
  targetId: string;
  sourcePath: string;
  targetPath: string;
  status: BackupJobStatus;
  phase: BackupPhase;
  processedFileCount: number;
  totalFileCount: number | null;
  processedBytes: number;
  totalBytes: number | null;
  currentPath: string | null;
  pauseRequested: boolean;
  startedAtUnixMs: number;
  updatedAtUnixMs: number;
  error: string | null;
  report: BackupReport | null;
}

export type BackupPlanningJobStatus =
  "running" | "completed" | "failed" | "cancelled";

export interface BackupPlanningJob {
  id: string;
  targetId: string;
  sourcePath: string;
  targetPath: string;
  status: BackupPlanningJobStatus;
  phase: "scanningLibrary" | "hashing";
  processedFileCount: number;
  totalFileCount: number | null;
  processedBytes: number;
  totalBytes: number | null;
  currentPath: string | null;
  cancelRequested: boolean;
  startedAtUnixMs: number;
  updatedAtUnixMs: number;
  error: string | null;
  plan: BackupPlan | null;
}

export type BackupRunOutcome = "running" | "succeeded" | "failed" | "cancelled";

export interface BackupRun {
  id: string;
  targetId: string;
  sourceRoot: string;
  startedAtUnixMs: number;
  finishedAtUnixMs: number | null;
  outcome: BackupRunOutcome;
  copiedFileCount: number;
  unchangedFileCount: number;
  versionedFileCount: number;
  copiedBytes: number;
  error: string | null;
}

export type BackupFileStatus =
  | "current"
  | "new"
  | "changed"
  | "corrupt"
  | "missingInBackup"
  | "deletedFromLibrary";

export interface BackupFileVersion {
  id: number;
  relativePath: string;
  contentSha256: string;
  versionPath: string;
  archivedAtUnixMs: number;
}

export interface BackupFileState {
  relativePath: string;
  status: BackupFileStatus;
  sizeBytes: number;
  sourceSha256: string | null;
  backupSha256: string | null;
  expectedSha256: string | null;
  backedUpAtUnixMs: number | null;
  orphaned: boolean;
  versions: BackupFileVersion[];
}

export interface BackupSnapshot {
  targetId: string;
  sourceRoot: string;
  backupDirectory: string;
  scannedAtUnixMs: number;
  lastSuccessfulRun: BackupRun | null;
  files: BackupFileState[];
}

export function registerBackupTarget(
  path: string,
  label: string,
): Promise<BackupTarget> {
  return invoke<BackupTarget>("register_backup_target", { path, label });
}

export function listBackupTargets(): Promise<BackupTarget[]> {
  return invoke<BackupTarget[]>("list_backup_targets");
}

export function recognizeBackupTarget(
  path: string,
): Promise<BackupTarget | null> {
  return invoke<BackupTarget | null>("recognize_backup_target", { path });
}

export function removeBackupTarget(targetId: string): Promise<void> {
  return invoke<void>("remove_backup_target", { targetId });
}

export function startBackupPlanningJob(
  targetId: string,
  targetPath: string,
  sourcePath: string,
): Promise<BackupPlanningJob> {
  return invoke<BackupPlanningJob>("start_backup_planning_job", {
    targetId,
    targetPath,
    sourcePath,
  });
}

export function listBackupPlanningJobs(): Promise<BackupPlanningJob[]> {
  return invoke<BackupPlanningJob[]>("list_backup_planning_jobs");
}

export function cancelBackupPlanningJob(
  jobId: string,
): Promise<BackupPlanningJob> {
  return invoke<BackupPlanningJob>("cancel_backup_planning_job", { jobId });
}

export function startBackupJob(
  plan: BackupPlan,
  targetPath: string,
): Promise<BackupJob> {
  return invoke<BackupJob>("start_backup_job", {
    plan,
    targetPath,
  });
}

export function listBackupJobs(): Promise<BackupJob[]> {
  return invoke<BackupJob[]>("list_backup_jobs");
}

export function getBackupJob(jobId: string): Promise<BackupJob> {
  return invoke<BackupJob>("get_backup_job", { jobId });
}

export function pauseBackupJob(jobId: string): Promise<BackupJob> {
  return invoke<BackupJob>("pause_backup_job", { jobId });
}

export function resumeBackupJob(jobId: string): Promise<BackupJob> {
  return invoke<BackupJob>("resume_backup_job", { jobId });
}

export function cancelBackupJob(jobId: string): Promise<BackupJob> {
  return invoke<BackupJob>("cancel_backup_job", { jobId });
}

export function inspectBackup(
  targetId: string,
  targetPath: string,
  sourcePath: string,
): Promise<BackupSnapshot> {
  return invoke<BackupSnapshot>("inspect_backup", {
    targetId,
    targetPath,
    sourcePath,
  });
}

export function listBackupHistory(
  targetId: string,
  targetPath: string,
): Promise<BackupRun[]> {
  return invoke<BackupRun[]>("list_backup_history", { targetId, targetPath });
}

export function openBackupDirectory(
  targetId: string,
  targetPath: string,
): Promise<void> {
  return invoke<void>("open_backup_directory", { targetId, targetPath });
}

export function normalizeBackupError(error: unknown): BackupCommandError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<BackupCommandError>;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return {
        code: candidate.code,
        message: backupErrorMessage(candidate.code),
        technicalDetails: candidate.technicalDetails ?? candidate.message,
      };
    }
  }
  return {
    code: "unknown",
    message: i18n.t("commandErrors.backupFailed"),
    technicalDetails:
      typeof error === "string" ? error : i18n.t("errors.noDetails"),
  };
}

const SPECIFIC_BACKUP_ERROR_CODES = new Set([
  "invalidTargetPath",
  "invalidSourcePath",
  "overlappingBackupRoots",
  "wrongBackupTarget",
  "invalidTargetMarker",
  "backupSourceChanged",
  "backupVerificationFailed",
  "backupIoFailed",
  "openBackupDirectoryFailed",
]);

function backupErrorMessage(code: string): string {
  const key = SPECIFIC_BACKUP_ERROR_CODES.has(code) ? code : "backupFailed";
  return i18n.t(`commandErrors.${key}`);
}
