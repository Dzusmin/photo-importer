import { invoke } from "@tauri-apps/api/core";

export interface SourceVolume {
  fingerprint: string;
  markerUuid: string | null;
  platformVolumeId: string | null;
  name: string;
  mountPath: string;
  fileSystem: string;
  totalBytes: number;
  availableBytes: number;
  removable: boolean;
  readOnly: boolean;
  containsDcim: boolean;
  likelyCameraSource: boolean;
}

export type MediaFileKind = "jpeg" | "heic" | "raw" | "video" | "xmp";
export type CaptureTimeSource =
  "exif" | "videoMetadata" | "fileModified" | "unknown";

export interface CameraIdentity {
  make: string | null;
  model: string | null;
  serialNumber: string | null;
}

export interface MediaFile {
  path: string;
  relativePath: string;
  kind: MediaFileKind;
  sizeBytes: number;
  modifiedAtUnixMs: number;
  embeddedCapturedAtUnixMs: number | null;
  embeddedTimeSource: CaptureTimeSource | null;
  cameraIdentity: CameraIdentity | null;
}

export interface MediaItem {
  key: string;
  originalCapturedAtUnixMs: number;
  capturedAtUnixMs: number;
  timeSource: CaptureTimeSource;
  timeCorrectionSeconds: number;
  totalSizeBytes: number;
  files: MediaFile[];
  hasRawJpegPair: boolean;
  hasSidecar: boolean;
  cameraIdentity: CameraIdentity | null;
  cameraMetadataConflict: boolean;
}

export interface EventGroup {
  index: number;
  startsAtUnixMs: number;
  endsAtUnixMs: number;
  totalSizeBytes: number;
  items: MediaItem[];
}

export interface SourceScanResponse {
  scan: {
    root: string;
    items: MediaItem[];
    supportedFileCount: number;
    skippedFileCount: number;
    totalSizeBytes: number;
    warnings: Array<{ path: string; message: string }>;
    timings: {
      discoveryMs: number;
      metadataMs: number;
    };
  };
  events: EventGroup[];
  timestampBasis: "embeddedWithFileFallback";
  eventGapMinutes: number;
  importMatches: ItemImportMatch[];
}

export interface PendingSourceWorkflow {
  sourceId: string;
  sourceRoot: string;
  sourceIdentity: SourceIdentity | null;
  displayName: string;
  state: SourceWorkflowState;
  scan: SourceScanResponse | null;
  plan: ImportPlan | null;
  settingsSchemaVersion: number;
  settingsRevision: string;
  editor: {
    eventNames: Record<number, string>;
    excludedItemKeys: string[];
    itemProfileAssignments: Record<string, string>;
  };
  error: string | null;
  updatedAtUnixMs: number;
}

export type SourceWorkflowState =
  | "detected"
  | "awaitingDecision"
  | "scanning"
  | "awaitingProfileConfirmation"
  | "preparingPlan"
  | "planReady"
  | "importing"
  | "disconnected"
  | "failedRecoverable"
  | "ignoredUntilDisconnect";

export interface SourceIdentity {
  markerUuid: string | null;
  platformVolumeId: string | null;
  fallbackFingerprint: string;
}

export interface MediaScanJob {
  id: string;
  path: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase:
    | "discovering"
    | "readingMetadata"
    | "comparingHistory"
    | "groupingEvents"
    | "completed";
  discoveredFileCount: number;
  processedFileCount: number;
  totalSupportedFileCount: number | null;
  currentPath: string | null;
  historyBytesRead: number;
  historyCacheHitCount: number;
  fullyHashedFileCount: number;
  timings: {
    discoveryMs: number;
    metadataMs: number;
    comparingHistoryMs: number;
    groupingEventsMs: number;
  };
  startedAtUnixMs: number;
  updatedAtUnixMs: number;
  error: string | null;
  result: SourceScanResponse | null;
}

export interface ThumbnailPayload {
  key: string;
  path: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  cacheHit: boolean;
  timings: {
    lookupMs: number;
    decodeMs: number;
    resizeMs: number;
    encodeAndPersistMs: number;
    databaseMs: number;
    totalMs: number;
  };
}

export interface ItemImportMatch {
  itemKey: string;
  state: "new" | "partiallyImported" | "imported";
  importedFileCount: number;
  totalFileCount: number;
  importedPaths: string[];
  importedSourcePaths: string[];
}

export interface EventPlanInput {
  event: EventGroup;
  name: string;
}

export interface ImportPlan {
  status: "ready" | "requiresDecision" | "empty";
  libraryRoot: string;
  events: PlannedEvent[];
  conflicts: PlanConflict[];
  itemCount: number;
  fileCount: number;
  totalSizeBytes: number;
  excludedItemCount: number;
  excludedFileCount: number;
}

export interface PlannedEvent {
  eventIndex: number;
  eventName: string;
  folderRelativePath: string;
  startsAtUnixMs: number;
  totalSizeBytes: number;
  items: PlannedMediaItem[];
}

export interface PlannedMediaItem {
  itemKey: string;
  capturedAtUnixMs: number;
  totalSizeBytes: number;
  files: PlannedFileOperation[];
  hasRawJpegPair: boolean;
  hasSidecar: boolean;
  cameraAlias: string | null;
}

export interface PlannedFileOperation {
  sourcePath: string;
  sourceRelativePath: string;
  destinationPath: string;
  destinationRelativePath: string;
  kind: MediaFileKind;
  sizeBytes: number;
}

export interface PlanConflict {
  kind: "destinationExists" | "duplicateDestination";
  itemKey: string;
  destinationPath: string;
}

