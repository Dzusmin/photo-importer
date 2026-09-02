import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  importSessionFixture,
  scanJobFixture,
  scanResultFixture,
  settingsResponseFixture,
  sourceFixture,
} from "../../test/fixtures";
import type {
  ImportPlan,
  MediaItem,
  PendingSourceWorkflow,
  SourceScanResponse,
} from "../../shared/sources";
import type { AppSettings } from "../../shared/settings";
import { SourceScanner } from "./SourceScanner";

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

async function emit(name: string, payload: unknown) {
  for (const handler of eventBus.get(name) ?? []) {
    handler({ event: name, payload });
  }
}

describe("SourceScanner", () => {
  beforeEach(() => eventBus.clear());

  it("shows an unknown count after a read error and lets the user retry", async () => {
    let attempts = 0;
    const healthChanged = vi.fn();
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_media_sources") {
        attempts += 1;
        if (attempts === 1)
          throw new Error("Access denied to removable drives");
        return [];
      }
      if (
        command === "list_media_scans" ||
        command === "list_import_sessions" ||
        command === "list_pending_source_workflows"
      )
        return [];
    });
    const user = userEvent.setup();
    render(<SourceScanner onHealthChange={healthChanged} />);

    expect(await screen.findByText("Brak uprawnień")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("liczba źródeł jest nieznana")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Spróbuj ponownie" }));

    expect(
      await screen.findByText("Czekam na kartę pamięci."),
    ).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(healthChanged).toHaveBeenCalledWith(false);
    expect(healthChanged).toHaveBeenLastCalledWith(true);
  });

  it("discovers a card, reports scan progress, cancels and accepts completion", async () => {
    const cancelled = vi.fn();
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_media_sources") return [sourceFixture()];
      if (command === "list_media_scans" || command === "list_import_sessions")
        return [];
      if (command === "start_media_scan") return scanJobFixture();
      if (command === "cancel_media_scan") {
        cancelled();
        return scanJobFixture();
      }
    });
    const user = userEvent.setup();
    render(<SourceScanner />);

    expect(
      await screen.findByText("Wykryto nośnik aparatu."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skanuj" }));
    expect(
      await screen.findByText("Wyszukiwanie zdjęć i filmów"),
    ).toBeInTheDocument();
    await emit(
      "scan-progress",
      scanJobFixture({
        phase: "readingMetadata",
        discoveredFileCount: 20,
        processedFileCount: 5,
        totalSupportedFileCount: 10,
        currentPath: "E:\\DCIM\\IMG_5.JPG",
      }),
    );
    expect(await screen.findByText(/5 z 10/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Anuluj skanowanie" }));
    expect(cancelled).toHaveBeenCalledOnce();

    const result = scanResultFixture();
    await emit(
      "scan-progress",
      scanJobFixture({
        status: "completed",
        phase: "completed",
        result,
      }),
    );
    expect(
      await screen.findByText(/Nie znaleziono obsługiwanych/),
    ).toBeInTheDocument();
  });

  it("reattaches to a scan that was started by the background monitor", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (
        command === "list_media_sources" ||
        command === "list_import_sessions"
      )
        return [];
      if (command === "list_media_scans") {
        return [
          scanJobFixture({
            phase: "comparingHistory",
            processedFileCount: 10,
            totalSupportedFileCount: 10,
          }),
        ];
      }
    });

    render(<SourceScanner />);

    expect(
      await screen.findByText(/Skan uruchomiony przez automat/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Porównywanie z historią importu"),
    ).toBeInTheDocument();
  });

  it("allows correction, planning, starting and pausing an import", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const response = mediaResult();
    const plan = importPlan();
    const settings = settingsResponseFixture();
    settings.settings.local.libraryPath = "C:\\Library";
    mockIPC((command, args) => {
      calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
      if (command === "load_settings") return settings;
      if (command === "list_media_sources") return [sourceFixture()];
      if (command === "list_media_scans" || command === "list_import_sessions")
        return [];
      if (command === "start_media_scan") return scanJobFixture();
      if (command === "get_media_thumbnail") {
        return {
          key: "thumb",
          path: "C:\\Cache\\thumb.jpg",
          mimeType: "image/jpeg",
          width: 10,
          height: 10,
          cacheHit: false,
          timings: {
            lookupMs: 0,
            decodeMs: 1,
            resizeMs: 1,
            encodeAndPersistMs: 1,
            databaseMs: 0,
            totalMs: 3,
          },
        };
      }
      if (command === "correct_capture_times") {
        return {
          items: response.scan.items.map((item) => ({
            ...item,
            capturedAtUnixMs: item.capturedAtUnixMs + 3_600_000,
            timeCorrectionSeconds: 3600,
          })),
          events: response.events,
          changedItemCount: 1,
        };
      }
      if (command === "build_import_plan_preview") return plan;
      if (command === "create_import_session") return importSessionFixture();
      if (command === "start_import_session") {
        return importSessionFixture({ status: "running" });
      }
      if (command === "pause_import_session") {
        return importSessionFixture({
          status: "running",
          pauseRequested: true,
        });
      }
    });
    const user = userEvent.setup();
    render(<SourceScanner />);
    await user.click(await screen.findByRole("button", { name: "Skanuj" }));
    await emit(
      "scan-progress",
      scanJobFixture({
        status: "completed",
        phase: "completed",
        result: response,
      }),
    );

    const select = await screen.findByLabelText("Zaznacz do korekty czasu");
    await user.click(select);
    await user.clear(screen.getByLabelText("Wartość korekty czasu"));
    await user.type(screen.getByLabelText("Wartość korekty czasu"), "1");
    await user.selectOptions(
      screen.getByLabelText("Jednostka korekty czasu"),
      "hours",
    );
    await user.click(screen.getByRole("button", { name: "Zastosuj korektę" }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.command === "correct_capture_times"),
      ).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Przygotuj plan" }));
    expect(await screen.findByText("event\\IMG.JPG")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rozpocznij import" }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.command === "start_import_session"),
      ).toBe(true),
    );
    await emit("import-progress", importSessionFixture({ status: "running" }));
    await user.click(
      await screen.findByRole("button", { name: "Pauza po bieżącym zestawie" }),
    );
    expect(calls.some((call) => call.command === "pause_import_session")).toBe(
      true,
    );
  });

  it("requires profile confirmation and automatically prepares a plan for a new card", async () => {
    const response = mediaResult();
    response.scan.items[0].cameraIdentity = {
      make: "Fujifilm",
      model: "X-T5",
      serialNumber: "ABC123",
    };
    response.scan.items[0].files[0].cameraIdentity =
      response.scan.items[0].cameraIdentity;
    response.events[0].items[0] = response.scan.items[0];
    const settings = settingsResponseFixture();
    settings.settings.local.libraryPath = "C:\\Library";
    settings.settings.portable.import.defaultSourceBehavior = "autoPreparePlan";
    const planned = vi.fn();
    const saved = vi.fn();
    mockIPC((command, args) => {
      if (command === "load_settings") return settings;
      if (command === "list_media_sources") return [sourceFixture()];
      if (command === "list_media_scans" || command === "list_import_sessions")
        return [];
      if (command === "start_media_scan") return scanJobFixture();
      if (command === "ensure_media_source_marker") return "marker-id";
      if (command === "save_settings") {
        const next = (args as { settings: AppSettings }).settings;
        saved(next);
        return { ...settingsResponseFixture(), settings: next };
      }
      if (command === "build_import_plan_preview") {
        planned();
        return importPlan();
      }
      if (command === "announce_import_plan_ready") return undefined;
      if (command === "get_media_thumbnail") throw new Error("no preview");
    });
    const user = userEvent.setup();
    render(<SourceScanner />);

    await user.click(await screen.findByRole("button", { name: "Skanuj" }));
    await emit(
      "scan-progress",
      scanJobFixture({
        status: "completed",
        phase: "completed",
        result: response,
      }),
    );

    expect(
      await screen.findByText("Zatwierdź profile przed przygotowaniem planu"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Fujifilm X-T5")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Zatwierdź profile i zapamiętaj kartę",
      }),
    );

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    await waitFor(() => expect(planned).toHaveBeenCalledOnce());
    expect(saved.mock.calls[0][0].portable.cameraProfiles[0].name).toBe(
      "Fujifilm X-T5",
    );
    expect(
      saved.mock.calls[0][0].local.sourceBindings[0].cameraProfileIds,
    ).toHaveLength(1);
  });

  it("does not create a move session when destructive confirmation is rejected", async () => {
    const response = mediaResult();
    const settings = settingsResponseFixture();
    settings.settings.portable.import.defaultOperation =
      "moveAfterVerification";
    settings.settings.local.libraryPath = "C:\\Library";
    const created = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mockIPC((command) => {
      if (command === "load_settings") return settings;
      if (command === "list_media_sources") return [sourceFixture()];
      if (command === "list_media_scans" || command === "list_import_sessions")
        return [];
      if (command === "start_media_scan") return scanJobFixture();
      if (command === "get_media_thumbnail") throw new Error("no preview");
      if (command === "build_import_plan_preview") return importPlan();
      if (command === "create_import_session") created();
    });
    const user = userEvent.setup();
    render(<SourceScanner />);
    await user.click(await screen.findByRole("button", { name: "Skanuj" }));
    await emit(
      "scan-progress",
      scanJobFixture({
        status: "completed",
        phase: "completed",
        result: response,
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Przygotuj plan" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Rozpocznij import" }),
    );

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(created).not.toHaveBeenCalled();
  });

  it("restores every durable card state and its editable plan", async () => {
    const settings = settingsResponseFixture();
    settings.settings.local.libraryPath = "C:\\Library";
    const result = mediaResult();
    const states: PendingSourceWorkflow["state"][] = [
      "detected",
      "awaitingDecision",
      "scanning",
      "awaitingProfileConfirmation",
      "preparingPlan",
      "planReady",
      "importing",
      "failedRecoverable",
      "ignoredUntilDisconnect",
      "disconnected",
    ];
    const workflows = states.map((state, index): PendingSourceWorkflow => ({
      sourceId: `source-${index}`,
      sourceRoot: `${String.fromCharCode(69 + index)}:\\`,
      sourceIdentity: null,
      displayName: `Karta ${index + 1}`,
      state,
      scan: state === "planReady" ? result : null,
      plan: state === "planReady" ? importPlan() : null,
      settingsSchemaVersion: 2,
      settingsRevision: JSON.stringify(settings.settings.portable.naming),
      editor: {
        eventNames: state === "planReady" ? { 1: "Wakacje" } : {},
        excludedItemKeys: [],
        itemProfileAssignments: {},
      },
      error: state === "failedRecoverable" ? "Podłącz kartę ponownie" : null,
      updatedAtUnixMs: index,
    }));
    mockIPC((command) => {
      if (command === "load_settings") return settings;
      if (command === "list_pending_source_workflows") return workflows;
      if (
        command === "list_media_sources" ||
        command === "list_media_scans" ||
        command === "list_import_sessions"
      )
        return [];
      if (command === "get_media_thumbnail") throw new Error("no preview");
    });

    render(<SourceScanner />);

    for (const label of [
      "Wykryta",
      "Czeka na decyzję",
      "Skanowanie",
      "Potwierdź aparat",
      "Przygotowanie planu",
      "Plan gotowy",
      "Importowanie",
      "Można wznowić",
      "Pominięta do odłączenia",
      "Odłączona",
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(screen.getByDisplayValue("Wakacje")).toBeInTheDocument();
    expect(screen.getByText("event\\IMG.JPG")).toBeInTheDocument();

    await emit("notification-route", { sourcePath: "J:\\" });
    expect(
      await screen.findByText("Przywrócono plan oczekujący na zatwierdzenie."),
    ).toBeInTheDocument();
  });

  it("shows queued, recoverable and rollback session controls", async () => {
    const settings = settingsResponseFixture();
    const result = mediaResult();
    mockIPC((command) => {
      if (command === "load_settings") return settings;
      if (command === "list_media_sources" || command === "list_media_scans")
        return [];
      if (command === "list_pending_source_workflows")
        return [
          {
            sourceId: "source",
            sourceRoot: "E:\\",
            sourceIdentity: null,
            displayName: "Karta",
            state: "planReady",
            scan: result,
            plan: null,
            settingsSchemaVersion: 2,
            settingsRevision: JSON.stringify(settings.settings.portable.naming),
            editor: {
              eventNames: {},
              excludedItemKeys: [],
              itemProfileAssignments: {},
            },
            error: null,
            updatedAtUnixMs: 1,
          } satisfies PendingSourceWorkflow,
        ];
      if (command === "list_import_sessions") {
        return [importSessionFixture({ status: "queued" })];
      }
      if (command === "retry_import_rollback") {
        return importSessionFixture({ status: "cancelled" });
      }
    });
    const user = userEvent.setup();
    render(<SourceScanner />);

    expect(
      await screen.findByText("Import oczekuje w kolejce"),
    ).toBeInTheDocument();
    await emit(
      "import-progress",
      importSessionFixture({
        status: "failedRecoverable",
        lastError: "Karta odłączona",
      }),
    );
    expect(
      await screen.findByText("Karta jest niedostępna — podłącz ją i wznów"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wznów" })).toBeInTheDocument();

    await emit(
      "rollback-progress",
      importSessionFixture({ status: "rollbackFailed" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Ponów wycofanie" }),
    );
    expect(await screen.findByText("Import anulowany")).toBeInTheDocument();
  });
});

function mediaItem(): MediaItem {
  return {
    key: "img",
    originalCapturedAtUnixMs: 1_725_062_400_000,
    capturedAtUnixMs: 1_725_062_400_000,
    timeSource: "exif",
    timeCorrectionSeconds: 0,
    totalSizeBytes: 10,
    files: [
      {
        path: "E:\\DCIM\\IMG.JPG",
        relativePath: "DCIM\\IMG.JPG",
        kind: "jpeg",
        sizeBytes: 10,
        modifiedAtUnixMs: 1,
        embeddedCapturedAtUnixMs: 1_725_062_400_000,
        embeddedTimeSource: "exif",
        cameraIdentity: null,
      },
    ],
    hasRawJpegPair: false,
    hasSidecar: false,
    cameraIdentity: null,
    cameraMetadataConflict: false,
  };
}

function mediaResult(): SourceScanResponse {
  const item = mediaItem();
  return {
    scan: {
      root: "E:\\",
      items: [item],
      supportedFileCount: 1,
      skippedFileCount: 0,
      totalSizeBytes: 10,
      warnings: [],
      timings: { discoveryMs: 0, metadataMs: 0 },
    },
    events: [
      {
        index: 1,
        startsAtUnixMs: item.capturedAtUnixMs,
        endsAtUnixMs: item.capturedAtUnixMs,
        totalSizeBytes: 10,
        items: [item],
      },
    ],
    timestampBasis: "embeddedWithFileFallback",
    eventGapMinutes: 120,
    importMatches: [
      {
        itemKey: "img",
        state: "new",
        importedFileCount: 0,
        totalFileCount: 1,
        importedPaths: [],
        importedSourcePaths: [],
      },
    ],
  };
}

function importPlan(): ImportPlan {
  return {
    status: "ready",
    libraryRoot: "C:\\Library",
    events: [
      {
        eventIndex: 1,
        eventName: "wydarzenie-1",
        folderRelativePath: "event",
        startsAtUnixMs: 1,
        totalSizeBytes: 10,
        items: [
          {
            itemKey: "img",
            capturedAtUnixMs: 1,
            totalSizeBytes: 10,
            hasRawJpegPair: false,
            hasSidecar: false,
            cameraAlias: null,
            files: [
              {
                sourcePath: "E:\\DCIM\\IMG.JPG",
                sourceRelativePath: "DCIM\\IMG.JPG",
                destinationPath: "C:\\Library\\event\\IMG.JPG",
                destinationRelativePath: "event\\IMG.JPG",
                kind: "jpeg",
                sizeBytes: 10,
              },
            ],
          },
        ],
      },
    ],
    conflicts: [],
    itemCount: 1,
    fileCount: 1,
    totalSizeBytes: 10,
    excludedItemCount: 0,
    excludedFileCount: 0,
  };
}
