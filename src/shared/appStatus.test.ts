import { describe, expect, it } from "vitest";
import { describeOperationalError } from "./appStatus";
import { setAppLanguage } from "../i18n";

describe("describeOperationalError", () => {
  it.each([
    [{ code: "backendUnavailable", message: "IPC failed" }, "backend"],
    [new Error("Access denied"), "permission"],
    [{ code: "corruptedPrimary", message: "invalid JSON" }, "settings"],
    [new Error("disk disappeared"), "read"],
  ] as const)("classifies actionable failures", (error, kind) => {
    const result = describeOperationalError(error, "read");

    expect(result.kind).toBe(kind);
    expect(result.impact).not.toBe("");
    expect(result.action).not.toBe("");
    expect(result.technicalDetails).not.toBe("");
  });

  it("uses the active language for user-facing error text", async () => {
    await setAppLanguage("pl");

    const result = describeOperationalError(
      { code: "backendUnavailable", message: "IPC failed" },
      "backend",
    );

    expect(result.title).toBe("Brak połączenia z backendem");
  });
});
