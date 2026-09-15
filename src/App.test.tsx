import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { OperationSummary, OperationsSnapshot } from "./shared/operations";

const eventBus = vi.hoisted(
  () => new Map<string, Set<(event: { payload: unknown }) => void>>(),
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      const handlers = eventBus.get(name) ?? new Set();
      handlers.add(handler);
      eventBus.set(name, handlers);
      return () => handlers.delete(handler);
    },
  ),
}));

async function emitOperation(operation: unknown) {
  for (const handler of eventBus.get("operations://changed") ?? []) {
    handler({ payload: { operation } });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function operationSummary(
  id: string,
  updatedAtUnixMs: number,
  patch: Partial<OperationSummary> = {},
): OperationSummary {
  return {
    kind: "scan",
    id,
    status: "running",
    updatedAtUnixMs,
    label: id,
    context: `${id}:context`,
    progress: {
      completedItems: 1,
      totalItems: 2,
      completedBytes: null,
      totalBytes: null,
    },
    error: null,
    attention: false,
    route: { kind: "scan", scanId: id },
    ...patch,
  };
}

const { getSystemStatus, listImportEvents, listOperations } = vi.hoisted(
  () => ({
    getSystemStatus: vi.fn(),
    listImportEvents: vi.fn(),
    listOperations: vi.fn(),
  }),
);
vi.mock("./shared/systemStatus", () => ({ getSystemStatus }));
vi.mock("./shared/sources", () => ({ listImportEvents }));
vi.mock("./shared/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared/operations")>()),
  listOperations,
}));
vi.mock("./features/background/BackgroundMonitor", () => ({
  BackgroundMonitor: ({
    onAttentionChange,
    onOpenWorkflow,
  }: {
    onAttentionChange?: (attention: unknown[]) => void;
    onOpenWorkflow?: (sourceId: string) => void;
  }) => (
    <div>
      monitor-test
      <button
        type="button"
        onClick={() =>
          onAttentionChange?.([
            {
              sourceId: "marker:card-29",
              sourcePath: "E:\\",
              displayName: "Card 29",
              detail: "Automatic import failed",
            },
          ])
        }
      >
        raise-attention-test
      </button>
      <button type="button" onClick={() => onOpenWorkflow?.("marker:card-29")}>
        open-attention-workflow-test
      </button>
    </div>
  ),
}));
vi.mock("./features/sources/SourceScanner", () => ({
  SourceScanner: ({
    openWorkflowId,
    openOperationRoute,
    onOpenHistory,
  }: {
    openWorkflowId?: string | null;
    openOperationRoute?:
      | { kind: "scan"; scanId: string }
      | { kind: "import"; importSessionId: string }
      | null;
    onOpenHistory?: () => void;
  }) => (
    <div data-testid="scanner-test">
      scanner-test:{openWorkflowId ?? "none"}:
      {openOperationRoute?.kind === "scan"
        ? openOperationRoute.scanId
        : openOperationRoute?.kind === "import"
          ? openOperationRoute.importSessionId
          : "none"}
      <button type="button" onClick={onOpenHistory}>
        open-history-test
      </button>
    </div>
  ),
}));
vi.mock("./features/plans/PlansPanel", () => ({
  PlansPanel: ({
    onOpen,
    refreshRevision,
  }: {
    onOpen: (sourceId: string) => void;
    refreshRevision?: number;
  }) => (
    <div data-testid="plans-test" data-refresh-revision={refreshRevision}>
      plans-test
      <button type="button" onClick={() => onOpen("marker:card-1")}>
        open-plan-test
      </button>
    </div>
  ),
}));
vi.mock("./features/settings/SettingsPanel", () => ({
  SettingsPanel: ({
    onDirtyChange,
  }: {
    onDirtyChange?: (dirty: boolean) => void;
  }) => (
    <div>
      settings-test
      <input aria-label="settings-draft-test" defaultValue="" />
      <button
        type="button"
        onClick={() => {
          const draft = document.querySelector<HTMLInputElement>(
            '[aria-label="settings-draft-test"]',
          );
          if (draft) draft.value = "unsaved draft";
          onDirtyChange?.(true);
        }}
      >
        make-settings-dirty-test
      </button>
    </div>
  ),
}));
vi.mock("./features/backups/BackupPanel", () => ({
  BackupPanel: ({
    openOperationRoute,
  }: {
    openOperationRoute?: {
      kind: "backup" | "backupPlanning";
      jobId: string;
      targetId: string;
    } | null;
  }) => (
    <div>
      backup-test
      <span data-testid="backup-route-test">
        {openOperationRoute
          ? `${openOperationRoute.kind}:${openOperationRoute.jobId}:${openOperationRoute.targetId}`
          : "none"}
      </span>
      <input aria-label="backup-context-test" defaultValue="" />
    </div>
  ),
}));
vi.mock("./features/history/ImportHistoryPanel", () => ({
  ImportHistoryPanel: ({ refreshRevision }: { refreshRevision?: number }) => (
    <div data-testid="history-test" data-refresh-revision={refreshRevision}>
      history-test
    </div>
  ),
}));

