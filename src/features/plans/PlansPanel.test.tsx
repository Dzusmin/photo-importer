import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../shared/settings";
import type { PendingSourceWorkflow } from "../../shared/sources";
import { settingsResponseFixture } from "../../test/fixtures";
import { PlansPanel } from "./PlansPanel";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

function workflow(
  state: PendingSourceWorkflow["state"] = "disconnected",
): PendingSourceWorkflow {
  return {
    sourceId: "marker:card-1",
    sourceRoot: "E:\\",
    sourceIdentity: {
      markerUuid: "card-1",
      platformVolumeId: null,
      fallbackFingerprint: "legacy-drive-fingerprint",
    },
    displayName: "Card 1",
    state,
    scan: null,
    plan: null,
    settingsSchemaVersion: 4,
    settingsRevision: "",
    editor: {
      eventNames: {},
      excludedItemKeys: [],
      itemProfileAssignments: {},
    },
    error: state === "failedRecoverable" ? "Destination conflict" : null,
    updatedAtUnixMs: 1,
  };
}

function workflowWithCameraProfile(
  state: PendingSourceWorkflow["state"] = "planReady",
): PendingSourceWorkflow {
  const result = workflow(state);
  result.scan = {
    scan: {
      root: "E:\\",
      items: [
        {
          key: "photo-1",
          originalCapturedAtUnixMs: 1,
          capturedAtUnixMs: 1,
          timeSource: "exif",
          timeCorrectionSeconds: 0,
          totalSizeBytes: 10,
          files: [],
          hasRawJpegPair: false,
          hasSidecar: false,
          cameraIdentity: {
            make: "Fujifilm",
            model: "X-T5",
            serialNumber: "123",
          },
          cameraMetadataConflict: false,
        },
      ],
      supportedFileCount: 1,
      skippedFileCount: 0,
      totalSizeBytes: 10,
      warnings: [],
      timings: { discoveryMs: 0, metadataMs: 0 },
    },
    events: [],
    timestampBasis: "embeddedWithFileFallback",
    eventGapMinutes: 120,
    importMatches: [],
  };
  return result;
}

function settingsWithCameraProfile(): AppSettings {
  const settings = settingsResponseFixture().settings;
  settings.portable.cameraProfiles = [
    {
      id: "camera-1",
      name: "Main camera",
      exifMatchers: [{ make: "Fujifilm", model: "X-T5", serialNumber: "123" }],
      defaultTimeOffsetSeconds: 0,
    },
  ];
  return settings;
}

describe("PlansPanel", () => {
  it("shows workflows ignored until disconnect in a visible group", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_pending_source_workflows")
        return [workflow("ignoredUntilDisconnect")];
    });

    render(<PlansPanel onOpen={() => undefined} />);

    expect(
      await screen.findByRole("heading", { name: "Ignored 1" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ignored until disconnected")).toBeInTheDocument();
    expect(screen.queryByText("No saved plans")).not.toBeInTheDocument();
  });

  it("deletes all disconnected plans only after confirmation", async () => {
    const deleted = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_pending_source_workflows")
        return deleted.mock.calls.length === 0 ? [workflow()] : [];
      if (command === "delete_disconnected_source_workflows") {
        deleted();
        return 1;
      }
    });
    const user = userEvent.setup();
    render(<PlansPanel onOpen={() => undefined} />);

    await user.click(
      await screen.findByRole("button", { name: "Delete all disconnected" }),
    );

    await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(await screen.findByText("No saved plans")).toBeInTheDocument();
  });

  it("keeps a plan visible and lets the user retry when deletion fails", async () => {
    let attempts = 0;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_pending_source_workflows")
        return attempts < 2 ? [workflow("planReady")] : [];
      if (command === "delete_pending_source_workflow") {
        attempts += 1;
        if (attempts === 1) {
          throw {
            code: "workflowDeleteFailed",
            message: "database is locked",
          };
        }
      }
    });
    const user = userEvent.setup();
    render(<PlansPanel onOpen={() => undefined} />);

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(
        /plan could not be deleted and remains on the list/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Card 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(attempts).toBe(2));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(await screen.findByText("No saved plans")).toBeInTheDocument();
  });

  it("keeps disconnected plans visible and lets the user retry bulk deletion", async () => {
    let attempts = 0;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_pending_source_workflows")
        return attempts < 2 ? [workflow()] : [];
      if (command === "delete_disconnected_source_workflows") {
        attempts += 1;
        if (attempts === 1) {
          throw {
            code: "workflowDeleteFailed",
            message: "database is locked",
          };
        }
        return 1;
      }
    });
    const user = userEvent.setup();
    render(<PlansPanel onOpen={() => undefined} />);

    await user.click(
      await screen.findByRole("button", { name: "Delete all disconnected" }),
    );

    expect(
      await screen.findByText(
        /disconnected plans could not be deleted and remain on the list/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Card 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(attempts).toBe(2));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(await screen.findByText("No saved plans")).toBeInTheDocument();
  });

  it("enables automatic copying for an identified card and persists it", async () => {
    const saved = vi.fn();
    const initialSettings = settingsWithCameraProfile();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command, args) => {
      if (command === "load_settings")
        return { ...settingsResponseFixture(), settings: initialSettings };
      if (command === "list_pending_source_workflows")
        return [workflowWithCameraProfile()];
      if (command === "save_settings") {
        const settings = (args as { settings: AppSettings }).settings;
        saved(settings);
        return { ...settingsResponseFixture(), settings };
      }
    });
    const user = userEvent.setup();
    render(<PlansPanel onOpen={() => undefined} />);

    await user.selectOptions(
      await screen.findByLabelText("Automation for Card 1"),
      "autoImport",
    );

    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0].local.sourceBindings[0]).toMatchObject({
      displayName: "Card 1",
      behavior: "autoImport",
      sourceIdentity: { markerUuid: "card-1" },
      cameraProfileIds: ["camera-1"],
    });
    expect(
      await screen.findByText("Automatic copying is enabled for this card."),
    ).toBeInTheDocument();
  });

  it("requires a camera profile before creating an automation binding", async () => {
    const saved = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_pending_source_workflows")
        return [workflowWithCameraProfile()];
      if (command === "save_settings") saved();
    });
    const user = userEvent.setup();
    render(<PlansPanel onOpen={() => undefined} />);

    await user.selectOptions(
      await screen.findByLabelText("Automation for Card 1"),
      "autoPreparePlan",
    );

    expect(saved).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "Choose a camera profile in Details before enabling automation for this card.",
      ),
    ).toBeInTheDocument();
  });

  it("marks a saved plan for recalculation after the library changes", async () => {
    const savedPlan = workflowWithCameraProfile();
    savedPlan.settingsRevision = "revision-for-the-old-library";
    savedPlan.plan = {
      status: "ready",
      libraryRoot: "C:\\Old library",
      events: [],
      fileCount: 1,
      itemCount: 1,
      totalSizeBytes: 10,
      excludedItemCount: 0,
      excludedFileCount: 0,
      conflicts: [],
    };
    const settings = settingsWithCameraProfile();
    settings.local.libraryPath = "D:\\New library";
    mockIPC((command) => {
      if (command === "load_settings") {
        return { ...settingsResponseFixture(), settings };
      }
      if (command === "list_pending_source_workflows") return [savedPlan];
    });

    render(<PlansPanel onOpen={() => undefined} />);

    expect(
      await screen.findByText("Recalculation required"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/library or other plan settings changed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Copy automatically" }),
    ).toBeDisabled();
  });
});
