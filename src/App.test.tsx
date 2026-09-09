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
  SourceScanner: ({ openWorkflowId }: { openWorkflowId?: string | null }) => (
    <div data-testid="scanner-test">
      scanner-test:{openWorkflowId ?? "none"}
    </div>
  ),
}));
vi.mock("./features/plans/PlansPanel", () => ({
  PlansPanel: ({ onOpen }: { onOpen: (sourceId: string) => void }) => (
    <button type="button" onClick={() => onOpen("marker:card-1")}>
      open-plan-test
    </button>
  ),
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

    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("scanner-test")).toHaveTextContent(
      "scanner-test:none",
    );
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("monitor-test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Backup" }));
    expect(screen.getByText("backup-test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("settings-test")).toBeInTheDocument();
    expect(screen.getByTestId("scanner-test")).not.toBeVisible();
  });

  it("keeps the home scanner mounted and clears an explicitly opened plan", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
    });
    const user = userEvent.setup();
    render(<App />);

    const scanner = await screen.findByTestId("scanner-test");
    await user.click(screen.getByRole("button", { name: "Plans" }));
    expect(scanner).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "open-plan-test" }));
    expect(screen.getByTestId("scanner-test")).toBe(scanner);
    expect(scanner).toBeVisible();
    expect(scanner).toHaveTextContent("scanner-test:marker:card-1");

    await user.click(screen.getByRole("button", { name: "Plans" }));
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByTestId("scanner-test")).toBe(scanner);
    expect(scanner).toBeVisible();
    expect(scanner).toHaveTextContent("scanner-test:none");
  });

  it("shows a connection error when diagnostics fail", async () => {
    getSystemStatus.mockResolvedValue(null);
    render(<App />);

    expect((await screen.findAllByText("Disconnected")).length).toBeGreaterThan(
      0,
    );
  });
});