describe("App", () => {
  beforeEach(() => {
    eventBus.clear();
    getSystemStatus.mockReset();
    listImportEvents.mockReset();
    listImportEvents.mockResolvedValue({ events: [], needsAttention: [] });
    listOperations.mockReset();
    listOperations.mockResolvedValue({ operations: [], diagnostics: [] });
  });

  it("reports a ready backend and navigates between main views", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const user = userEvent.setup();
    render(<App />);

    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("scanner-test")).toHaveTextContent(
      "scanner-test:none",
    );
    await user.click(screen.getByRole("button", { name: "open-history-test" }));
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
      importEngineStatus: "ready",
      importEngineLastError: null,
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

  it("asks before leaving settings with unsaved changes", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const user = userEvent.setup();
    render(<App />);

    await screen.findAllByText("Ready");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(
      screen.getByRole("button", { name: "make-settings-dirty-test" }),
    );
    expect(screen.getByLabelText("settings-draft-test")).toHaveValue(
      "unsaved draft",
    );
    await user.click(screen.getByRole("button", { name: "Backup" }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByText("settings-test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Backup" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByText("backup-test")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("settings-draft-test")).toHaveValue("");
    confirm.mockRestore();
  });

  it("preserves operation state and refreshes cached read-only views on return", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Backup" }));
    const backupContext = screen.getByLabelText("backup-context-test");
    await user.type(backupContext, "running backup");

    await user.click(screen.getByRole("button", { name: "Plans" }));
    const plans = screen.getByTestId("plans-test");
    expect(plans).toHaveAttribute("data-refresh-revision", "1");
    expect(backupContext).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "Backup" }));
    expect(screen.getByLabelText("backup-context-test")).toBe(backupContext);
    expect(backupContext).toHaveValue("running backup");

    await user.click(screen.getByRole("button", { name: "Plans" }));
    expect(screen.getByTestId("plans-test")).toBe(plans);
    expect(plans).toHaveAttribute("data-refresh-revision", "2");

    await user.click(screen.getByRole("button", { name: "Activity" }));
    const history = screen.getByTestId("history-test");
    expect(history).toHaveAttribute("data-refresh-revision", "1");
    await user.click(screen.getByRole("button", { name: "Plans" }));
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByTestId("history-test")).toBe(history);
    expect(history).toHaveAttribute("data-refresh-revision", "2");
  });

  it("shows a connection error when diagnostics fail", async () => {
    getSystemStatus.mockResolvedValue(null);
    render(<App />);

    expect((await screen.findAllByText("Disconnected")).length).toBeGreaterThan(
      0,
    );
  });

  it("keeps startup available and reports history synchronization until retry succeeds", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    listImportEvents
      .mockRejectedValueOnce(new Error("history manifest is unreadable"))
      .mockResolvedValueOnce({ events: [], needsAttention: [] });
    const diagnostic = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByText("Import history needs attention"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("scanner-test")).toBeVisible();
    expect(screen.getAllByText("Limited functionality").length).toBeGreaterThan(
      0,
    );
    expect(
      screen
        .getByRole("button", { name: /Activity/ })
        .querySelector(".main-nav__attention"),
    ).toBeInTheDocument();
    expect(diagnostic).toHaveBeenCalledWith(
      "[Photo Importer] Import history synchronization failed.",
      expect.objectContaining({ message: "history manifest is unreadable" }),
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(listImportEvents).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText("Import history needs attention"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen
        .getByRole("button", { name: "Activity" })
        .querySelector(".main-nav__attention"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it.each([
    ["degraded", "Degraded", "Library is unavailable"],
    ["error", "Error", "Import manifest cannot be read"],
  ] as const)(
    "shows the authoritative %s import engine health and its last error",
    async (importEngineStatus, label, lastError) => {
      getSystemStatus.mockResolvedValue({
        productName: "Photo Importer",
        appVersion: "0.1.0",
        operatingSystem: "windows",
        architecture: "x86_64",
        backendStatus: "ready",
        importEngineStatus,
        importEngineLastError: lastError,
      });
      const user = userEvent.setup();
      render(<App />);

      await user.click(await screen.findByRole("button", { name: "Activity" }));

      expect(screen.getByText("Import engine")).toBeInTheDocument();
      expect(screen.getByText(label)).toHaveClass(
        `diagnostic__status health--${importEngineStatus}`,
      );
      expect(screen.getByText(lastError)).toHaveAttribute("title", lastError);
      await waitFor(() => expect(getSystemStatus).toHaveBeenCalledTimes(2));
    },
  );

  it("counts every backend operation and routes each kind to the exact job", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const progress = {
      completedItems: 1,
      totalItems: 10,
      completedBytes: null,
      totalBytes: null,
    };
    listOperations.mockResolvedValue({
      diagnostics: [],
      operations: [
        {
          kind: "scan",
          id: "scan-39",
          status: "running",
          updatedAtUnixMs: 1,
          label: "Scan card E",
          context: "E:\\",
          progress,
          error: null,
          attention: false,
          route: { kind: "scan", scanId: "scan-39" },
        },
        {
          kind: "import",
          id: "import-39",
          status: "queued",
          updatedAtUnixMs: 2,
          label: "Import session 39",
          context: "Library",
          progress,
          error: null,
          attention: false,
          route: { kind: "import", importSessionId: "import-39" },
        },
        {
          kind: "backupPlanning",
          id: "plan-39",
          status: "running",
          updatedAtUnixMs: 3,
          label: "Plan archive",
          context: "F:\\",
          progress,
          error: null,
          attention: false,
          route: {
            kind: "backupPlanning",
            jobId: "plan-39",
            targetId: "target-39",
          },
        },
        {
          kind: "backup",
          id: "backup-39",
          status: "paused",
          updatedAtUnixMs: 4,
          label: "Backup archive",
          context: "F:\\",
          progress,
          error: null,
          attention: false,
          route: {
            kind: "backup",
            jobId: "backup-39",
            targetId: "target-39",
          },
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);

    const activityNavigation = await screen.findByRole("button", {
      name: /Activity/,
    });
    await waitFor(() =>
      expect(
        activityNavigation.querySelector(".main-nav__count"),
      ).toHaveTextContent("4"),
    );
    await user.click(activityNavigation);

    await user.click(screen.getByRole("button", { name: "Open Scan card E" }));
    expect(screen.getByTestId("scanner-test")).toHaveTextContent(
      "scanner-test:none:scan-39",
    );

    await user.click(screen.getByRole("button", { name: /Activity/ }));
    await user.click(
      screen.getByRole("button", { name: "Open Import session 39" }),
    );
    expect(screen.getByTestId("scanner-test")).toHaveTextContent(
      "scanner-test:none:import-39",
    );

    await user.click(screen.getByRole("button", { name: /Activity/ }));
    await user.click(screen.getByRole("button", { name: "Open Plan archive" }));
    expect(screen.getByTestId("backup-route-test")).toHaveTextContent(
      "backupPlanning:plan-39:target-39",
    );

    await user.click(screen.getByRole("button", { name: /Activity/ }));
    await user.click(
      screen.getByRole("button", { name: "Open Backup archive" }),
    );
    expect(screen.getByTestId("backup-route-test")).toHaveTextContent(
      "backup:backup-39:target-39",
    );
  });

  it("keeps partial results visible and does not resurrect a terminal operation", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const scan = {
      kind: "scan",
      id: "scan-partial",
      status: "running",
      updatedAtUnixMs: 10,
      label: "Partial scan",
      context: "H:\\",
      progress: {
        completedItems: 1,
        totalItems: 2,
        completedBytes: null,
        totalBytes: null,
      },
      error: null,
      attention: false,
      route: { kind: "scan", scanId: "scan-partial" },
    };
    listOperations.mockResolvedValue({
      operations: [scan],
      diagnostics: [
        {
          source: "backups",
          code: "backupStateUnavailable",
          message: "Backup registry is locked",
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);

    const activityNavigation = await screen.findByRole("button", {
      name: /Activity/,
    });
    await waitFor(() =>
      expect(
        activityNavigation.querySelector(".main-nav__count"),
      ).toHaveTextContent("1"),
    );
    await user.click(activityNavigation);
    expect(screen.getByText("Partial scan")).toBeInTheDocument();
    expect(screen.getByText(/Backup registry is locked/)).toBeInTheDocument();

    await act(async () => {
      await emitOperation({
        ...scan,
        status: "completed",
        updatedAtUnixMs: 11,
      });
    });
    await waitFor(() =>
      expect(
        activityNavigation.querySelector(".main-nav__count"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Partial scan")).not.toBeInTheDocument();

    await act(async () => {
      await emitOperation(scan);
    });
    expect(
      activityNavigation.querySelector(".main-nav__count"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Partial scan")).not.toBeInTheDocument();
  });

  it("rebuilds a healthy snapshot and replays only events received during that refresh", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const a = operationSummary("scan-a", 10);
    const staleB = operationSummary("scan-b", 10);
    const refresh = deferred<OperationsSnapshot>();
    const diagnostic = {
      source: "backups" as const,
      code: "backupStateUnavailable",
      message: "Backup registry is locked",
    };
    listOperations
      .mockResolvedValueOnce({
        operations: [a, staleB],
        diagnostics: [diagnostic],
      })
      .mockReturnValueOnce(refresh.promise);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    expect(await screen.findByText("scan-b")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Refresh operations" }),
    );
    await waitFor(() => expect(listOperations).toHaveBeenCalledTimes(2));

    const eventA = operationSummary("scan-a", 12);
    await act(async () => {
      await emitOperation(eventA);
      refresh.resolve({
        operations: [operationSummary("scan-a", 11)],
        diagnostics: [diagnostic],
      });
      await refresh.promise;
    });

    await waitFor(() => expect(screen.queryByText("scan-b")).toBeNull());
    expect(screen.getByText("scan-a")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("keeps a terminal tombstone during refresh and ignores overlapping older responses", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const diagnostic = {
      source: "backups" as const,
      code: "backupStateUnavailable",
      message: "Backup registry is locked",
    };
    const olderRefresh = deferred<OperationsSnapshot>();
    const newerRefresh = deferred<OperationsSnapshot>();
    const runningB = operationSummary("scan-b", 20);
    listOperations
      .mockResolvedValueOnce({
        operations: [runningB],
        diagnostics: [diagnostic],
      })
      .mockReturnValueOnce(olderRefresh.promise)
      .mockReturnValueOnce(newerRefresh.promise);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Activity/ }));
    expect(await screen.findByText("scan-b")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Refresh operations" });
    await user.click(retry);
    await user.click(retry);
    await waitFor(() => expect(listOperations).toHaveBeenCalledTimes(3));

    const terminalB = operationSummary("scan-b", 22, {
      status: "completed",
    });
    await act(async () => {
      await emitOperation(terminalB);
      newerRefresh.resolve({
        operations: [operationSummary("scan-c", 30)],
        diagnostics: [diagnostic],
      });
      await newerRefresh.promise;
    });
    await waitFor(() => expect(screen.queryByText("scan-b")).toBeNull());
    expect(screen.getByText("scan-c")).toBeInTheDocument();

    await act(async () => {
      olderRefresh.resolve({
        operations: [operationSummary("scan-old", 25), runningB],
        diagnostics: [diagnostic],
      });
      await olderRefresh.promise;
      await emitOperation(operationSummary("scan-b", 21));
    });
    expect(screen.queryByText("scan-old")).not.toBeInTheDocument();
    expect(screen.queryByText("scan-b")).not.toBeInTheDocument();
    expect(screen.getByText("scan-c")).toBeInTheDocument();
  });

  it("marks Plans navigation and opens the exact workflow from an alarm", async () => {
    getSystemStatus.mockResolvedValue({
      productName: "Photo Importer",
      appVersion: "0.1.0",
      operatingSystem: "windows",
      architecture: "x86_64",
      backendStatus: "ready",
      importEngineStatus: "ready",
      importEngineLastError: null,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "raise-attention-test" }),
    );
    expect(screen.getByTitle("Needs attention")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "open-attention-workflow-test" }),
    );
    expect(screen.getByTestId("scanner-test")).toHaveTextContent(
      "scanner-test:marker:card-29",
    );
  });
});
