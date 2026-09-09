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

describe("PlansPanel", () => {
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

  it("enables automatic copying for an identified card and persists it", async () => {
    const saved = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockIPC((command, args) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "list_pending_source_workflows")
        return [workflow("planReady")];
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
    });
    expect(
      await screen.findByText("Automatic copying is enabled for this card."),
    ).toBeInTheDocument();
  });
});
