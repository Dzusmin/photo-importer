import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const { getSystemStatus } = vi.hoisted(() => ({ getSystemStatus: vi.fn() }));
vi.mock("./shared/systemStatus", () => ({ getSystemStatus }));
vi.mock("./features/background/BackgroundMonitor", () => ({
  BackgroundMonitor: () => <div>monitor-test</div>,
}));
vi.mock("./features/sources/SourceScanner", () => ({
  SourceScanner: () => <div>scanner-test</div>,
}));
vi.mock("./features/settings/SettingsPanel", () => ({
  SettingsPanel: () => <div>settings-test</div>,
}));
vi.mock("./features/backups/BackupPanel", () => ({
  BackupPanel: () => <div>backup-test</div>,
}));

describe("App", () => {
  beforeEach(() => getSystemStatus.mockReset());

  it("reports a ready backend and navigates between main views", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
    });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Gotowa")).toBeInTheDocument();
    expect(screen.getByText("scanner-test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Backup" }));
    expect(screen.getByText("backup-test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ustawienia" }));
    expect(screen.getByText("settings-test")).toBeInTheDocument();
    expect(screen.queryByText("scanner-test")).not.toBeInTheDocument();
  });

  it("shows a connection error when diagnostics fail", async () => {
    getSystemStatus.mockResolvedValue(null);
    render(<App />);

    expect(await screen.findByText("Brak połączenia")).toBeInTheDocument();
  });
});
