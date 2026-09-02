import { invoke } from "@tauri-apps/api/core";

export type BackgroundEventKind =
  | "sourceConnected"
  | "sourceDisconnected"
  | "scanStarted"
  | "scanCompleted"
  | "scanFailed";

export interface BackgroundEvent {
  id: number;
  occurredAtUnixMs: number;
  kind: BackgroundEventKind;
  title: string;
  detail: string;
  sourcePath: string | null;
  scanId: string | null;
}

export interface BackgroundStatus {
  running: boolean;
  lastCheckedAtUnixMs: number | null;
  connectedKnownSourceCount: number;
  activeAutoScanCount: number;
  startAtLoginEnabled: boolean;
  lastError: string | null;
  events: BackgroundEvent[];
  pendingSources: Array<{
    fingerprint: string;
    name: string;
    sourcePath: string;
    state:
      | "awaitingDecision"
      | "scanning"
      | "awaitingProfileConfirmation"
      | "planReady"
      | "ignoredUntilDisconnect";
    probableMatch: boolean;
  }>;
}

export function acknowledgePendingSource(
  path: string,
): Promise<BackgroundStatus> {
  return invoke<BackgroundStatus>("acknowledge_pending_source", { path });
}

export function getBackgroundStatus(): Promise<BackgroundStatus> {
  return invoke<BackgroundStatus>("get_background_status");
}

export function startSourceWorkflow(path: string): Promise<unknown> {
  return invoke("start_source_workflow", { path });
}

export function ignoreSourceUntilDisconnect(
  path: string,
): Promise<BackgroundStatus> {
  return invoke<BackgroundStatus>("ignore_source_until_disconnect", { path });
}

export function refreshBackgroundMonitor(): Promise<BackgroundStatus> {
  return invoke<BackgroundStatus>("refresh_background_monitor");
}
