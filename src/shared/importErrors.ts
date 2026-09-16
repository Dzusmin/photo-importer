import { localize as l } from "../i18n";

export type ImportSourceKind = "directory" | "volume" | "unknown";

export interface ImportOperationError {
  code: string;
  cause: string;
  nextStep: string;
  retrySafety: string;
  technicalDetails: string | null;
  recoverable: boolean;
}

interface CommandErrorLike {
  code?: unknown;
  message?: unknown;
  technicalDetails?: unknown;
}

export function normalizeImportOperationError(
  error: unknown,
  sourceKind: ImportSourceKind = "unknown",
): ImportOperationError {
  const candidate = isCommandErrorLike(error) ? error : null;
  const technicalDetails = commandErrorDetail(error, candidate);
  const code =
    typeof candidate?.code === "string"
      ? candidate.code
      : inferImportErrorCode(technicalDetails);

  if (code === "sourceFileMissing" || code === "sourceDirectoryMissing") {
    return {
      code,
      cause:
        sourceKind === "volume"
          ? l(
              "An expected file is no longer available on the memory card.",
              "Oczekiwany plik nie jest już dostępny na karcie pamięci.",
            )
          : l(
              "An expected source file or folder is no longer available.",
              "Oczekiwany plik lub katalog źródłowy nie jest już dostępny.",
            ),
      nextStep:
        sourceKind === "volume"
          ? l(
              "Reconnect the original card and make sure its files have not been moved or renamed.",
              "Podłącz ponownie oryginalną kartę i upewnij się, że jej pliki nie zostały przeniesione ani przemianowane.",
            )
          : l(
              "Restore the original folder and file at the same location.",
              "Przywróć oryginalny katalog i plik w tym samym miejscu.",
            ),
      retrySafety: safeRetryMessage(),
      technicalDetails,
      recoverable: true,
    };
  }

  if (code === "sourceUnavailable" || code === "sourceRootRequired") {
    return {
      code,
      cause:
        sourceKind === "directory"
          ? l(
              "The source folder is not currently available.",
              "Katalog źródłowy jest obecnie niedostępny.",
            )
          : l(
              "The original memory card is not connected.",
              "Oryginalna karta pamięci nie jest podłączona.",
            ),
      nextStep:
        sourceKind === "directory"
          ? l(
              "Reconnect the drive or restore the folder at its original location.",
              "Podłącz ponownie dysk lub przywróć katalog w jego pierwotnym miejscu.",
            )
          : l(
              "Reconnect the card used to prepare this import.",
              "Podłącz ponownie kartę użytą do przygotowania tego importu.",
            ),
      retrySafety: safeRetryMessage(),
      technicalDetails,
      recoverable: true,
    };
  }

  if (code === "wrongSource") {
    return {
      code,
      cause: l(
        "A different memory card is connected at the expected location.",
        "W oczekiwanym miejscu jest podłączona inna karta pamięci.",
      ),
      nextStep: l(
        "Disconnect it and reconnect the original card used to prepare this import.",
        "Odłącz ją i podłącz oryginalną kartę użytą do przygotowania tego importu.",
      ),
      retrySafety: safeRetryMessage(),
      technicalDetails,
      recoverable: true,
    };
  }

  if (code === "permissionDenied") {
    return {
      code,
      cause: l(
        "The application does not have permission to read the source.",
        "Aplikacja nie ma uprawnień do odczytu źródła.",
      ),
      nextStep: l(
        "Grant read access to the source, then try this session again.",
        "Nadaj aplikacji uprawnienia do odczytu źródła, a następnie ponów tę sesję.",
      ),
      retrySafety: safeRetryMessage(),
      technicalDetails,
      recoverable: true,
    };
  }

  return {
    code,
    cause: l(
      "The import operation could not be completed.",
      "Nie udało się zakończyć operacji importu.",
    ),
    nextStep: l(
      "Check the technical details. If the source and library are available, try this session again.",
      "Sprawdź szczegóły techniczne. Jeśli źródło i biblioteka są dostępne, ponów tę sesję.",
    ),
    retrySafety: safeRetryMessage(),
    technicalDetails,
    recoverable: false,
  };
}

function safeRetryMessage() {
  return l(
    "Retrying after fixing the cause is safe; completed files will be verified and skipped.",
    "Ponowienie po usunięciu przyczyny jest bezpieczne; ukończone pliki zostaną zweryfikowane i pominięte.",
  );
}

function isCommandErrorLike(error: unknown): error is CommandErrorLike {
  return typeof error === "object" && error !== null;
}

function commandErrorDetail(
  error: unknown,
  candidate: CommandErrorLike | null,
): string | null {
  if (typeof candidate?.technicalDetails === "string")
    return candidate.technicalDetails;
  if (typeof candidate?.message === "string") return candidate.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

function inferImportErrorCode(detail: string | null): string {
  const normalized = detail?.toLocaleLowerCase() ?? "";
  if (
    normalized.includes("permission denied") ||
    normalized.includes("access denied") ||
    normalized.includes("odmowa dostępu") ||
    normalized.includes("brak uprawnień")
  )
    return "permissionDenied";
  if (
    normalized.includes("source file is unavailable") ||
    normalized.includes("brak oczekiwanego pliku") ||
    normalized.includes("no such file") ||
    normalized.includes("cannot find the file")
  )
    return "sourceFileMissing";
  if (
    normalized.includes("not connected") ||
    normalized.includes("notconnected") ||
    normalized.includes("nie jest podłączona")
  )
    return "sourceUnavailable";
  return "importFailed";
}
