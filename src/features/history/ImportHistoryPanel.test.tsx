import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importSessionFixture } from "../../test/fixtures";
import type { ImportEventSummary } from "../../shared/sources";
import { ImportHistoryPanel } from "./ImportHistoryPanel";

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
  await act(async () => {
    for (const handler of eventBus.get(name) ?? []) {
      handler({ event: name, payload });
    }
  });
}

describe("ImportHistoryPanel", () => {
  beforeEach(() => {
    eventBus.clear();
  });

  it("refreshes history when an import reaches a terminal status", async () => {
    const importedEvent: ImportEventSummary = {
      eventId: "event-1",
      sessionId: "session-1",
      name: "Summer trip",
      folderPath: "C:\\Library\\2026\\Summer trip",
      fileCount: 3,
      importedAtUnixMs: 1_789_344_000_000,
    };
    let history: ImportEventSummary[] = [];
    const listCalls = vi.fn();
    mockIPC((command) => {
      if (command === "list_import_events") {
        listCalls();
        return { events: history, needsAttention: [] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<ImportHistoryPanel />);

    await waitFor(() => expect(listCalls).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText("No imported events with tracking metadata."),
    ).toBeInTheDocument();

    history = [importedEvent];
    await emit("import-progress", importSessionFixture({ status: "running" }));
    expect(listCalls).toHaveBeenCalledTimes(1);

    await emit(
      "import-progress",
      importSessionFixture({ status: "completed" }),
    );

    await waitFor(() => expect(listCalls).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Summer trip")).toBeInTheDocument();
  });

  it("requests latest-import sorting by default and lets the user choose event-name sorting", async () => {
    const user = userEvent.setup();
    const requestedSorts: unknown[] = [];
    mockIPC((command, args) => {
      if (command === "list_import_events") {
        requestedSorts.push((args as { sort: unknown } | undefined)?.sort);
        return { events: [], needsAttention: [] };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<ImportHistoryPanel />);

    await waitFor(() => expect(requestedSorts).toEqual(["latestImport"]));
    await user.selectOptions(screen.getByLabelText("Sort by"), "eventName");
    await waitFor(() =>
      expect(requestedSorts).toEqual(["latestImport", "eventName"]),
    );
  });

  it("shows event folders with broken markers in a separate attention list", async () => {
    mockIPC((command) => {
      if (command === "list_import_events") {
        return {
          events: [],
          needsAttention: [
            {
              folderPath: "C:\\Library\\2026\\Broken event",
              reason: "expected value at line 1 column 1",
            },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<ImportHistoryPanel />);

    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
    expect(
      screen.getByText("C:\\Library\\2026\\Broken event"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("expected value at line 1 column 1"),
    ).toBeInTheDocument();
  });
});
