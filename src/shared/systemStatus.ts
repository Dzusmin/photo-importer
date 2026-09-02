import { invoke } from "@tauri-apps/api/core";

export interface SystemStatus {
  productName: string;
  appVersion: string;
  operatingSystem: string;
  architecture: string;
  backendStatus: "ready" | "degraded" | "error";
}

export function getSystemStatus(): Promise<SystemStatus | null> {
  return invoke<SystemStatus>("get_system_status");
}

export function describeSystem(status: SystemStatus): string {
  return `${status.operatingSystem} / ${status.architecture}`;
}
