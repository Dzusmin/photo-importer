import { invoke } from "@tauri-apps/api/core";

export interface SystemStatus {
  productName: string;
  appVersion: string;
  operatingSystem: string;
  architecture: string;
  backendStatus: "ready";
}

export async function getSystemStatus(): Promise<SystemStatus | null> {
  try {
    return await invoke<SystemStatus>("get_system_status");
  } catch {
    return null;
  }
}

export function describeSystem(status: SystemStatus): string {
  return `${status.operatingSystem} / ${status.architecture}`;
}
