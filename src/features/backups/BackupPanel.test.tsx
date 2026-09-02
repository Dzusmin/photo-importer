import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupJob, BackupPlan, BackupTarget } from "../../shared/backups";
import type { SourceVolume } from "../../shared/sources";
import { settingsResponseFixture } from "../../test/fixtures";
import { BackupPanel } from "./BackupPanel";

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

function settings() {
  const response = settingsResponseFixture();
  response.settings.local.libraryPath = "C:\\Library";
  return response;
}

describe("BackupPanel", () => {
  beforeEach(() => {
    eventBus.clear();
    openDialog.mockReset();
  });

  it("requires plan approval, then exposes progress controls and a final report", async () => {
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "list_backup_targets") return [target];
      if (command === "list_backup_jobs") return [];
      if (command === "load_settings") return settings();
      if (command === "list_media_sources") return [volume];
      if (command === "recognize_backup_target") return target;
      if (command === "prepare_backup_plan") return plan;
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
      if (command === "load_settings") return settings();
      if (command === "list_media_sources")
        return [{ ...volume, availableBytes: 100 }];
      if (command === "recognize_backup_target") return target;
      if (command === "prepare_backup_plan") return plan;
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

  it("registers a new target using the system directory picker", async () => {
    openDialog.mockResolvedValue("F:\\");
    mockIPC((command) => {
      if (command === "list_backup_targets") return [];
      if (command === "list_backup_jobs") return [];
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
});
