import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSystemStatus, type SystemStatus } from "./shared/systemStatus";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { SourceScanner } from "./features/sources/SourceScanner";
import { BackgroundMonitor } from "./features/background/BackgroundMonitor";
import { BackupPanel } from "./features/backups/BackupPanel";
import { PlansPanel } from "./features/plans/PlansPanel";
import { ImportHistoryPanel } from "./features/history/ImportHistoryPanel";
import { listImportEvents } from "./shared/sources";
import {
  describeOperationalError,
  getAppStatusLabel,
  type AppStatus,
} from "./shared/appStatus";
import { ErrorNotice } from "./shared/ErrorNotice";
import { useTranslation } from "react-i18next";
import { localize } from "./i18n";
import "./i18n";
import "./App.css";
import { SettingsProvider, useSettingsStore } from "./shared/SettingsStore";
import {
  getBackgroundStatus,
  type BackgroundAttention,
  type BackgroundStatus,
} from "./shared/background";
import {
  applyOperationsSnapshot,
  isActiveOperation,
  isTerminalOperation,
  listOperations,
  mergeOperationUpdate,
  operationKey,
  type OperationChangedPayload,
  type OperationDiagnostic,
  type OperationRoute,
  type OperationSummary,
} from "./shared/operations";

type AppView = "home" | "plans" | "backup" | "activity" | "settings";

type ViewRefreshRevisions = Record<AppView, number>;

const INITIAL_VIEW_REFRESH_REVISIONS: ViewRefreshRevisions = {
  home: 0,
  plans: 0,
  backup: 0,
  activity: 0,
  settings: 0,
};

function App() {
  return (
    <SettingsProvider>
      <AppContent />
    </SettingsProvider>
  );
}