export interface ImportPlanPreviewRequest {
  events: EventPlanInput[];
  excludedItemKeys: string[];
  excludedSourcePaths: string[];
  context: {
    cameraMake: string | null;
    cameraModel: string | null;
    cameraAlias: string | null;
    sourceAlias: string | null;
  };
  itemContexts: Record<string, ImportPlanPreviewRequest["context"]>;
}

export type ImportSessionStatus =
  | "planned"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "failedRecoverable"
  | "rollingBack"
  | "rollbackFailed"
  | "cancelled";

export interface ImportSession {
  id: string;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  completedAtUnixMs: number | null;
  operation: "copy" | "moveAfterVerification";
  status: ImportSessionStatus;
  libraryRoot: string;
  sourceFingerprint: string | null;
  sourceIdentity: SourceIdentity | null;
  fileCount: number;
  completedFileCount: number;
  itemCount: number;
  completedItemCount: number;
  totalSizeBytes: number;
  completedSizeBytes: number;
  lastError: string | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  moveConfirmed: boolean;
  operations: ImportOperationRecord[];
}

export interface ImportOperationRecord {
  id: number;
  ordinal: number;
  itemKey: string;
  eventName: string;
  sourcePath: string;
  sourceRelativePath: string;
  destinationPath: string;
  destinationRelativePath: string;
  kind: string;
  sizeBytes: number;
  status: "pending" | "copying" | "verifying" | "completed" | "failed";
  sourceSha256: string | null;
  destinationSha256: string | null;
  attempts: number;
  lastError: string | null;
  sourceDeleted: boolean;
}

export interface TimeCorrectionResponse {
  items: MediaItem[];
  events: EventGroup[];
  changedItemCount: number;
}

export function listMediaSources(): Promise<SourceVolume[]> {
  return invoke<SourceVolume[]>("list_media_sources");
}

export function ensureMediaSourceMarker(path: string): Promise<string> {
  return invoke<string>("ensure_media_source_marker", { path });
}

export function startMediaScan(path: string): Promise<MediaScanJob> {
  return invoke<MediaScanJob>("start_media_scan", { path });
}

export function listMediaScans(): Promise<MediaScanJob[]> {
  return invoke<MediaScanJob[]>("list_media_scans");
}

export function cancelMediaScan(scanId: string): Promise<MediaScanJob> {
  return invoke<MediaScanJob>("cancel_media_scan", { scanId });
}

export function getMediaThumbnail(
  path: string,
  maxDimension: number,
): Promise<ThumbnailPayload> {
  return invoke<ThumbnailPayload>("get_media_thumbnail", {
    path,
    maxDimension,
  });
}

export async function clearThumbnailCache(): Promise<void> {
  await invoke<void>("clear_thumbnail_cache");
  window.dispatchEvent(new Event("thumbnail-cache-cleared"));
}

export function correctCaptureTimes(
  items: MediaItem[],
  itemKeys: string[],
  offsetSeconds: number,
): Promise<TimeCorrectionResponse> {
  return invoke<TimeCorrectionResponse>("correct_capture_times", {
    items,
    itemKeys,
    offsetSeconds,
  });
}

export function buildImportPlanPreview(
  request: ImportPlanPreviewRequest,
): Promise<ImportPlan> {
  return invoke<ImportPlan>("build_import_plan_preview", { request });
}

export function announceImportPlanReady(fileCount: number): Promise<void> {
  return invoke<void>("announce_import_plan_ready", { fileCount });
}

export function savePendingSourceWorkflow(
  workflow: Pick<PendingSourceWorkflow, "sourceRoot" | "scan" | "plan"> &
    Partial<Omit<PendingSourceWorkflow, "sourceRoot" | "scan" | "plan">>,
): Promise<void> {
  return invoke<void>("save_pending_source_workflow", { workflow });
}

export function listPendingSourceWorkflows(): Promise<PendingSourceWorkflow[]> {
  return invoke<PendingSourceWorkflow[]>("list_pending_source_workflows");
}

export function deletePendingSourceWorkflow(sourceRoot: string): Promise<void> {
  return invoke<void>("delete_pending_source_workflow", { sourceRoot });
}

export function createImportSession(
  plan: ImportPlan,
  sourceFingerprint: string | null,
  sourceIdentity: SourceIdentity | null,
  confirmMove: boolean,
): Promise<ImportSession> {
  return invoke<ImportSession>("create_import_session", {
    request: { plan, sourceFingerprint, sourceIdentity, confirmMove },
  });
}

export function startImportSession(
  sessionId: string,
  sourceRoot: string | null = null,
): Promise<ImportSession> {
  return invoke<ImportSession>("start_import_session", {
    sessionId,
    sourceRoot,
  });
}

export function pauseImportSession(sessionId: string): Promise<ImportSession> {
  return invoke<ImportSession>("pause_import_session", { sessionId });
}

export function cancelImportSession(
  sessionId: string,
  mode: "keepCompleted" | "rollbackSession" = "keepCompleted",
): Promise<ImportSession> {
  return invoke<ImportSession>("cancel_import_session", { sessionId, mode });
}

export function getImportSession(sessionId: string): Promise<ImportSession> {
  return invoke<ImportSession>("get_import_session", { sessionId });
}

export function listImportSessions(): Promise<ImportSession[]> {
  return invoke<ImportSession[]>("list_import_sessions");
}

export function retryImportRollback(sessionId: string): Promise<ImportSession> {
  return invoke<ImportSession>("retry_import_rollback", { sessionId });
}

export function correctionToSeconds(
  value: number,
  unit: "seconds" | "minutes" | "hours",
): number {
  const multiplier = unit === "hours" ? 3600 : unit === "minutes" ? 60 : 1;
  return Math.trunc(value * multiplier);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function displayFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
