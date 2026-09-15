import { describe, expect, it } from "vitest";
import {
  applyOperationsSnapshot,
  isActiveOperation,
  mergeOperationsSnapshot,
  mergeOperationUpdate,
  operationKey,
  type OperationSummary,
} from "./operations";

function operation(patch: Partial<OperationSummary> = {}): OperationSummary {
  return {
    kind: "scan",
    id: "scan-1",
    status: "running",
    updatedAtUnixMs: 10,
    label: "Scan E:\\",
    context: "E:\\",
    progress: {
      completedItems: 1,
      totalItems: 10,
      completedBytes: null,
      totalBytes: null,
    },
    error: null,
    attention: false,
    route: { kind: "scan", scanId: "scan-1" },
    ...patch,
  };
}

describe("operations projection", () => {
  it("deduplicates by kind and id and rejects older updates", () => {
    const current = {
      [operationKey(operation())]: operation({ updatedAtUnixMs: 20 }),
    };
    expect(
      mergeOperationUpdate(current, operation({ updatedAtUnixMs: 19 })),
    ).toBe(current);
  });

  it("retains a terminal high-water mark and an attention failure", () => {
    const running = operation();
    const current = { [operationKey(running)]: running };
    const completed = operation({ status: "completed", updatedAtUnixMs: 11 });
    const terminal = mergeOperationUpdate(current, completed);
    expect(terminal).toEqual({ [operationKey(completed)]: completed });
    expect(
      mergeOperationUpdate(
        terminal,
        operation({ status: "running", updatedAtUnixMs: 10 }),
      ),
    ).toBe(terminal);
    expect(
      mergeOperationUpdate(
        terminal,
        operation({ status: "running", updatedAtUnixMs: 11 }),
      ),
    ).toBe(terminal);

    const failed = operation({
      status: "attention",
      updatedAtUnixMs: 12,
      attention: true,
      error: "Drive disconnected",
    });
    expect(mergeOperationUpdate(current, failed)).toEqual({
      [operationKey(failed)]: failed,
    });
  });

  it("preserves a failed source while refreshing all healthy sources", () => {
    const oldScan = operation({ updatedAtUnixMs: 1 });
    const oldImport = operation({
      kind: "import",
      id: "import-1",
      route: { kind: "import", importSessionId: "import-1" },
    });
    const backup = operation({
      kind: "backup",
      id: "backup-1",
      route: { kind: "backup", jobId: "backup-1", targetId: "target-1" },
    });

    const merged = mergeOperationsSnapshot(
      {
        [operationKey(oldScan)]: oldScan,
        [operationKey(oldImport)]: oldImport,
      },
      {
        operations: [backup],
        diagnostics: [
          { source: "scans", code: "scanUnavailable", message: "Locked" },
        ],
      },
    );

    expect(Object.values(merged)).toEqual([oldScan, backup]);
  });

  it("replays only in-flight events over the snapshot and removes unrelated stale records", () => {
    const currentA = operation({ id: "scan-a", updatedAtUnixMs: 10 });
    const staleB = operation({ id: "scan-b", updatedAtUnixMs: 10 });
    const snapshotA = operation({ id: "scan-a", updatedAtUnixMs: 11 });
    const eventA = operation({ id: "scan-a", updatedAtUnixMs: 12 });

    expect(
      applyOperationsSnapshot(
        {
          [operationKey(currentA)]: currentA,
          [operationKey(staleB)]: staleB,
        },
        { operations: [snapshotA], diagnostics: [] },
        [eventA],
      ),
    ).toEqual({ [operationKey(eventA)]: eventA });
  });

  it("replays a terminal tombstone and rejects a stale active update", () => {
    const running = operation({ id: "scan-b", updatedAtUnixMs: 11 });
    const completed = operation({
      id: "scan-b",
      status: "completed",
      updatedAtUnixMs: 12,
    });
    const merged = applyOperationsSnapshot(
      { [operationKey(running)]: running },
      { operations: [running], diagnostics: [] },
      [completed],
    );

    expect(merged).toEqual({ [operationKey(completed)]: completed });
    expect(
      mergeOperationUpdate(
        merged,
        operation({ id: "scan-b", updatedAtUnixMs: 11 }),
      ),
    ).toBe(merged);
  });

  it("counts queued, running and paused states as active", () => {
    expect(isActiveOperation(operation({ status: "queued" }))).toBe(true);
    expect(isActiveOperation(operation({ status: "running" }))).toBe(true);
    expect(isActiveOperation(operation({ status: "paused" }))).toBe(true);
    expect(isActiveOperation(operation({ status: "attention" }))).toBe(false);
  });
});
