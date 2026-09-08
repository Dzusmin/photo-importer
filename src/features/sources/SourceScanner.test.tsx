import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
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

    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("liczba źródeł jest nieznana")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

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

  it("streams discovered photos into a live preview before completion", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_media_sources") return [sourceFixture()];
      if (
        command === "list_media_scans" ||
        command === "list_import_sessions" ||
        command === "list_pending_source_workflows"
      )
        return [];
      if (command === "start_media_scan") return scanJobFixture();
      if (command === "get_media_thumbnail") {
        return {
          key: "streamed-thumb",
          path: "C:\\Cache\\streamed.jpg",
          mimeType: "image/jpeg",
          width: 320,
          height: 200,
          cacheHit: false,
          timings: {
            lookupMs: 0,
            decodeMs: 1,
            resizeMs: 0,
            encodeAndPersistMs: 0,
            databaseMs: 0,
            totalMs: 1,
          },
        };
      }
    });
    const user = userEvent.setup();
    render(<SourceScanner />);
    await user.click(await screen.findByRole("button", { name: "Skanuj" }));

    await emit("scan-items", {
      scanId: "scan-1",
      path: "E:\\",
      items: [mediaItem()],
    });

    const preview = await screen.findByRole("region", {
      name: "Zdjęcia znalezione podczas skanowania",
    });
    expect(within(preview).getByText("IMG.JPG")).toBeInTheDocument();
    expect(screen.queryByText("Skanowanie zakończone")).not.toBeInTheDocument();
  });

  it("collapses scanned events, toggles them from the heading and persists the view", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const response = mediaResult();
    response.events[0].endsAtUnixMs += 60 * 60 * 1_000;
    mockIPC((command, args) => {
      calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_media_sources") return [sourceFixture()];
      if (
        command === "list_media_scans" ||
        command === "list_import_sessions" ||
        command === "list_pending_source_workflows"
      )
        return [];
      if (command === "start_media_scan") return scanJobFixture();
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

    const collapsedHeading = await screen.findByRole("button", {
      name: /Rozwiń wydarzenie wydarzenie-01/,
    });
    expect(collapsedHeading).toHaveAttribute("aria-expanded", "false");
    expect(
      within(collapsedHeading).getByText(/\d{2}:\d{2}–\d{2}:\d{2}/),
    ).toBeInTheDocument();
    expect(screen.queryByText("IMG.JPG")).not.toBeInTheDocument();

    collapsedHeading.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("button", { name: /Zwiń wydarzenie wydarzenie-01/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("IMG.JPG")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.command === "save_pending_source_workflow" &&
            JSON.stringify(call.args).includes('"expandedEventIndexes":[1]'),
        ),
      ).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Zwiń wszystkie" }));
    expect(screen.queryByText("IMG.JPG")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rozwiń wszystkie" }));
    expect(screen.getByText("IMG.JPG")).toBeInTheDocument();
  });

  it("generates the large preview from RAW only after it is clicked", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const response = mediaResult();
    response.scan.items[0].files[0] = {
      ...response.scan.items[0].files[0],
      path: "E:\\DCIM\\IMG.CR3",
      relativePath: "DCIM\\IMG.CR3",
      kind: "raw",
    };
    response.events[0].items = response.scan.items;
    mockIPC((command, args) => {
      calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_media_sources") return [sourceFixture()];
      if (
        command === "list_media_scans" ||
        command === "list_import_sessions" ||
        command === "list_pending_source_workflows"
      )
        return [];
      if (command === "start_media_scan") return scanJobFixture();
      if (command === "get_media_thumbnail") {
        return {
          key: `raw-${String((args as { maxDimension: number }).maxDimension)}`,
          path: "C:\\Cache\\raw-preview.jpg",
          mimeType: "image/jpeg",
          width: 320,
          height: 200,
          cacheHit: false,
          timings: {
            lookupMs: 0,
            decodeMs: 1,
            resizeMs: 0,
            encodeAndPersistMs: 0,
            databaseMs: 0,
            totalMs: 1,
          },
        };
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
    await user.click(
      await screen.findByRole("button", {
        name: /Rozwiń wydarzenie wydarzenie-01/,
      }),
    );
    await user.click(
      (await screen.findByText("IMG.CR3")).closest('[role="button"]')!,
    );

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.command === "get_media_thumbnail" &&
            call.args.path === "E:\\DCIM\\IMG.CR3" &&
            call.args.maxDimension === 1_600,
        ),
      ).toBe(true),
    );
    expect(
      calls.some((call) => call.command === "allow_original_jpeg_preview"),
    ).toBe(false);

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Podgląd zdjęcia" }),
    ).not.toBeInTheDocument();
  });

  it("restores ratings and rotation, then persists individual metadata changes", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const response = mediaResult();
    mockIPC((command, args) => {
      calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_media_sources") return [sourceFixture()];
      if (
        command === "list_media_scans" ||
        command === "list_import_sessions" ||
        command === "list_pending_source_workflows"
      )
        return [];
      if (command === "start_media_scan") return scanJobFixture();
      if (command === "list_photo_user_metadata") {
        return [
          {
            sourceRoot: "E:\\",
            itemKey: "img",
            rating: 4,
            rejected: false,
            rotationDegrees: 90,
            updatedAtUnixMs: 1,
          },
        ];
      }
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
    await user.click(
      await screen.findByRole("button", {
        name: /Rozwiń wydarzenie wydarzenie-01/,
      }),
    );

    expect(
      await screen.findByRole("combobox", { name: "Ocena zdjęcia" }),
    ).toHaveValue("4");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Ocena zdjęcia" }),
      "5",
    );
    await user.click(screen.getByRole("button", { name: "Odrzuć" }));
    await user.click(screen.getByText("IMG.JPG").closest('[role="button"]')!);
    await user.click(screen.getByRole("button", { name: "Obróć o 90°" }));

    await waitFor(() => {
      const saves = calls.filter(
        (call) => call.command === "save_photo_user_metadata",
      );
      expect(saves).toHaveLength(3);
      expect(JSON.stringify(saves[saves.length - 1]?.args)).toContain(
        '"rotationDegrees":180',
      );
    });
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
      if (command === "allow_original_jpeg_preview") {
        return (args as { path: string }).path;
      }
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
    expect(
      screen.queryByRole("navigation", { name: "Etapy importu" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Skanuj" }));
    await emit(
      "scan-progress",
      scanJobFixture({
        status: "completed",
        phase: "completed",
        result: response,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Przegląd").closest("li")).toHaveAttribute(
        "aria-current",
        "step",
      ),
    );

    await user.click(
      screen.getByRole("button", {
        name: /Rozwiń wydarzenie wydarzenie-01/,
      }),
    );
    await user.click(screen.getByText("IMG.JPG").closest('[role="button"]')!);
    expect(
      await screen.findByRole("dialog", { name: "Podgląd zdjęcia" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.command === "allow_original_jpeg_preview" &&
            call.args.path === "E:\\DCIM\\IMG.JPG",
        ),
      ).toBe(true),
    );
    expect(
      calls.some(
        (call) =>
          call.command === "get_media_thumbnail" &&
          call.args.maxDimension === 1_600,
      ),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Zamknij" }));

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
    await waitFor(() =>
      expect(screen.getByText("Plan").closest("li")).toHaveAttribute(
        "aria-current",
        "step",
      ),
    );
    expect(screen.getByText("Nowe pozycje")).toBeInTheDocument();
    expect(screen.getByText("Pominięte pozycje")).toBeInTheDocument();
    expect(screen.getByText("Konflikty")).toBeInTheDocument();
    expect(screen.getByText("Kopiowanie")).toBeInTheDocument();
    expect(screen.getByText(/Katalog docelowy/)).toBeInTheDocument();
    expect(await screen.findByText("event\\IMG.JPG")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rozpocznij import" }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.command === "start_import_session"),
      ).toBe(true),
    );
    await emit("import-progress", importSessionFixture({ status: "running" }));
    await waitFor(() =>
      expect(screen.getByText("Import").closest("li")).toHaveAttribute(
        "aria-current",
        "step",
      ),
    );
    await user.click(
      await screen.findByRole("button", { name: "Pauza po bieżącym zestawie" }),
    );
    expect(calls.some((call) => call.command === "pause_import_session")).toBe(
      true,
    );

    await emit(
      "import-progress",
      importSessionFixture({ status: "completed" }),
    );
    await user.click(await screen.findByRole("button", { name: "Usuń plan" }));
    await waitFor(() =>
      expect(screen.queryByText("event\\IMG.JPG")).not.toBeInTheDocument(),
    );
    expect(
      calls.filter((call) => call.command === "delete_pending_source_workflow"),
    ).toHaveLength(2);
    expect(
      screen.getByText("Plan importu został usunięty."),
    ).toBeInTheDocument();
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
    expect(
      screen.getByText(
        "Po weryfikacji całych zestawów pliki źródłowe zostaną usunięte.",
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: /Rozumiem, że po weryfikacji pliki źródłowe zostaną usunięte/,
      }),
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
        expandedEventIndexes: state === "planReady" ? [1] : [],
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
