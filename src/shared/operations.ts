import { invoke } from "@tauri-apps/api/core";

export type OperationKind = "scan" | "import" | "backupPlanning" | "backup";

export type OperationStatus =
  "queued" | "running" | "paused" | "attention" | "completed" | "cancelled";

export type OperationSource =
  "scans" | "imports" | "backupPlanning" | "backups";

export type OperationRoute =
  | { kind: "scan"; scanId: string }
  | { kind: "import"; importSessionId: string }
  | { kind: "backupPlanning"; jobId: string; targetId: string }
  | { kind: "backup"; jobId: string; targetId: string };

export interface OperationProgress {
  completedItems: number;
  totalItems: number | null;
  completedBytes: number | null;
  totalBytes: number | null;
}

export interface OperationSummary {
  kind: OperationKind;
  id: string;
  status: OperationStatus;
  updatedAtUnixMs: number;
  label: string;
  context: string | null;
  progress: OperationProgress;
  error: string | null;
  attention: boolean;
  route: OperationRoute;
}

export interface OperationDiagnostic {
  source: OperationSource;
  code: string;
  message: string;
}

export interface OperationsSnapshot {
  operations: OperationSummary[];
  diagnostics: OperationDiagnostic[];
}

export interface OperationChangedPayload {
  operation: OperationSummary;
}

export function listOperations(): Promise<OperationsSnapshot> {
  return invoke<OperationsSnapshot>("list_operations");
}

export function operationKey(operation: Pick<OperationSummary, "kind" | "id">) {
  return `${operation.kind}:${operation.id}`;
}

export function operationRouteKey(route: OperationRoute) {
  if (route.kind === "scan") return `scan:${route.scanId}`;
  if (route.kind === "import") return `import:${route.importSessionId}`;
  return `${route.kind}:${route.jobId}`;
}

export function isActiveOperation(operation: OperationSummary) {
  return ["queued", "running", "paused"].includes(operation.status);
}

export function isTerminalOperation(operation: OperationSummary) {
  return ["completed", "cancelled"].includes(operation.status);
}

export function mergeOperationUpdate(
  current: Record<string, OperationSummary>,
  operation: OperationSummary,
) {
  const key = operationKey(operation);
  const previous = current[key];
  if (previous) {
    if (previous.updatedAtUnixMs > operation.updatedAtUnixMs) return current;
    if (
      previous.updatedAtUnixMs === operation.updatedAtUnixMs &&
      isTerminalOperation(previous) &&
      !isTerminalOperation(operation)
    ) {
      return current;
    }
  }
  return { ...current, [key]: operation };
}

export function mergeOperationsSnapshot(
  current: Record<string, OperationSummary>,
  snapshot: OperationsSnapshot,
) {
  const failedSources = new Set(
    snapshot.diagnostics.map(({ source }) => source),
  );
  const successfulKinds = new Set<OperationKind>();
  const sourceKinds: Record<OperationSource, OperationKind> = {
    scans: "scan",
    imports: "import",
    backupPlanning: "backupPlanning",
    backups: "backup",
  };
  for (const source of Object.keys(sourceKinds) as OperationSource[]) {
    if (!failedSources.has(source)) successfulKinds.add(sourceKinds[source]);
  }

  let next = Object.fromEntries(
    Object.entries(current).filter(
      ([, operation]) =>
        !successfulKinds.has(operation.kind) || isTerminalOperation(operation),
    ),
  );
  for (const operation of snapshot.operations) {
    next = mergeOperationUpdate(next, operation);
  }
  return next;
}

export function applyOperationsSnapshot(
  current: Record<string, OperationSummary>,
  snapshot: OperationsSnapshot,
  eventsDuringRequest: OperationSummary[],
) {
  let next = mergeOperationsSnapshot(current, snapshot);
  for (const operation of eventsDuringRequest) {
    next = mergeOperationUpdate(next, operation);
  }
  return next;
}
