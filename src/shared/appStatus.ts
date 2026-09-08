import { i18n } from "../i18n/instance";

export type AppStatus = "connecting" | "ready" | "degraded" | "error";

export function getAppStatusLabel(status: AppStatus): string {
  return i18n.t(`status.${status}`);
}

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
      title: i18n.t("errors.backend.title"),
      impact: i18n.t("errors.backend.impact"),
      action: i18n.t("errors.backend.action"),
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
      title: i18n.t("errors.permission.title"),
      impact: i18n.t("errors.permission.impact"),
      action: i18n.t("errors.permission.action"),
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
      title: i18n.t("errors.corruptSettings.title"),
      impact: i18n.t("errors.corruptSettings.impact"),
      action: i18n.t("errors.corruptSettings.action"),
      technicalDetails: details,
    };
  }
  if (fallbackKind === "read") {
    return {
      kind: "read",
      title: i18n.t("errors.read.title"),
      impact: i18n.t("errors.read.impact"),
      action: i18n.t("errors.read.action"),
      technicalDetails: details,
    };
  }
  if (fallbackKind === "settings") {
    return {
      kind: "settings",
      title: i18n.t("errors.settings.title"),
      impact: i18n.t("errors.settings.impact"),
      action: i18n.t("errors.settings.action"),
      technicalDetails: details,
    };
  }
  return {
    kind: "unknown",
    title: i18n.t("errors.unknown.title"),
    impact: i18n.t("errors.unknown.impact"),
    action: i18n.t("errors.unknown.action"),
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
    return JSON.stringify(error, null, 2) || i18n.t("errors.noDetails");
  } catch {
    return String(error);
  }
}
