import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSystemStatus } from "./systemStatus";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("systemStatus", () => {
  beforeEach(() => invoke.mockReset());

  it("returns backend diagnostics", async () => {
    const status = {
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready" as const,
    };
    invoke.mockResolvedValue(status);

    await expect(getSystemStatus()).resolves.toEqual(status);
    expect(invoke).toHaveBeenCalledWith("get_system_status");
  });

  it("preserves an explicit unavailable status", async () => {
    invoke.mockResolvedValue(null);

    await expect(getSystemStatus()).resolves.toBeNull();
  });
});
