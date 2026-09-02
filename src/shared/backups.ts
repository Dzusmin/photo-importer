import { invoke } from "@tauri-apps/api/core";

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

export function prepareBackupPlan(
  targetId: string,
  targetPath: string,
  sourcePath: string,
): Promise<BackupPlan> {
  return invoke<BackupPlan>("prepare_backup_plan", {
    targetId,
    targetPath,
    sourcePath,
  });
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

export function normalizeBackupError(error: unknown): BackupCommandError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<BackupCommandError>;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return {
        code: candidate.code,
        message: friendlyBackupMessages[candidate.code] ?? candidate.message,
      };
    }
  }
  return {
    code: "unknown",
    message:
      typeof error === "string" ? error : "Wystąpił nieznany błąd backupu.",
  };
}

const friendlyBackupMessages: Record<string, string> = {
  invalidTargetPath: "Wybrany dysk backupu nie jest dostępny.",
  invalidSourcePath:
    "Katalog biblioteki nie jest dostępny. Sprawdź go w ustawieniach.",
  overlappingBackupRoots:
    "Biblioteka i cel backupu nie mogą znajdować się wewnątrz siebie.",
  wrongBackupTarget:
    "Pod wskazaną ścieżką znajduje się inny dysk. Odłącz go i podłącz właściwy cel backupu.",
  invalidTargetMarker:
    "Nie można odczytać identyfikatora dysku backupu. Nie zapisano żadnych plików.",
  backupSourceChanged:
    "Plik źródłowy zmienił się podczas backupu. Przygotuj nowy plan i spróbuj ponownie.",
  backupVerificationFailed:
    "Skopiowany plik nie przeszedł weryfikacji. Oryginalny plik pozostał bez zmian.",
  backupIoFailed:
    "Nie udało się odczytać lub zapisać pliku. Sprawdź, czy dysk jest podłączony i ma wolne miejsce.",
};
