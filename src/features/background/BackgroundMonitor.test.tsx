import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundStatusFixture } from "../../test/fixtures";
import { BackgroundMonitor } from "./BackgroundMonitor";

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
  emit: vi.fn(async (name: string, payload: unknown) => {
    for (const handler of eventBus.get(name) ?? []) {
      handler({ event: name, payload });
    }
  }),
}));

async function emit(name: string, payload: unknown) {
  for (const handler of eventBus.get(name) ?? []) {
    handler({ event: name, payload });
  }
}

describe("BackgroundMonitor", () => {
  beforeEach(() => eventBus.clear());
  it("shows runtime state and reacts to backend events", async () => {
    mockIPC((command) => {
      if (command === "get_background_status") {
        return backgroundStatusFixture({ connectedKnownSourceCount: 1 });
      }
    });
    render(<BackgroundMonitor />);

    expect(await screen.findByText(/1 znanych nośników/)).toBeInTheDocument();
    await emit(
      "background-status",
      backgroundStatusFixture({
        activeAutoScanCount: 1,
        startAtLoginEnabled: true,
        lastError: "Błąd autostartu",
        events: [
          {
            id: 1,
            occurredAtUnixMs: 1_725_062_400_000,
            kind: "scanFailed",
            title: "Skan nieudany",
            detail: "Karta została odłączona",
            sourcePath: "E:\\",
            scanId: "scan-1",
          },
        ],
      }),
    );

    expect(await screen.findByText("Skanowanie 1 źródła")).toBeInTheDocument();
    expect(screen.getByText("Autostart: włączony")).toBeInTheDocument();
    expect(screen.getByText("Błąd autostartu")).toBeInTheDocument();
    expect(screen.getByText("Skan nieudany")).toBeInTheDocument();
  });

  it("requests an immediate refresh and temporarily disables the button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "get_background_status") return backgroundStatusFixture();
      if (command === "refresh_background_monitor") {
        return backgroundStatusFixture({ connectedKnownSourceCount: 2 });
      }
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<BackgroundMonitor />);
    const button = await screen.findByRole("button", { name: "Sprawdź teraz" });

    await user.click(button);

    expect(calls).toContain("refresh_background_monitor");
    expect(screen.getByText(/2 znanych nośników/)).toBeInTheDocument();
    expect(button).toBeDisabled();
    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("keeps an awaiting card visible until the user scans or ignores it", async () => {
    const acknowledged = vi.fn();
    mockIPC((command) => {
      if (command === "get_background_status") {
        return backgroundStatusFixture({
          pendingSources: [
            {
              fingerprint: "card",
              name: "Fujifilm X-T5",
              sourcePath: "E:\\",
              state: "awaitingDecision",
              probableMatch: false,
            },
          ],
        });
      }
      if (command === "acknowledge_pending_source") {
        acknowledged();
        return backgroundStatusFixture();
      }
    });
    const user = userEvent.setup();
    render(<BackgroundMonitor />);

    expect(
      await screen.findByText("Fujifilm X-T5 czeka na decyzję"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Skanuj i przygotuj plan" }),
    );
    expect(acknowledged).toHaveBeenCalledOnce();
  });
});
