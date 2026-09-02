import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelBackupJob,
  getBackupJob,
  listBackupJobs,
  listBackupTargets,
  normalizeBackupError,
  pauseBackupJob,
  prepareBackupPlan,
  recognizeBackupTarget,
  registerBackupTarget,
  removeBackupTarget,
  resumeBackupJob,
  startBackupJob,
} from "./backups";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("backup commands", () => {
  beforeEach(() => invoke.mockReset());

  it("exposes target registration, listing and recognition", async () => {
    const target = { id: "target-id", label: "Archiwum" };
    invoke.mockResolvedValue(target);

    await expect(registerBackupTarget("E:\\", "Archiwum")).resolves.toBe(
      target,
    );
    expect(invoke).toHaveBeenLastCalledWith("register_backup_target", {
      path: "E:\\",
      label: "Archiwum",
    });

    await listBackupTargets();
    expect(invoke).toHaveBeenLastCalledWith("list_backup_targets");

    await recognizeBackupTarget("F:\\");
    expect(invoke).toHaveBeenLastCalledWith("recognize_backup_target", {
      path: "F:\\",
    });
  });

  it("exposes configuration removal and plan preparation", async () => {
    invoke.mockResolvedValue(undefined);

    await removeBackupTarget("target-id");
    expect(invoke).toHaveBeenLastCalledWith("remove_backup_target", {
      targetId: "target-id",
    });

    await prepareBackupPlan("target-id", "E:\\", "C:\\Photos");
    expect(invoke).toHaveBeenLastCalledWith("prepare_backup_plan", {
      targetId: "target-id",
      targetPath: "E:\\",
      sourcePath: "C:\\Photos",
    });
  });

  it("normalizes structured and unknown errors", () => {
    expect(
      normalizeBackupError({ code: "wrong", message: "Zły dysk" }),
    ).toEqual({ code: "wrong", message: "Zły dysk" });
    expect(normalizeBackupError("Awaria")).toEqual({
      code: "unknown",
      message: "Awaria",
    });
    expect(normalizeBackupError(null).message).toContain("nieznany błąd");
    expect(
      normalizeBackupError({ code: "backupIoFailed", message: "os error 112" })
        .message,
    ).toContain("dysk jest podłączony");
  });

  it("starts, restores and controls background backup jobs", async () => {
    invoke.mockResolvedValue({ id: "job-id" });

    const plan = {
      targetId: "target-id",
      sourceRoot: "C:\\Photos",
      operations: [],
      unchangedFileCount: 0,
      totalCopyBytes: 0,
    };
    await startBackupJob(plan, "E:\\");
    expect(invoke).toHaveBeenLastCalledWith("start_backup_job", {
      plan,
      targetPath: "E:\\",
    });
    await listBackupJobs();
    expect(invoke).toHaveBeenLastCalledWith("list_backup_jobs");
    await getBackupJob("job-id");
    expect(invoke).toHaveBeenLastCalledWith("get_backup_job", {
      jobId: "job-id",
    });
    await pauseBackupJob("job-id");
    expect(invoke).toHaveBeenLastCalledWith("pause_backup_job", {
      jobId: "job-id",
    });
    await resumeBackupJob("job-id");
    expect(invoke).toHaveBeenLastCalledWith("resume_backup_job", {
      jobId: "job-id",
    });
    await cancelBackupJob("job-id");
    expect(invoke).toHaveBeenLastCalledWith("cancel_backup_job", {
      jobId: "job-id",
    });
  });
});
