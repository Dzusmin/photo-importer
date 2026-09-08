import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelBackupJob,
  cancelBackupPlanningJob,
  getBackupJob,
  listBackupJobs,
  listBackupPlanningJobs,
  listBackupTargets,
  normalizeBackupError,
  pauseBackupJob,
  recognizeBackupTarget,
  registerBackupTarget,
  removeBackupTarget,
  resumeBackupJob,
  startBackupJob,
  startBackupPlanningJob,
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

  it("exposes configuration removal and planning jobs", async () => {
    invoke.mockResolvedValue(undefined);

    await removeBackupTarget("target-id");
    expect(invoke).toHaveBeenLastCalledWith("remove_backup_target", {
      targetId: "target-id",
    });

    await startBackupPlanningJob("target-id", "E:\\", "C:\\Photos");
    expect(invoke).toHaveBeenLastCalledWith("start_backup_planning_job", {
      targetId: "target-id",
      targetPath: "E:\\",
      sourcePath: "C:\\Photos",
    });
    await listBackupPlanningJobs();
    expect(invoke).toHaveBeenLastCalledWith("list_backup_planning_jobs");
    await cancelBackupPlanningJob("planning-id");
    expect(invoke).toHaveBeenLastCalledWith("cancel_backup_planning_job", {
      jobId: "planning-id",
    });
  });

  it("normalizes structured and unknown errors", () => {
    expect(
      normalizeBackupError({ code: "wrong", message: "Zły dysk" }),
    ).toEqual({
      code: "wrong",
      message: "The backup operation could not be completed.",
      technicalDetails: "Zły dysk",
    });
    expect(normalizeBackupError("Awaria")).toEqual({
      code: "unknown",
      message: "The backup operation could not be completed.",
      technicalDetails: "Awaria",
    });
    expect(normalizeBackupError(null).message).toContain(
      "could not be completed",
    );
    expect(
      normalizeBackupError({ code: "backupIoFailed", message: "os error 112" })
        .message,
    ).toContain("drive is connected");
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
