import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackupJob,
  BackupPlanningJob,
  BackupPlan,
  BackupRun,
  BackupSnapshot,
  BackupTarget,
} from "../../shared/backups";
import type { SourceVolume } from "../../shared/sources";
import { settingsResponseFixture } from "../../test/fixtures";
import { BackupPanel } from "./BackupPanel";
import { setAppLanguage } from "../../i18n";

const { openDialog } = vi.hoisted(() => ({ openDialog: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

const eventBus = vi.hoisted(
  () => new Map<string, Set<(event: unknown) => void>>(),
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: unknown) => void) => {
    const handlers = eventBus.get(name) ?? new Set();
    handlers.add(handler);
    eventBus.set(name, handlers);
    return () => handlers.delete(handler);
  }),
}));

async function emit(job: BackupJob) {
  for (const handler of eventBus.get("backup-progress") ?? []) {
    handler({ event: "backup-progress", payload: job });
  }
}

async function emitPlanning(job: BackupPlanningJob) {
  for (const handler of eventBus.get("backup-planning-progress") ?? []) {
    handler({ event: "backup-planning-progress", payload: job });
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

const target: BackupTarget = {
  id: "target-id",
  label: "Archiwum",
  lastKnownRoot: "E:\\",
  createdAtUnixMs: 1,
  lastSeenAtUnixMs: 1,
};

const volume: SourceVolume = {
  fingerprint: "disk",
  markerUuid: null,
  platformVolumeId: "disk-id",
  name: "BACKUP",
  mountPath: "E:\\",
  fileSystem: "NTFS",
  totalBytes: 10_000,
  availableBytes: 8_000,
  removable: true,
  readOnly: false,
  containsDcim: false,
  likelyCameraSource: false,
};

const plan: BackupPlan = {
  targetId: target.id,
  sourceRoot: "C:\\Library",
  operations: [
    {
      relativePath: "new.jpg",
      sourcePath: "C:\\Library\\new.jpg",
      destinationPath: "E:\\Photo Backup\\Photos\\new.jpg",
      kind: "new",
      sizeBytes: 100,
      sourceSha256: "a".repeat(64),
      previousSha256: null,
    },
    {
      relativePath: "changed.jpg",
      sourcePath: "C:\\Library\\changed.jpg",
      destinationPath: "E:\\Photo Backup\\Photos\\changed.jpg",
      kind: "changed",
      sizeBytes: 200,
      sourceSha256: "b".repeat(64),
      previousSha256: "c".repeat(64),
    },
    {
      relativePath: "repair.jpg",
      sourcePath: "C:\\Library\\repair.jpg",
      destinationPath: "E:\\Photo Backup\\Photos\\repair.jpg",
      kind: "repair",
      sizeBytes: 300,
      sourceSha256: "d".repeat(64),
      previousSha256: "d".repeat(64),
    },
  ],
  unchangedFileCount: 4,
  totalCopyBytes: 600,
};

function job(patch: Partial<BackupJob> = {}): BackupJob {
  return {
    id: "job-12345678",
    targetId: target.id,
    sourcePath: "C:\\Library",
    targetPath: "E:\\",
    status: "running",
    phase: "scanningLibrary",
    processedFileCount: 2,
    totalFileCount: null,
    processedBytes: 2048,
    totalBytes: null,
    currentPath: "C:\\Library\\a.jpg",
    pauseRequested: false,
    startedAtUnixMs: 1,
    updatedAtUnixMs: 1,
    error: null,
    report: null,
    ...patch,
  };
}

function planningJob(
  patch: Partial<BackupPlanningJob> = {},
): BackupPlanningJob {
  return {
    id: "planning-12345678",
    targetId: target.id,
    sourcePath: "C:\\Library",
    targetPath: "E:\\",
    status: "completed",
    phase: "hashing",
    processedFileCount: 7,
    totalFileCount: 7,
    processedBytes: 600,
    totalBytes: 600,
    currentPath: null,
    cancelRequested: false,
    startedAtUnixMs: 1,
    updatedAtUnixMs: 2,
    error: null,
    plan,
    ...patch,
  };
}

function settings() {
  const response = settingsResponseFixture();
  response.settings.local.libraryPath = "C:\\Library";
  return response;
}

const successfulRun: BackupRun = {
  id: "run-1",
  targetId: target.id,
  sourceRoot: "C:\\Library",
  startedAtUnixMs: 1_788_000_000_000,
  finishedAtUnixMs: 1_788_000_060_000,
  outcome: "succeeded",
  copiedFileCount: 2,
  unchangedFileCount: 4,
  versionedFileCount: 1,
  copiedBytes: 600,
  error: null,
};

const snapshot: BackupSnapshot = {
  targetId: target.id,
  sourceRoot: "C:\\Library",
  backupDirectory: "E:\\Photo Backup",
  scannedAtUnixMs: 1_788_000_070_000,
  lastSuccessfulRun: successfulRun,
  files: [
    {
      relativePath: "current.jpg",
      status: "current",
      sizeBytes: 100,
      sourceSha256: "a".repeat(64),
      backupSha256: "a".repeat(64),
      expectedSha256: "a".repeat(64),
      backedUpAtUnixMs: successfulRun.finishedAtUnixMs,
      orphaned: false,
      versions: [],
    },
    {
      relativePath: "old.jpg",
      status: "deletedFromLibrary",
      sizeBytes: 200,
      sourceSha256: null,
      backupSha256: "b".repeat(64),
      expectedSha256: "b".repeat(64),
      backedUpAtUnixMs: successfulRun.finishedAtUnixMs,
      orphaned: true,
      versions: [
        {
          id: 1,
          relativePath: "old.jpg",
          contentSha256: "c".repeat(64),
          versionPath: "E:\\Photo Backup\\.photo-importer\\versions\\old.jpg",
          archivedAtUnixMs: 1_787_000_000_000,
        },
      ],
    },
  ],
};

describe("BackupPanel", () => {
  beforeEach(async () => {
    eventBus.clear();
    openDialog.mockReset();
    await setAppLanguage("pl");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires plan approval, then exposes progress controls and a final report", async () => {
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "start_backup_planning_job") return planningJob();
      if (command === "start_backup_job") return job();
      if (command === "pause_backup_job") return job({ pauseRequested: true });
      if (command === "resume_backup_job") return job();
      if (command === "cancel_backup_job") return job();
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    await user.click(
      await screen.findByRole("button", { name: "Przygotuj plan backupu" }),
    );
    expect(
      await screen.findByLabelText("Podsumowanie planu backupu"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nowe pliki").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("Zmienione pliki").nextSibling).toHaveTextContent(
      "1",
    );
    expect(screen.getByText("Pliki do naprawy").nextSibling).toHaveTextContent(
      "1",
    );
    expect(
      screen.getByText("Niezmienione pliki").nextSibling,
    ).toHaveTextContent("4");
    expect(calls).not.toContain("start_backup_job");

    await user.click(
      screen.getByRole("button", { name: "Zatwierdź i rozpocznij backup" }),
    );
    await waitFor(() => expect(calls).toContain("start_backup_job"));
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow",
    );

    await emit(
      job({
        phase: "hashing",
        processedFileCount: 5,
        totalFileCount: 10,
        processedBytes: 500,
        totalBytes: 1000,
      }),
    );
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByText("5 / 10")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Pauza po bieżącym pliku" }),
    );
    await waitFor(() => expect(calls).toContain("pause_backup_job"));
    await emit(job({ status: "paused", phase: "copying" }));
    await user.click(await screen.findByRole("button", { name: "Wznów" }));
    await waitFor(() => expect(calls).toContain("resume_backup_job"));
    await user.click(screen.getByRole("button", { name: "Anuluj backup" }));
    await waitFor(() => expect(calls).toContain("cancel_backup_job"));

    await emit(
      job({
        status: "completed",
        phase: "finalizing",
        currentPath: null,
        report: {
          copiedFileCount: 3,
          unchangedFileCount: 4,
          versionedFileCount: 1,
          copiedBytes: 600,
        },
      }),
    );
    expect(
      await screen.findByText("Backup zakończony pomyślnie"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Raport końcowy")).toBeInTheDocument();
  });

  it("blocks approval and explains when the target has too little free space", async () => {
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources")
        return [{ ...volume, availableBytes: 100 }];
      if (command === "recognize_backup_target") return target;
      if (command === "start_backup_planning_job") return planningJob();
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    await user.click(
      await screen.findByRole("button", { name: "Przygotuj plan backupu" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Za mało miejsca",
    );
    expect(
      screen.getByRole("button", { name: "Zatwierdź i rozpocznij backup" }),
    ).toBeDisabled();
  });

  it("restores planning progress, becomes determinate while hashing and cancels", async () => {
    const calls: string[] = [];
    const scanning = planningJob({
      status: "running",
      phase: "scanningLibrary",
      processedFileCount: 2,
      totalFileCount: null,
      processedBytes: 300,
      totalBytes: null,
      currentPath: "C:\\Library\\a.jpg",
      plan: null,
    });
    mockIPC((command) => {
      calls.push(command);
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [scanning];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "cancel_backup_planning_job")
        return { ...scanning, cancelRequested: true };
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    const progress = await screen.findByRole("progressbar", {
      name: "Skanowanie biblioteki",
    });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText(/C:\\Library\\a.jpg/)).toBeInTheDocument();

    await emitPlanning(
      planningJob({
        status: "running",
        processedFileCount: 5,
        totalFileCount: 10,
        processedBytes: 500,
        totalBytes: 1000,
        currentPath: "C:\\Library\\b.jpg",
        plan: null,
      }),
    );
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByText("5 / 10")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Anuluj planowanie" }));
    await waitFor(() => expect(calls).toContain("cancel_backup_planning_job"));
    expect(
      await screen.findByText("Anulowanie planowania…"),
    ).toBeInTheDocument();
  });

  it("registers a new target using the system directory picker", async () => {
    openDialog.mockResolvedValue("F:\\");
    mockIPC((command) => {
      if (command === "list_backup_targets") return [];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [];
      if (command === "register_backup_target")
        return {
          ...target,
          id: "new-target",
          label: "Sejf",
          lastKnownRoot: "F:\\",
        };
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    await user.click(
      await screen.findByRole("button", { name: "Zarejestruj nowy dysk" }),
    );
    await user.type(screen.getByLabelText("Nazwa dysku"), "Sejf");
    await user.click(screen.getByRole("button", { name: "Wybierz…" }));
    await user.click(screen.getByRole("button", { name: "Zarejestruj dysk" }));
    expect(await screen.findByText("Sejf")).toBeInTheDocument();
  });

  it("restores an active job and warns when its target is disconnected", async () => {
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs")
        return [
          job({ phase: "verifying", totalBytes: 100, processedBytes: 75 }),
        ];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [];
    });
    render(<BackupPanel />);

    expect(await screen.findByText("Backup trwa w tle")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(
      screen.getByText(/Dysk backupu został odłączony/),
    ).toBeInTheDocument();
  });

  it("keeps interleaved backup progress scoped to the selected target", async () => {
    const secondTarget: BackupTarget = {
      ...target,
      id: "second-target",
      label: "Drugie archiwum",
      lastKnownRoot: "F:\\",
    };
    const secondVolume: SourceVolume = {
      ...volume,
      fingerprint: "second-disk",
      platformVolumeId: "second-disk-id",
      name: "BACKUP TWO",
      mountPath: "F:\\",
    };
    const selectedActive = job({
      id: "selected-active-job",
      status: "paused",
      processedBytes: 250,
      totalBytes: 1000,
      startedAtUnixMs: 10,
      updatedAtUnixMs: 20,
    });
    const selectedNewerTerminal = job({
      id: "selected-terminal-job",
      status: "completed",
      processedBytes: 1000,
      totalBytes: 1000,
      startedAtUnixMs: 100,
      updatedAtUnixMs: 100,
    });
    const selectedOlderActive = job({
      id: "selected-older-active-job",
      status: "running",
      processedBytes: 100,
      totalBytes: 1000,
      startedAtUnixMs: 5,
      updatedAtUnixMs: 15,
    });
    const otherActive = job({
      id: "other-active-job",
      targetId: secondTarget.id,
      targetPath: secondTarget.lastKnownRoot,
      processedBytes: 900,
      totalBytes: 1000,
      startedAtUnixMs: 200,
      updatedAtUnixMs: 200,
    });
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target, secondTarget];
      if (command === "list_backup_jobs")
        return [
          otherActive,
          selectedNewerTerminal,
          selectedOlderActive,
          selectedActive,
        ];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume, secondVolume];
      if (command === "recognize_backup_target") return null;
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    expect(
      await screen.findByText("Backup wstrzymany między plikami"),
    ).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.queryByText("90%")).not.toBeInTheDocument();

    await emit({
      ...otherActive,
      processedBytes: 950,
      updatedAtUnixMs: 210,
    });
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.queryByText("95%")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Drugie archiwum/ }));
    expect(await screen.findByText("95%")).toBeInTheDocument();
    expect(screen.queryByText("25%")).not.toBeInTheDocument();

    await emit({
      ...selectedActive,
      processedBytes: 500,
      updatedAtUnixMs: 30,
    });
    expect(screen.getByText("95%")).toBeInTheDocument();
    expect(screen.queryByText("50%")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Archiwum/ }));
    expect(await screen.findByText("50%")).toBeInTheDocument();
  });

  it("selects and focuses the exact backup operation routed from Activity", async () => {
    const routedTarget: BackupTarget = {
      ...target,
      id: "routed-target",
      label: "Routed archive",
      lastKnownRoot: "F:\\",
    };
    const routedVolume: SourceVolume = {
      ...volume,
      fingerprint: "routed-disk",
      platformVolumeId: "routed-disk-id",
      mountPath: "F:\\",
    };
    const routedPlanning = planningJob({
      id: "routed-planning",
      targetId: routedTarget.id,
      targetPath: routedTarget.lastKnownRoot,
      status: "running",
      plan: null,
    });
    const routedBackup = job({
      id: "routed-backup",
      targetId: routedTarget.id,
      targetPath: routedTarget.lastKnownRoot,
      status: "paused",
    });
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target, routedTarget];
      if (command === "list_backup_jobs") return [routedBackup];
      if (command === "list_backup_planning_jobs") return [routedPlanning];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume, routedVolume];
      if (command === "recognize_backup_target") return null;
    });

    const { rerender } = render(
      <BackupPanel
        openOperationRoute={{
          kind: "backupPlanning",
          jobId: routedPlanning.id,
          targetId: routedTarget.id,
        }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: /Routed archive/ }),
      ).toBeChecked(),
    );
    const planningPanel = document.getElementById(
      `operation-${encodeURIComponent(`backupPlanning:${routedPlanning.id}`)}`,
    );
    await waitFor(() => expect(planningPanel).toHaveClass("operation-focus"));
    expect(planningPanel).toHaveFocus();

    rerender(
      <BackupPanel
        openOperationRoute={{
          kind: "backup",
          jobId: routedBackup.id,
          targetId: routedTarget.id,
        }}
      />,
    );
    const backupPanel = document.getElementById(
      `operation-${encodeURIComponent(`backup:${routedBackup.id}`)}`,
    );
    await waitFor(() => expect(backupPanel).toHaveClass("operation-focus"));
    expect(backupPanel).toHaveFocus();
  });

  it("sends controls to the active job of the currently selected target", async () => {
    const secondTarget: BackupTarget = {
      ...target,
      id: "second-target",
      label: "Drugie archiwum",
      lastKnownRoot: "F:\\",
    };
    const secondVolume: SourceVolume = {
      ...volume,
      fingerprint: "second-disk",
      platformVolumeId: "second-disk-id",
      mountPath: "F:\\",
    };
    const firstJob = job({ id: "first-job", status: "paused" });
    const secondJob = job({
      id: "second-job",
      targetId: secondTarget.id,
      targetPath: secondTarget.lastKnownRoot,
    });
    const controlledIds: string[] = [];
    mockIPC((command, args) => {
      if (command === "list_backup_targets") return [target, secondTarget];
      if (command === "list_backup_jobs") return [secondJob, firstJob];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume, secondVolume];
      if (command === "recognize_backup_target") return null;
      if (command === "resume_backup_job") {
        controlledIds.push((args as { jobId: string }).jobId);
        return { ...firstJob, status: "running" };
      }
      if (command === "pause_backup_job") {
        controlledIds.push((args as { jobId: string }).jobId);
        return { ...secondJob, pauseRequested: true };
      }
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    await user.click(await screen.findByRole("button", { name: "Wznów" }));
    await waitFor(() => expect(controlledIds).toEqual(["first-job"]));

    await user.click(screen.getByRole("radio", { name: /Drugie archiwum/ }));
    await user.click(
      await screen.findByRole("button", {
        name: "Pauza po bieżącym pliku",
      }),
    );
    await waitFor(() =>
      expect(controlledIds).toEqual(["first-job", "second-job"]),
    );
  });

  it("shows persistent history, file states, orphan warning and previous versions", async () => {
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "inspect_backup") return snapshot;
      if (command === "list_backup_history") return [successfulRun];
      if (command === "open_backup_directory") return null;
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    expect(
      await screen.findByText(/Ostatni udany backup:/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Nadal pozostają w backupie",
    );
    expect(screen.getAllByText("Usunięty z biblioteki").length).toBeGreaterThan(
      0,
    );
    await user.click(screen.getByText("old.jpg"));
    expect(
      await screen.findByText(
        /zarchiwizowane kopie ochronne.*przywracanie planowane.*niedostępne w tej wersji/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/gotowe pod przyszłe przywracanie/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByText("Historia uruchomień"));
    expect(await screen.findByText("Udany")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Otwórz katalog kopii" }),
    );
    await waitFor(() => expect(calls).toContain("open_backup_directory"));
  });

  it("marks archived-version restore as planned and unavailable in both languages", async () => {
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "inspect_backup") return snapshot;
      if (command === "list_backup_history") return [];
    });

    const polish = render(<BackupPanel />);
    await userEvent.click(await screen.findByText("old.jpg"));
    expect(
      screen.getByText(
        /zarchiwizowane kopie ochronne.*przywracanie planowane.*niedostępne w tej wersji/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/gotowe pod przyszłe przywracanie/),
    ).not.toBeInTheDocument();
    polish.unmount();

    await setAppLanguage("en");
    render(<BackupPanel />);
    await userEvent.click(await screen.findByText("old.jpg"));
    expect(
      screen.getByText(
        /archived protection copies.*restore planned.*unavailable in this version/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/available for future restore/),
    ).not.toBeInTheDocument();
  });

  it("keeps the pre-run audit beside backup progress and refreshes it after completion", async () => {
    const refreshedRun: BackupRun = {
      ...successfulRun,
      id: "run-2",
      startedAtUnixMs: successfulRun.startedAtUnixMs + 120_000,
      finishedAtUnixMs: successfulRun.finishedAtUnixMs! + 120_000,
      copiedFileCount: 3,
    };
    const refreshedSnapshot: BackupSnapshot = {
      ...snapshot,
      scannedAtUnixMs: snapshot.scannedAtUnixMs + 120_000,
      lastSuccessfulRun: refreshedRun,
      files: [
        {
          ...snapshot.files[0],
          relativePath: "fresh-after-backup.jpg",
          backedUpAtUnixMs: refreshedRun.finishedAtUnixMs,
        },
      ],
    };
    const pendingSnapshot = deferred<BackupSnapshot | null>();
    const pendingHistory = deferred<BackupRun[]>();
    let inspectCalls = 0;
    let historyCalls = 0;
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "inspect_backup") {
        inspectCalls += 1;
        return inspectCalls === 1 ? snapshot : pendingSnapshot.promise;
      }
      if (command === "list_backup_history") {
        historyCalls += 1;
        return historyCalls === 1 ? [successfulRun] : pendingHistory.promise;
      }
      if (command === "start_backup_planning_job") return planningJob();
      if (command === "start_backup_job") return job();
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    expect(await screen.findByText("old.jpg")).toBeInTheDocument();
    await user.click(screen.getByText("Historia uruchomień"));
    expect(screen.getByText("Udany")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Przygotuj plan backupu" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Zatwierdź i rozpocznij backup",
      }),
    );

    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText("Dane sprzed uruchomienia")).toBeInTheDocument();
    expect(screen.getByText("old.jpg")).toBeInTheDocument();
    expect(screen.getByText("Udany")).toBeInTheDocument();

    await act(async () => {
      await emit(
        job({
          status: "completed",
          processedFileCount: 3,
          totalFileCount: 3,
          processedBytes: 600,
          totalBytes: 600,
          currentPath: null,
          updatedAtUnixMs: 3,
        }),
      );
    });
    await waitFor(() => {
      expect(inspectCalls).toBe(2);
      expect(historyCalls).toBe(2);
    });
    expect(screen.getByText("Dane sprzed uruchomienia")).toBeInTheDocument();
    expect(screen.getByText("old.jpg")).toBeInTheDocument();

    await act(async () => {
      pendingSnapshot.resolve(refreshedSnapshot);
      pendingHistory.resolve([refreshedRun, successfulRun]);
      await Promise.all([pendingSnapshot.promise, pendingHistory.promise]);
    });

    expect(
      await screen.findByText("fresh-after-backup.jpg"),
    ).toBeInTheDocument();
    expect(screen.queryByText("old.jpg")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Dane sprzed uruchomienia"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Historia uruchomień")).toHaveTextContent("2");
  });

  it("keeps the pre-run context marked as stale when the terminal refresh fails", async () => {
    let inspectCalls = 0;
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "inspect_backup") {
        inspectCalls += 1;
        if (inspectCalls === 1) return snapshot;
        return Promise.reject({
          code: "backupAuditFailed",
          message: "Nie udało się odświeżyć audytu.",
        });
      }
      if (command === "list_backup_history") return [successfulRun];
    });
    render(<BackupPanel />);

    expect(await screen.findByText("old.jpg")).toBeInTheDocument();
    await act(async () => {
      await emit(job({ updatedAtUnixMs: 2 }));
    });
    expect(await screen.findByText("Dane sprzed uruchomienia")).toBeVisible();

    await act(async () => {
      await emit(job({ status: "failed", updatedAtUnixMs: 3 }));
    });

    expect(
      await screen.findByText("Nie udało się zakończyć operacji backupu."),
    ).toBeInTheDocument();
    expect(screen.getByText("Dane sprzed uruchomienia")).toBeVisible();
    expect(screen.getByText("old.jpg")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByText("Historia uruchomień"));
    expect(screen.getByText("Udany")).toBeInTheDocument();
    expect(inspectCalls).toBe(2);
  });

  it("confirms configuration-only removal, removes the exact target, and selects the next target", async () => {
    const nextTarget: BackupTarget = {
      ...target,
      id: "next-target-id",
      label: "Drugie archiwum",
      lastKnownRoot: "F:\\",
    };
    const nextVolume: SourceVolume = {
      ...volume,
      fingerprint: "second-disk",
      platformVolumeId: "second-disk-id",
      mountPath: "F:\\",
    };
    const removedIds: string[] = [];
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command, args) => {
      if (command === "list_backup_targets") return [target, nextTarget];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume, nextVolume];
      if (command === "recognize_backup_target") {
        return (args as { path: string }).path === nextVolume.mountPath
          ? nextTarget
          : target;
      }
      if (command === "inspect_backup") return snapshot;
      if (command === "list_backup_history") return [];
      if (command === "remove_backup_target") {
        removedIds.push((args as { targetId: string }).targetId);
        return null;
      }
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    await user.click(await screen.findByRole("button", { name: "Usuń cel" }));

    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(
        /tylko rejestracja i konfiguracja celu.*Pliki backupu pozostaną na dysku/,
      ),
    );
    await waitFor(() => expect(removedIds).toEqual([target.id]));
    expect(
      screen.queryByRole("radio", { name: /^Archiwum/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Drugie archiwum/ }),
    ).toBeChecked();
  });

  it("keeps the target when removal is cancelled or fails", async () => {
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    let removeCalls = 0;
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "inspect_backup") return snapshot;
      if (command === "list_backup_history") return [];
      if (command === "remove_backup_target") {
        removeCalls += 1;
        return Promise.reject({
          code: "backupTargetBusy",
          message: "Cel ma aktywne zadanie.",
        });
      }
    });
    const user = userEvent.setup();
    render(<BackupPanel />);

    const remove = await screen.findByRole("button", { name: "Usuń cel" });
    await user.click(remove);
    expect(confirm).toHaveBeenCalledOnce();
    expect(removeCalls).toBe(0);
    expect(screen.getByRole("radio", { name: /Archiwum/ })).toBeChecked();

    await user.click(remove);
    expect(
      await screen.findByText(
        "Nie można usunąć tego celu, gdy trwa dla niego planowanie lub backup.",
      ),
    ).toBeInTheDocument();
    expect(removeCalls).toBe(1);
    expect(screen.getByRole("radio", { name: /Archiwum/ })).toBeChecked();
  });

  it("disables target removal while that target has an active backup job", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [job()];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
    });
    render(<BackupPanel />);

    expect(
      await screen.findByRole("button", { name: "Usuń cel" }),
    ).toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shares timer and focus refreshes, preserves the last result on failure, and retries", async () => {
    const pendingRefresh = deferred<SourceVolume[]>();
    const refreshedVolume = {
      ...volume,
      mountPath: "F:\\",
      availableBytes: 7_000,
    };
    const retriedVolume = {
      ...volume,
      mountPath: "G:\\",
      availableBytes: 6_000,
    };
    let intervalCallback: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout) => {
      if (timeout === 5_000 && typeof handler === "function") {
        intervalCallback = handler as () => void;
      }
      return 1;
    });
    let sourceCalls = 0;
    let recognitionCalls = 0;
    mockIPC((command, args) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") {
        sourceCalls += 1;
        if (sourceCalls === 1) return [volume];
        if (sourceCalls === 2) return pendingRefresh.promise;
        if (sourceCalls === 3) {
          return Promise.reject({ code: "scanFailed", message: "scan failed" });
        }
        return [retriedVolume];
      }
      if (command === "recognize_backup_target") {
        recognitionCalls += 1;
        return {
          ...target,
          lastKnownRoot: (args as { path: string }).path,
        };
      }
    });
    render(<BackupPanel />);

    expect(
      await screen.findByText(/Dyski ostatnio odświeżono pomyślnie:/),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Archiwum/ })).toBeChecked();
    expect(sourceCalls).toBe(1);
    expect(recognitionCalls).toBe(1);

    await act(async () => {
      intervalCallback?.();
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(sourceCalls).toBe(2);
    expect(recognitionCalls).toBe(1);

    await act(async () => {
      pendingRefresh.resolve([refreshedVolume]);
      await pendingRefresh.promise;
    });
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: /Archiwum/ }).closest("label"),
      ).toHaveTextContent("F:\\"),
    );
    expect(sourceCalls).toBe(2);
    expect(recognitionCalls).toBe(2);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      intervalCallback?.();
      await Promise.resolve();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pokazujemy wynik ostatniego udanego odświeżenia",
    );
    expect(
      screen.getByRole("radio", { name: /Archiwum/ }).closest("label"),
    ).toHaveTextContent("F:\\");
    expect(
      screen.getByText(/Dyski ostatnio odświeżono pomyślnie:/),
    ).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: /Archiwum/ }).closest("label"),
      ).toHaveTextContent("G:\\"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sourceCalls).toBe(4);
    expect(recognitionCalls).toBe(3);
  });

  it("does not publish an in-flight volume refresh after unmount", async () => {
    const pendingSources = deferred<SourceVolume[]>();
    mockIPC((command) => {
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "list_backup_planning_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return pendingSources.promise;
      if (command === "recognize_backup_target") return target;
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const view = render(<BackupPanel />);

    view.unmount();
    await act(async () => {
      pendingSources.resolve([volume]);
      await pendingSources.promise;
    });

    expect(consoleError).not.toHaveBeenCalled();
  });
});
