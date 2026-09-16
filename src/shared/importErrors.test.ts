import { beforeEach, describe, expect, it } from "vitest";
import { setAppLanguage } from "../i18n";
import { normalizeImportOperationError } from "./importErrors";

describe("normalizeImportOperationError", () => {
  beforeEach(async () => setAppLanguage("en"));

  it.each([
    [
      { code: "sourceFileMissing", message: "DCIM/IMG.JPG" },
      "directory" as const,
      "source file or folder",
    ],
    [
      { code: "sourceUnavailable", message: "not connected" },
      "volume" as const,
      "original memory card",
    ],
    [
      { code: "wrongSource", message: "different card" },
      "volume" as const,
      "different memory card",
    ],
    [
      { code: "permissionDenied", message: "os error 5" },
      "directory" as const,
      "does not have permission",
    ],
  ])("maps %o to an actionable explanation", (error, kind, cause) => {
    const result = normalizeImportOperationError(error, kind);

    expect(result.cause).toContain(cause);
    expect(result.nextStep.length).toBeGreaterThan(10);
    expect(result.retrySafety).toContain("Retrying");
    expect(result.technicalDetails).toBe(error.message);
    expect(result.recoverable).toBe(true);
  });

  it("recognizes a persisted missing-file error", () => {
    const result = normalizeImportOperationError(
      "source file is unavailable: E:\\DCIM\\IMG.JPG",
      "volume",
    );

    expect(result.code).toBe("sourceFileMissing");
    expect(result.cause).toContain("memory card");
  });
});