function AppContent() {
  const { t } = useTranslation();
  const settingsStore = useSettingsStore();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [connectionState, setConnectionState] =
    useState<AppStatus>("connecting");
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [subsystems, setSubsystems] = useState({
    monitor: true,
    scanner: true,
  });
  const [activeView, setActiveView] = useState<AppView>("home");
  const [mountedViews, setMountedViews] = useState<ReadonlySet<AppView>>(
    () => new Set(["home"]),
  );
  const [viewRefreshRevisions, setViewRefreshRevisions] =
    useState<ViewRefreshRevisions>(INITIAL_VIEW_REFRESH_REVISIONS);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedOperationRoute, setSelectedOperationRoute] =
    useState<OperationRoute | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsDraftRevision, setSettingsDraftRevision] = useState(0);
  const [settingsTarget, setSettingsTarget] = useState<"library" | null>(null);
  const [backgroundAttention, setBackgroundAttention] = useState<
    BackgroundAttention[]
  >([]);
  const [historySyncFailure, setHistorySyncFailure] = useState<{
    error: unknown;
  } | null>(null);
  const [operationsByKey, setOperationsByKey] = useState<
    Record<string, OperationSummary>
  >({});
  const [operationDiagnostics, setOperationDiagnostics] = useState<
    OperationDiagnostic[]
  >([]);
  const [operationsError, setOperationsError] = useState<unknown>(null);
  const operationEventRevision = useRef(0);
  const operationRefreshRevision = useRef(0);
  const operationEventLog = useRef<
    Array<{ revision: number; operation: OperationSummary }>
  >([]);

  const loadSystemStatus = useCallback(async () => {
    setConnectionState("connecting");
    setConnectionError(null);
    try {
      const systemStatus = await getSystemStatus();
      if (!systemStatus) {
        throw {
          code: "backendUnavailable",
          message: "get_system_status returned null",
        };
      }
      setStatus(systemStatus);
      setConnectionState(systemStatus.backendStatus);
    } catch (error) {
      setStatus(null);
      setConnectionError(error);
      setConnectionState("error");
    }
  }, []);

  const refreshSystemStatus = useCallback(async () => {
    try {
      const systemStatus = await getSystemStatus();
      if (!systemStatus) {
        throw {
          code: "backendUnavailable",
          message: "get_system_status returned null",
        };
      }
      setStatus(systemStatus);
      setConnectionError(null);
      setConnectionState(systemStatus.backendStatus);
    } catch (error) {
      setStatus(null);
      setConnectionError(error);
      setConnectionState("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const systemStatus = await getSystemStatus();
        if (cancelled) return;
        if (!systemStatus) {
          throw {
            code: "backendUnavailable",
            message: "get_system_status returned null",
          };
        }
        setStatus(systemStatus);
        setConnectionState(systemStatus.backendStatus);
      } catch (error) {
        if (!cancelled) {
          setConnectionError(error);
          setConnectionState("error");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshOperations = useCallback(async () => {
    const refreshRevision = ++operationRefreshRevision.current;
    const eventRevisionAtStart = operationEventRevision.current;
    try {
      const snapshot = await listOperations();
      if (refreshRevision !== operationRefreshRevision.current) return;
      const eventRevisionAtEnd = operationEventRevision.current;
      const eventsDuringRequest = operationEventLog.current
        .filter(
          ({ revision }) =>
            revision > eventRevisionAtStart && revision <= eventRevisionAtEnd,
        )
        .map(({ operation }) => operation);
      setOperationsByKey((current) =>
        applyOperationsSnapshot(current, snapshot, eventsDuringRequest),
      );
      operationEventLog.current = operationEventLog.current.filter(
        ({ revision }) => revision > eventRevisionAtEnd,
      );
      setOperationDiagnostics(snapshot.diagnostics);
      setOperationsError(null);
    } catch (error) {
      if (refreshRevision !== operationRefreshRevision.current) return;
      setOperationsError(error);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const unlisten = listen<OperationChangedPayload>(
      "operations://changed",
      (event) => {
        if (!active) return;
        operationEventRevision.current += 1;
        operationEventLog.current.push({
          revision: operationEventRevision.current,
          operation: event.payload.operation,
        });
        setOperationsByKey((current) =>
          mergeOperationUpdate(current, event.payload.operation),
        );
      },
    );
    void unlisten.then(
      () => {
        if (active) void refreshOperations();
      },
      (error) => {
        if (active) {
          setOperationsError(error);
          void refreshOperations().finally(() => {
            if (active) setOperationsError(error);
          });
        }
      },
    );
    return () => {
      active = false;
      operationRefreshRevision.current += 1;
      void unlisten.then(
        (stop) => stop(),
        () => undefined,
      );
    };
  }, [refreshOperations]);

  const syncImportHistory = useCallback(async () => {
    try {
      await listImportEvents();
      setHistorySyncFailure(null);
    } catch (error) {
      console.error(
        "[Photo Importer] Import history synchronization failed.",
        error,
      );
      setHistorySyncFailure({ error });
    }
  }, []);

  const libraryPath = settingsStore?.settings?.local.libraryPath;
  const needsLibrarySetup = libraryPath === null;
  const hasConfiguredLibrary = typeof libraryPath === "string";

  useEffect(() => {
    if (libraryPath === undefined) return;
    if (libraryPath === null) {
      setHistorySyncFailure(null);
      return;
    }
    void syncImportHistory();
  }, [libraryPath, syncImportHistory]);

  useEffect(() => {
    if (activeView !== "activity") return;
    void refreshSystemStatus();
    const refreshAfterTerminalImport = (event: {
      payload: { status?: string };
    }) => {
      if (
        event.payload.status &&
        [
          "completed",
          "failed",
          "failedRecoverable",
          "paused",
          "rollbackFailed",
          "cancelled",
        ].includes(event.payload.status)
      ) {
        void refreshSystemStatus();
      }
    };
    const unlistenImport = listen<{ status?: string }>(
      "import-progress",
      refreshAfterTerminalImport,
    );
    const unlistenRollback = listen<{ status?: string }>(
      "rollback-progress",
      refreshAfterTerminalImport,
    );
    return () => {
      void unlistenImport.then((stop) => stop());
      void unlistenRollback.then((stop) => stop());
    };
  }, [activeView, refreshSystemStatus]);

  useEffect(() => {
    let active = true;
    const reloadAttention = () =>
      getBackgroundStatus()
        .then((value) => {
          if (active) setBackgroundAttention(value.attentionRequired);
        })
        .catch(() => undefined);
    void reloadAttention();
    const unlistenStatus = listen<BackgroundStatus>(
      "background-status",
      (event) => {
        if (active) setBackgroundAttention(event.payload.attentionRequired);
      },
    );
    const unlistenInvalidated = listen(
      "source-workflows-invalidated",
      reloadAttention,
    );
    const unlistenChanged = listen("source-workflow-changed", reloadAttention);
    return () => {
      active = false;
      void unlistenStatus.then((stop) => stop());
      void unlistenInvalidated.then((stop) => stop());
      void unlistenChanged.then((stop) => stop());
    };
  }, []);

  const appStatus = useMemo<AppStatus>(() => {
    if (connectionState !== "ready") return connectionState;
    return subsystems.monitor && subsystems.scanner && !historySyncFailure
      ? "ready"
      : "degraded";
  }, [connectionState, historySyncFailure, subsystems]);

  const historySyncNotice = useMemo(() => {
    if (!historySyncFailure) return null;
    const diagnostic = describeOperationalError(
      historySyncFailure.error,
      "read",
    );
    return {
      ...diagnostic,
      kind: "read" as const,
      title: t("app.historySyncError.title"),
      impact: t("app.historySyncError.impact"),
      action: t("app.historySyncError.action"),
    };
  }, [historySyncFailure, t]);

  const reportMonitorHealth = useCallback((healthy: boolean) => {
    setSubsystems((current) => ({ ...current, monitor: healthy }));
  }, []);
  const reportScannerHealth = useCallback((healthy: boolean) => {
    setSubsystems((current) => ({ ...current, scanner: healthy }));
  }, []);

  const navigateTo = useCallback(
    (view: AppView) => {
      if (view === activeView) return true;
      if (activeView === "settings" && settingsDirty) {
        if (!window.confirm(t("app.unsavedSettingsConfirmation"))) {
          return false;
        }
        // A confirmed departure means discard, so remount only the draft view.
        setSettingsDraftRevision((revision) => revision + 1);
        setSettingsDirty(false);
      }
      setViewRefreshRevisions((revisions) => ({
        ...revisions,
        [view]: revisions[view] + 1,
      }));
      setMountedViews((views) => {
        if (views.has(view)) return views;
        return new Set([...views, view]);
      });
      setActiveView(view);
      return true;
    },
    [activeView, settingsDirty, t],
  );

  const showHome = useCallback(() => {
    if (!navigateTo("home")) return;
    setSelectedPlanId(null);
    setSelectedOperationRoute(null);
  }, [navigateTo]);

  const openLibrarySettings = useCallback(() => {
    setSettingsTarget("library");
    navigateTo("settings");
  }, [navigateTo]);

  const openBackgroundWorkflow = useCallback(
    (sourceId: string) => {
      if (!navigateTo("home")) return;
      setSelectedOperationRoute(null);
      setSelectedPlanId(sourceId);
    },
    [navigateTo],
  );

  const openOperation = useCallback(
    (route: OperationRoute) => {
      const view =
        route.kind === "backup" || route.kind === "backupPlanning"
          ? "backup"
          : "home";
      if (!navigateTo(view)) return;
      setSelectedPlanId(null);
      setSelectedOperationRoute(route);
    },
    [navigateTo],
  );

  useEffect(() => {
    const unlisten = listen("open-settings", () => navigateTo("settings"));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [navigateTo]);

  useEffect(() => {
    const unlisten = listen<{ view: "home"; sourcePath: string | null }>(
      "notification-route",
      () => showHome(),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [showHome]);

  const viewCopyKey = `app.views.${activeView}`;
  const operations = useMemo(
    () =>
      Object.values(operationsByKey)
        .filter((operation) => !isTerminalOperation(operation))
        .sort(
          (left, right) =>
            Number(right.attention) - Number(left.attention) ||
            right.updatedAtUnixMs - left.updatedAtUnixMs ||
            operationKey(left).localeCompare(operationKey(right)),
        ),
    [operationsByKey],
  );
  const activeOperationCount = operations.filter(isActiveOperation).length;
  const operationAttentionCount = operations.filter(
    (operation) => operation.attention,
  ).length;

  return (
    <main className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            PI
          </div>
          <div className="sidebar-brand__copy">
            <strong>Photo Importer</strong>
            <span>{t("brand.tagline")}</span>
          </div>
        </div>

        <nav className="main-nav" aria-label={t("app.navigationLabel")}>
          <NavButton
            label={t("app.navigation.import")}
            icon="import"
            active={activeView === "home"}
            onClick={showHome}
          />
          <NavButton
            label={t("app.navigation.plans")}
            icon="plans"
            active={activeView === "plans"}
            attention={backgroundAttention.length > 0}
            onClick={() => navigateTo("plans")}
          />
          <NavButton
            label={t("app.navigation.backup")}
            icon="backup"
            active={activeView === "backup"}
            onClick={() => {
              if (navigateTo("backup")) setSelectedOperationRoute(null);
            }}
          />
          <NavButton
            label={t("app.navigation.activity")}
            icon="activity"
            active={activeView === "activity"}
            count={activeOperationCount}
            attention={
              historySyncFailure !== null ||
              operationAttentionCount > 0 ||
              operationDiagnostics.length > 0 ||
              operationsError !== null
            }
            onClick={() => navigateTo("activity")}
          />
          <NavButton
            label={t("app.navigation.settings")}
            icon="settings"
            active={activeView === "settings"}
            onClick={() => navigateTo("settings")}
          />
        </nav>

        <div className={`sidebar-health health--${appStatus}`} role="status">
          <span className="health__dot" />
          <span className="sidebar-health__copy">
            <small>{t("app.systemStatus")}</small>
            <strong>{getAppStatusLabel(appStatus)}</strong>
          </span>
        </div>
      </aside>

      <div className="app-workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">{t(`${viewCopyKey}.eyebrow`)}</p>
            <h1>{t(`${viewCopyKey}.title`)}</h1>
            <p>{t(`${viewCopyKey}.description`)}</p>
          </div>
          <span className={`health health--${appStatus}`} role="status">
            <span className="health__dot" />
            {getAppStatusLabel(appStatus)}
          </span>
        </header>

        {appStatus === "error" && (
          <div className="connection-notice">
            <ErrorNotice
              error={describeOperationalError(
                connectionError ?? { code: "backendUnavailable" },
                "backend",
              )}
              onRetry={() => void loadSystemStatus()}
              retryLabel={t("app.reconnect")}
            />
          </div>
        )}

        {historySyncNotice && (
          <div className="connection-notice">
            <ErrorNotice
              error={historySyncNotice}
              onRetry={() => void syncImportHistory()}
            />
          </div>
        )}

        <div className={`workspace-content workspace-content--${activeView}`}>
          {/*
            View-state policy (LOG-038): operation views stay mounted so live
            state is not lost; read-only views retain their cache and receive a
            refresh revision on re-entry; the settings draft is remounted only
            after the user explicitly agrees to discard it.
          */}
          <section className="persistent-home" hidden={activeView !== "home"}>
            {activeView === "home" && hasConfiguredLibrary && (
              <BackgroundMonitor
                appStatus={appStatus}
                onHealthChange={reportMonitorHealth}
                onAttentionChange={setBackgroundAttention}
                onOpenWorkflow={openBackgroundWorkflow}
                mode="compact"
              />
            )}
            {needsLibrarySetup ? (
              <section
                className="library-onboarding"
                aria-labelledby="library-onboarding-title"
              >
                <p className="section-label">
                  {t("app.libraryOnboarding.eyebrow")}
                </p>
                <h2 id="library-onboarding-title">
                  {t("app.libraryOnboarding.title")}
                </h2>
                <p>{t("app.libraryOnboarding.description")}</p>
                <button type="button" onClick={openLibrarySettings}>
                  {t("app.libraryOnboarding.action")}
                </button>
              </section>
            ) : hasConfiguredLibrary ? (
              <SourceScanner
                appStatus={appStatus}
                onHealthChange={reportScannerHealth}
                openWorkflowId={selectedPlanId}
                openOperationRoute={
                  selectedOperationRoute?.kind === "scan" ||
                  selectedOperationRoute?.kind === "import"
                    ? selectedOperationRoute
                    : null
                }
                onOpenHistory={() => {
                  setSelectedPlanId(null);
                  navigateTo("activity");
                }}
              />
            ) : null}
          </section>
          {mountedViews.has("settings") && (
            <section hidden={activeView !== "settings"}>
              <SettingsPanel
                key={settingsDraftRevision}
                onDirtyChange={setSettingsDirty}
                focusSection={settingsTarget}
              />
            </section>
          )}
          {mountedViews.has("plans") && (
            <section hidden={activeView !== "plans"}>
              <PlansPanel
                refreshRevision={viewRefreshRevisions.plans}
                onOpen={(sourceId) => {
                  setSelectedPlanId(sourceId);
                  navigateTo("home");
                }}
              />
            </section>
          )}
          {mountedViews.has("backup") && (
            <section hidden={activeView !== "backup"}>
              <BackupPanel
                openOperationRoute={
                  selectedOperationRoute?.kind === "backup" ||
                  selectedOperationRoute?.kind === "backupPlanning"
                    ? selectedOperationRoute
                    : null
                }
                onClearOperationRoute={() => setSelectedOperationRoute(null)}
              />
            </section>
          )}
          {mountedViews.has("activity") && (
            <section hidden={activeView !== "activity"}>
              <ActivityView
                active={activeView === "activity"}
                refreshRevision={viewRefreshRevisions.activity}
                appStatus={appStatus}
                status={status}
                onHealthChange={reportMonitorHealth}
                onAttentionChange={setBackgroundAttention}
                onOpenWorkflow={openBackgroundWorkflow}
                operations={operations}
                operationDiagnostics={operationDiagnostics}
                operationsError={operationsError}
                onRetryOperations={() => void refreshOperations()}
                onOpenOperation={openOperation}
              />
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function NavButton({
  label,
  icon,
  active,
  onClick,
  attention = false,
  count = 0,
}: {
  label: string;
  icon: "import" | "plans" | "backup" | "activity" | "settings";
  active: boolean;
  onClick: () => void;
  attention?: boolean;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={active ? "main-nav__active" : undefined}
      aria-current={active ? "page" : undefined}
      aria-label={
        count > 0
          ? `${label}, ${count} ${localize(
              count === 1 ? "active operation" : "active operations",
              count === 1 ? "aktywna operacja" : "aktywne operacje",
            )}`
          : label
      }
      title={label}
      onClick={onClick}
    >
      <NavIcon kind={icon} />
      <span>{label}</span>
      {count > 0 && (
        <span className="main-nav__count" aria-hidden="true">
          {count > 99 ? "99+" : count}
        </span>
      )}
      {attention && (
        <span
          className="main-nav__attention"
          title={localize("Needs attention", "Wymaga uwagi")}
          aria-label={localize("Needs attention", "Wymaga uwagi")}
        />
      )}
    </button>
  );
}

function NavIcon({
  kind,
}: {
  kind: "import" | "plans" | "backup" | "activity" | "settings";
}) {
  const paths = {
    import: (
      <>
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M5 17v3h14v-3" />
      </>
    ),
    plans: (
      <>
        <path d="M6 4h12v16H6z" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    backup: (
      <>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M8 5V3h8v2M8 10h8M8 14h5" />
      </>
    ),
    activity: (
      <>
        <path d="M4 12h3l2-5 4 10 2-5h5" />
        <circle cx="12" cy="12" r="9" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.4-2.6h-4L10 6a7 7 0 0 0-1.5 1.1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1A7 7 0 0 0 10 18l.5 2.6h4L15 18a7 7 0 0 0 1.5-1.1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
      </>
    ),
  };
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

function ActivityView({
  active,
  refreshRevision,
  appStatus,
  status,
  onHealthChange,
  onAttentionChange,
  onOpenWorkflow,
  operations,
  operationDiagnostics,
  operationsError,
  onRetryOperations,
  onOpenOperation,
}: {
  active: boolean;
  refreshRevision: number;
  appStatus: AppStatus;
  status: SystemStatus | null;
  onHealthChange: (healthy: boolean) => void;
  onAttentionChange: (attention: BackgroundAttention[]) => void;
  onOpenWorkflow: (sourceId: string) => void;
  operations: OperationSummary[];
  operationDiagnostics: OperationDiagnostic[];
  operationsError: unknown;
  onRetryOperations: () => void;
  onOpenOperation: (route: OperationRoute) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="activity-view">
      <OperationsCenter
        operations={operations}
        diagnostics={operationDiagnostics}
        loadError={operationsError}
        onRetry={onRetryOperations}
        onOpen={onOpenOperation}
      />
      <ImportHistoryPanel refreshRevision={refreshRevision} />
      {active && (
        <BackgroundMonitor
          appStatus={appStatus}
          onHealthChange={onHealthChange}
          onAttentionChange={onAttentionChange}
          onOpenWorkflow={onOpenWorkflow}
        />
      )}
      <section
        className="diagnostics-panel"
        aria-labelledby="diagnostics-title"
      >
        <div className="panel-heading">
          <div>
            <p className="section-label">{t("app.diagnostics.eyebrow")}</p>
            <h2 id="diagnostics-title">{t("app.diagnostics.title")}</h2>
          </div>
          <span>{t("app.diagnostics.description")}</span>
        </div>
        <div className="diagnostics" aria-label={t("app.diagnostics.label")}>
          <Diagnostic
            label={t("app.diagnostics.product")}
            value={status?.productName ?? "—"}
          />
          <Diagnostic
            label={t("app.diagnostics.version")}
            value={status?.appVersion ?? "—"}
          />
          <Diagnostic
            label={t("app.diagnostics.system")}
            value={
              status
                ? `${status.operatingSystem} / ${status.architecture}`
                : "—"
            }
          />
          <Diagnostic
            label={t("app.diagnostics.importEngine")}
            value={
              status
                ? t(
                    `app.diagnostics.importEngineStatus.${status.importEngineStatus}`,
                  )
                : "—"
            }
            detail={status?.importEngineLastError ?? undefined}
            status={status?.importEngineStatus}
          />
        </div>
      </section>
    </div>
  );
}

function OperationsCenter({
  operations,
  diagnostics,
  loadError,
  onRetry,
  onOpen,
}: {
  operations: OperationSummary[];
  diagnostics: OperationDiagnostic[];
  loadError: unknown;
  onRetry: () => void;
  onOpen: (route: OperationRoute) => void;
}) {
  const active = operations.filter(isActiveOperation);
  const attention = operations.filter(
    (operation) => operation.attention && !isActiveOperation(operation),
  );
  return (
    <section
      className="operations-center"
      aria-labelledby="operations-center-title"
    >
      <div className="panel-heading">
        <div>
          <p className="section-label">
            {localize("LIVE OPERATIONS", "AKTYWNE OPERACJE")}
          </p>
          <h2 id="operations-center-title">
            {localize("Operations center", "Centrum operacji")}
          </h2>
        </div>
        <span>
          {localize(
            "Scans, imports and backups in one place",
            "Skany, importy i backupy w jednym miejscu",
          )}
        </span>
      </div>

      {(loadError || diagnostics.length > 0) && (
        <div className="operations-center__diagnostics" role="alert">
          <strong>
            {localize(
              "Some operation data is unavailable",
              "Część danych o operacjach jest niedostępna",
            )}
          </strong>
          {loadError !== null && <p>{String(loadError)}</p>}
          {diagnostics.map((diagnostic) => (
            <p key={`${diagnostic.source}:${diagnostic.code}`}>
              {operationSourceLabel(diagnostic.source)}: {diagnostic.message}
            </p>
          ))}
          <button type="button" className="secondary" onClick={onRetry}>
            {localize("Refresh operations", "Odśwież operacje")}
          </button>
        </div>
      )}

      {active.length === 0 && attention.length === 0 ? (
        <p className="operations-center__empty">
          {localize(
            "No operations are currently active.",
            "Żadna operacja nie jest teraz aktywna.",
          )}
        </p>
      ) : (
        <div className="operations-center__groups">
          {active.length > 0 && (
            <OperationGroup
              title={localize("Active", "Aktywne")}
              operations={active}
              onOpen={onOpen}
            />
          )}
          {attention.length > 0 && (
            <OperationGroup
              title={localize("Needs attention", "Wymaga uwagi")}
              operations={attention}
              onOpen={onOpen}
            />
          )}
        </div>
      )}
    </section>
  );
}

function OperationGroup({
  title,
  operations,
  onOpen,
}: {
  title: string;
  operations: OperationSummary[];
  onOpen: (route: OperationRoute) => void;
}) {
  return (
    <section className="operations-center__group" aria-label={title}>
      <h3>{title}</h3>
      <div className="operations-center__list">
        {operations.map((operation) => {
          const percentage = operationPercentage(operation);
          return (
            <button
              type="button"
              className={`operation-card${operation.attention ? " operation-card--attention" : ""}`}
              key={operationKey(operation)}
              onClick={() => onOpen(operation.route)}
              aria-label={localize(
                `Open ${operation.label}`,
                `Otwórz ${operation.label}`,
              )}
            >
              <span className="operation-card__kind">
                {operationKindLabel(operation.kind)}
              </span>
              <span className="operation-card__main">
                <strong>{operation.label}</strong>
                {operation.context && <small>{operation.context}</small>}
                {operation.error && (
                  <small className="operation-card__error">
                    {operation.error}
                  </small>
                )}
              </span>
              <span className="operation-card__status">
                <strong>{operationStatusLabel(operation.status)}</strong>
                {percentage !== null && <small>{percentage}%</small>}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function operationPercentage(operation: OperationSummary) {
  const { completedItems, totalItems, completedBytes, totalBytes } =
    operation.progress;
  if (totalBytes && completedBytes !== null) {
    return Math.min(100, Math.round((completedBytes / totalBytes) * 100));
  }
  if (totalItems && completedItems >= 0) {
    return Math.min(100, Math.round((completedItems / totalItems) * 100));
  }
  return null;
}

function operationKindLabel(kind: OperationSummary["kind"]) {
  if (kind === "scan") return localize("Scan", "Skan");
  if (kind === "import") return localize("Import", "Import");
  if (kind === "backupPlanning") return localize("Backup plan", "Plan backupu");
  return localize("Backup", "Backup");
}

function operationStatusLabel(status: OperationSummary["status"]) {
  if (status === "queued") return localize("Queued", "W kolejce");
  if (status === "running") return localize("Running", "W toku");
  if (status === "paused") return localize("Paused", "Wstrzymana");
  if (status === "attention")
    return localize("Needs attention", "Wymaga uwagi");
  if (status === "completed") return localize("Completed", "Zakończona");
  return localize("Cancelled", "Anulowana");
}

function operationSourceLabel(source: OperationDiagnostic["source"]) {
  if (source === "scans") return localize("Scans", "Skany");
  if (source === "imports") return localize("Imports", "Importy");
  if (source === "backupPlanning")
    return localize("Backup planning", "Planowanie backupu");
  return localize("Backups", "Backupy");
}

function Diagnostic({
  label,
  value,
  detail,
  status,
}: {
  label: string;
  value: string;
  detail?: string;
  status?: Exclude<AppStatus, "connecting">;
}) {
  return (
    <div className="diagnostic">
      <span>{label}</span>
      <strong
        className={status ? `diagnostic__status health--${status}` : undefined}
      >
        {value}
      </strong>
      {detail && <small title={detail}>{detail}</small>}
    </div>
  );
}

export default App;
