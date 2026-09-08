import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSystemStatus, type SystemStatus } from "./shared/systemStatus";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { SourceScanner } from "./features/sources/SourceScanner";
import { BackgroundMonitor } from "./features/background/BackgroundMonitor";
import { BackupPanel } from "./features/backups/BackupPanel";
import {
  describeOperationalError,
  getAppStatusLabel,
  type AppStatus,
} from "./shared/appStatus";
import { ErrorNotice } from "./shared/ErrorNotice";
import { useTranslation } from "react-i18next";
import "./i18n";
import "./App.css";

type AppView = "home" | "backup" | "activity" | "settings";

function App() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [connectionState, setConnectionState] =
    useState<AppStatus>("connecting");
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [subsystems, setSubsystems] = useState({
    monitor: true,
    scanner: true,
  });
  const [activeView, setActiveView] = useState<AppView>("home");

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

  const appStatus = useMemo<AppStatus>(() => {
    if (connectionState !== "ready") return connectionState;
    return subsystems.monitor && subsystems.scanner ? "ready" : "degraded";
  }, [connectionState, subsystems]);

  const reportMonitorHealth = useCallback((healthy: boolean) => {
    setSubsystems((current) => ({ ...current, monitor: healthy }));
  }, []);
  const reportScannerHealth = useCallback((healthy: boolean) => {
    setSubsystems((current) => ({ ...current, scanner: healthy }));
  }, []);

  useEffect(() => {
    const unlisten = listen("open-settings", () => setActiveView("settings"));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ view: "home"; sourcePath: string | null }>(
      "notification-route",
      () => setActiveView("home"),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const viewCopyKey = `app.views.${activeView}`;

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
            onClick={() => setActiveView("home")}
          />
          <NavButton
            label={t("app.navigation.backup")}
            icon="backup"
            active={activeView === "backup"}
            onClick={() => setActiveView("backup")}
          />
          <NavButton
            label={t("app.navigation.activity")}
            icon="activity"
            active={activeView === "activity"}
            onClick={() => setActiveView("activity")}
          />
          <NavButton
            label={t("app.navigation.settings")}
            icon="settings"
            active={activeView === "settings"}
            onClick={() => setActiveView("settings")}
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

        <div className={`workspace-content workspace-content--${activeView}`}>
          {activeView === "settings" ? (
            <SettingsPanel />
          ) : activeView === "backup" ? (
            <BackupPanel />
          ) : activeView === "activity" ? (
            <ActivityView
              appStatus={appStatus}
              status={status}
              onHealthChange={reportMonitorHealth}
            />
          ) : (
            <>
              <BackgroundMonitor
                appStatus={appStatus}
                onHealthChange={reportMonitorHealth}
                mode="compact"
              />
              <SourceScanner
                appStatus={appStatus}
                onHealthChange={reportScannerHealth}
              />
            </>
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
}: {
  label: string;
  icon: "import" | "backup" | "activity" | "settings";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "main-nav__active" : undefined}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <NavIcon kind={icon} />
      <span>{label}</span>
    </button>
  );
}

function NavIcon({
  kind,
}: {
  kind: "import" | "backup" | "activity" | "settings";
}) {
  const paths = {
    import: (
      <>
        <path d="M12 3v10" />
        <path d="m8 9 4 4 4-4" />
        <path d="M5 17v3h14v-3" />
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
  appStatus,
  status,
  onHealthChange,
}: {
  appStatus: AppStatus;
  status: SystemStatus | null;
  onHealthChange: (healthy: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="activity-view">
      <BackgroundMonitor
        appStatus={appStatus}
        onHealthChange={onHealthChange}
      />
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
            value={t("common.ready")}
            highlight
          />
        </div>
      </section>
    </div>
  );
}

function Diagnostic({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="diagnostic">
      <span>{label}</span>
      <strong className={highlight ? "diagnostic__highlight" : undefined}>
        {value}
      </strong>
    </div>
  );
}

export default App;
