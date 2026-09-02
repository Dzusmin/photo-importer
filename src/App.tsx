import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSystemStatus, type SystemStatus } from "./shared/systemStatus";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { SourceScanner } from "./features/sources/SourceScanner";
import { BackgroundMonitor } from "./features/background/BackgroundMonitor";
import { BackupPanel } from "./features/backups/BackupPanel";
import {
  APP_STATUS_LABELS,
  describeOperationalError,
  type AppStatus,
} from "./shared/appStatus";
import { ErrorNotice } from "./shared/ErrorNotice";
import "./App.css";

function App() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [connectionState, setConnectionState] =
    useState<AppStatus>("connecting");
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [subsystems, setSubsystems] = useState({
    monitor: true,
    scanner: true,
  });
  const [activeView, setActiveView] = useState<"home" | "backup" | "settings">(
    "home",
  );

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          PI
        </div>
        <div>
          <p className="eyebrow">PHOTO IMPORTER</p>
          <h1>Twoje zdjęcia, bezpiecznie na miejscu.</h1>
        </div>
        <span className={`health health--${appStatus}`} role="status">
          <span className="health__dot" />
          {APP_STATUS_LABELS[appStatus]}
        </span>
      </header>

      {appStatus === "error" && (
        <ErrorNotice
          error={describeOperationalError(
            connectionError ?? { code: "backendUnavailable" },
            "backend",
          )}
          onRetry={() => void loadSystemStatus()}
          retryLabel="Połącz ponownie"
        />
      )}

      <nav className="main-nav" aria-label="Główna nawigacja">
        <button
          type="button"
          className={activeView === "home" ? "main-nav__active" : undefined}
          onClick={() => setActiveView("home")}
        >
          Start
        </button>
        <button
          type="button"
          className={activeView === "backup" ? "main-nav__active" : undefined}
          onClick={() => setActiveView("backup")}
        >
          Backup
        </button>
        <button
          type="button"
          className={activeView === "settings" ? "main-nav__active" : undefined}
          onClick={() => setActiveView("settings")}
        >
          Ustawienia
        </button>
      </nav>

      {activeView === "settings" ? (
        <SettingsPanel />
      ) : activeView === "backup" ? (
        <BackupPanel />
      ) : (
        <>
          <BackgroundMonitor
            appStatus={appStatus}
            onHealthChange={reportMonitorHealth}
          />
          <SourceScanner
            appStatus={appStatus}
            onHealthChange={reportScannerHealth}
          />

          <section className="diagnostics" aria-label="Diagnostyka aplikacji">
            <Diagnostic label="Produkt" value={status?.productName ?? "—"} />
            <Diagnostic label="Wersja" value={status?.appVersion ?? "—"} />
            <Diagnostic
              label="System"
              value={
                status
                  ? `${status.operatingSystem} / ${status.architecture}`
                  : "—"
              }
            />
            <Diagnostic
              label="Silnik importu"
              value="Szkielet gotowy"
              highlight
            />
          </section>
        </>
      )}
    </main>
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
