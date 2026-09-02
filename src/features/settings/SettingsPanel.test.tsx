import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { settingsResponseFixture } from "../../test/fixtures";
import type { AppSettings } from "../../shared/settings";
import { SettingsPanel } from "./SettingsPanel";

describe("SettingsPanel", () => {
  it("loads, validates, saves and can discard local edits", async () => {
    const saved = vi.fn();
    mockIPC((command, args) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "save_settings") {
        const value = (args as Record<string, unknown>).settings as AppSettings;
        saved(value);
        return { ...settingsResponseFixture(), settings: value };
      }
    });
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await screen.findByText("Nowe wydarzenie po przerwie");
    const gap = screen.getAllByRole("spinbutton")[0];

    await user.clear(gap);
    await user.type(gap, "0");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Przerwa między wydarzeniami",
    );
    expect(
      screen.getByRole("button", { name: "Zapisz ustawienia" }),
    ).toBeDisabled();

    await user.clear(gap);
    await user.type(gap, "90");
    await user.click(screen.getByRole("button", { name: "Zapisz ustawienia" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(saved.mock.calls[0][0].portable.import.eventGapMinutes).toBe(90);

    await user.click(screen.getByLabelText("Uruchamiaj przy logowaniu"));
    expect(screen.getByText("Niezapisane zmiany")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Odrzuć zmiany" }));
    await waitFor(() =>
      expect(
        screen.getByLabelText("Uruchamiaj przy logowaniu"),
      ).not.toBeChecked(),
    );
  });

  it("adds profiles, validates their names and removes their bindings", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
    });
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await screen.findByText(
      "Brak profili. Możesz dodać pierwszy aparat ręcznie.",
    );

    await user.click(
      screen.getByRole("button", { name: /Dodaj profil aparatu/ }),
    );
    const name = screen.getByLabelText("Nazwa profilu");
    expect(name).toHaveValue("Aparat 1");
    await user.clear(name);
    expect(screen.getByRole("alert")).toHaveTextContent("musi mieć nazwę");
    await user.click(screen.getByRole("button", { name: "Usuń profil" }));
    expect(screen.getByText(/Brak profili/)).toBeInTheDocument();
  });

  it("configures background planning, restart behavior and concurrency", async () => {
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
    });
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(
      await screen.findByLabelText("Pokaż okno, gdy plan importu jest gotowy"),
    );
    await user.click(screen.getByLabelText("Powiadomienia systemowe"));
    await user.selectOptions(
      screen.getByDisplayValue("Zapytaj przed wznowieniem"),
      "automatic",
    );
    const concurrency = screen.getAllByRole("spinbutton")[1];
    await user.clear(concurrency);
    await user.type(concurrency, "3");

    expect(
      screen.getByLabelText("Pokaż okno, gdy plan importu jest gotowy"),
    ).toBeChecked();
    expect(screen.getByLabelText("Powiadomienia systemowe")).not.toBeChecked();
    expect(concurrency).toHaveValue(3);
  });

  it("offers backup recovery after a corrupted primary file", async () => {
    mockIPC((command) => {
      if (command === "load_settings") {
        throw {
          code: "corruptedPrimary",
          message: "Plik ustawień jest uszkodzony.",
          backupAvailable: true,
        };
      }
      if (command === "restore_settings_backup")
        return settingsResponseFixture();
    });
    const user = userEvent.setup();
    render(<SettingsPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent("uszkodzony");
    await user.click(screen.getByRole("button", { name: "Przywróć kopię" }));
    expect(
      await screen.findByText("Przywrócono poprzednią wersję ustawień."),
    ).toBeInTheDocument();
  });

  it("clears the thumbnail cache through IPC", async () => {
    const clear = vi.fn();
    mockIPC((command) => {
      if (command === "load_settings") return settingsResponseFixture();
      if (command === "clear_thumbnail_cache") clear();
    });
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(
      await screen.findByRole("button", { name: "Wyczyść cache miniaturek" }),
    );

    expect(clear).toHaveBeenCalledOnce();
    expect(
      await screen.findByText(/Cache miniaturek został wyczyszczony/),
    ).toBeInTheDocument();
  });
});
