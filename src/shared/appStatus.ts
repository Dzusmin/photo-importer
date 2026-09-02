export type AppStatus = "connecting" | "ready" | "degraded" | "error";

export const APP_STATUS_LABELS: Record<AppStatus, string> = {
  connecting: "Łączenie…",
  ready: "Gotowa",
  degraded: "Ograniczone działanie",
  error: "Brak połączenia",
};

export interface ActionableError {
  kind: "backend" | "permission" | "read" | "settings" | "unknown";
  title: string;
  impact: string;
  action: string;
  technicalDetails: string;
}

export function describeOperationalError(
  error: unknown,
  fallbackKind: ActionableError["kind"] = "unknown",
): ActionableError {
  const code = getErrorCode(error);
  const details = technicalDetails(error);
  const searchable = `${code} ${details}`.toLocaleLowerCase("pl-PL");

  if (
    code === "backendUnavailable" ||
    searchable.includes("failed to invoke") ||
    searchable.includes("ipc") ||
    searchable.includes("backend")
  ) {
    return {
      kind: "backend",
      title: "Brak połączenia z backendem",
      impact: "Monitor nośników i skanowanie są teraz niedostępne.",
      action:
        "Sprawdź, czy aplikacja uruchomiła się poprawnie, i ponów połączenie.",
      technicalDetails: details,
    };
  }
  if (
    code === "permissionDenied" ||
    searchable.includes("permission") ||
    searchable.includes("access denied") ||
    searchable.includes("odmowa dostępu") ||
    searchable.includes("uprawnie")
  ) {
    return {
      kind: "permission",
      title: "Brak uprawnień",
      impact: "Aplikacja nie może odczytać wybranego nośnika lub katalogu.",
      action:
        "Nadaj dostęp do lokalizacji albo wybierz inny katalog i spróbuj ponownie.",
      technicalDetails: details,
    };
  }
  if (
    code === "corruptedPrimary" ||
    searchable.includes("corrupt") ||
    searchable.includes("schema") ||
    searchable.includes("uszkodz")
  ) {
    return {
      kind: "settings",
      title: "Uszkodzone ustawienia",
      impact: "Nie można bezpiecznie wczytać konfiguracji aplikacji.",
      action: "Przywróć kopię ustawień lub ponów odczyt po poprawieniu pliku.",
      technicalDetails: details,
    };
  }
  if (fallbackKind === "read") {
    return {
      kind: "read",
      title: "Nie udało się odczytać źródeł",
      impact:
        "Liczba dostępnych źródeł jest nieznana; skanowanie ręczne nadal może być dostępne.",
      action: "Sprawdź podłączenie nośnika i spróbuj ponownie.",
      technicalDetails: details,
    };
  }
  if (fallbackKind === "settings") {
    return {
      kind: "settings",
      title: "Nie udało się wczytać ustawień",
      impact: "Opcje importu nie są dostępne.",
      action:
        "Spróbuj ponownie lub przywróć kopię ustawień, jeśli jest dostępna.",
      technicalDetails: details,
    };
  }
  return {
    kind: "unknown",
    title: "Nieznany błąd",
    impact: "Nie udało się zakończyć operacji.",
    action:
      "Spróbuj ponownie. Jeśli problem wróci, skopiuj szczegóły techniczne.",
    technicalDetails: details,
  };
}

function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

function technicalDetails(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2) || "Brak dodatkowych informacji.";
  } catch {
    return String(error);
  }
}
